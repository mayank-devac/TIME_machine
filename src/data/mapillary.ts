import type { CuratedSpot, LatLng, NearbyPlace, Pano, PanoSource } from '../contracts.js';
import { config } from '../config.js';
import spotsJson from './spots.json';

const GRAPH = 'https://graph.mapillary.com';
const FIELDS = [
  'id',
  'captured_at',
  'computed_compass_angle',
  'compass_angle',
  'computed_geometry',
  'geometry',
  'is_pano',
  'sequence',
  'thumb_2048_url',
  'thumb_original_url',
  'width',
  'height',
  'creator',
].join(',');

/** Mapillary started in 2014; the year-band fallback never looks earlier. */
const FIRST_YEAR = 2014;
const SEARCH_LIMIT = 100;
/** `panosNear` asks for half the generic search limit; saturation still keys off SEARCH_LIMIT. */
const NEAR_LIMIT = 50;
const BBOX_LIMIT = 2000;
/** Half-width of the places box in degrees (about 500 m) and the grid the centre snaps to. */
const PLACES_HALF_DEG = 0.0045;
const PLACES_GRID_DEG = 0.003;
const MAX_PLACES = 15;
/** A place also absorbs panoramas up to this many times the offset away, if they add a new year. */
const MERGE_REACH = 3;
/** Places search tile edge in degrees of latitude (about 250 m). Tiles sit on a fixed global grid. */
const PLACES_TILE_DEG = 0.00225;
/** A centre tile with fewer raw images than this is "quiet": the whole box fits in one request. */
const QUIET_RAW = 100;
/** Thrown when the whole box came back saturated, so the tile walk must take over. */
class SaturatedError extends Error {}

/** "quiet" areas get one whole-box request; everything else walks tiles until the list is full. */
type Density = 'quiet' | 'normal';

/** Classify an area from how many raw images its centre tile returned. */
export function densityOf(raw: number): Density {
  return raw < QUIET_RAW ? 'quiet' : 'normal';
}

interface PlacesTile {
  key: string;
  bbox: string;
  /** Distance from the search centre to the tile centre, metres. */
  dist: number;
}

/**
 * The fixed-grid tiles covering a box around `centre`, nearest first. Grid alignment is global,
 * so a small pan produces the same tile keys (and reuses their cached results).
 */
export function placesTiles(centre: LatLng, halfDeg: number = PLACES_HALF_DEG, tileDeg: number = PLACES_TILE_DEG): PlacesTile[] {
  const out: PlacesTile[] = [];
  const row0 = Math.floor((centre.lat - halfDeg) / tileDeg);
  const row1 = Math.floor((centre.lat + halfDeg) / tileDeg);
  for (let r = row0; r <= row1; r++) {
    const s = r * tileDeg;
    const n = s + tileDeg;
    const midLat = s + tileDeg / 2;
    const lngDeg = tileDeg / Math.max(0.2, Math.cos((midLat * Math.PI) / 180));
    const halfLng = halfDeg / Math.max(0.2, Math.cos((centre.lat * Math.PI) / 180));
    const col0 = Math.floor((centre.lng - halfLng) / lngDeg);
    const col1 = Math.floor((centre.lng + halfLng) / lngDeg);
    for (let c = col0; c <= col1; c++) {
      const w = c * lngDeg;
      const e = w + lngDeg;
      out.push({
        key: `tile:${r},${c}`,
        bbox: [w, s, e, n].map((v) => v.toFixed(6)).join(','),
        dist: distanceM(centre, { lat: midLat, lng: w + lngDeg / 2 }),
      });
    }
  }
  return out.sort((a, b) => a.dist - b.dist);
}

export interface MapillaryOptions {
  token: string;
  fetchImpl?: typeof fetch;
  minIntervalMs?: number;
  /** Wait before the single retry after a throttle error. */
  retryDelayMs?: number;
  maxOffsetM?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface RawImage {
  id?: string | number;
  captured_at?: number;
  computed_compass_angle?: number;
  compass_angle?: number;
  computed_geometry?: { coordinates?: number[] };
  geometry?: { coordinates?: number[] };
  is_pano?: boolean;
  sequence?: string;
  thumb_2048_url?: string;
  thumb_original_url?: string;
  width?: number;
  height?: number;
  creator?: { username?: string; id?: string };
}

class ThrottledError extends Error {}
/** Mapillary code 1 (HTTP 500): the box holds too many images to answer. Split it and retry. */
class TooMuchDataError extends Error {}
const MAX_SPLIT_DEPTH = 3;

export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Convert a raw Graph API image to a `Pano`, or null if it cannot fill a sphere. */
export function toPano(raw: RawImage): Pano | null {
  if (raw.id === undefined || raw.is_pano === false) return null;
  const coords = raw.computed_geometry?.coordinates ?? raw.geometry?.coordinates;
  if (!coords || coords.length < 2 || typeof raw.captured_at !== 'number') return null;
  const imageUrl = raw.thumb_original_url ?? raw.thumb_2048_url;
  if (!imageUrl) return null;
  return {
    id: String(raw.id),
    lat: coords[1],
    lng: coords[0],
    capturedAt: raw.captured_at,
    heading: raw.computed_compass_angle ?? raw.compass_angle ?? 0,
    imageUrl,
    previewUrl: raw.thumb_2048_url,
    width: raw.width ?? 0,
    height: raw.height ?? 0,
    creator: raw.creator?.username ?? 'unknown',
    sequenceId: raw.sequence ?? '',
  };
}

const yearOfMs = (ms: number): number => new Date(ms).getUTCFullYear();
const isoStart = (y: number): string => `${y}-01-01T00:00:00Z`;
const isoEnd = (y: number): string => `${y}-12-31T23:59:59Z`;

export class MapillaryClient implements PanoSource {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly minInterval: number;
  private readonly retryDelay: number;
  private readonly maxOffset: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  /** Serialises request starts so they are at least `minInterval` apart. */
  private gate: Promise<void> = Promise.resolve();
  private lastStart = -Infinity;
  /** Remembered density per centre tile, so a revisit picks the right request size at once. */
  private readonly density = new Map<string, Density>();
  /** Boxes Mapillary refused as too dense; they are split without asking again. */
  private readonly denseBoxes = new Set<string>();
  /** Every panorama the Nearby scan has seen, by id; `yearsAt` merges these in. */
  private readonly placesSeen = new Map<string, Pano>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(opts: MapillaryOptions) {
    this.token = opts.token;
    this.fetchImpl = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.minInterval = opts.minIntervalMs ?? config.minRequestIntervalMs;
    this.retryDelay = opts.retryDelayMs ?? 1500;
    this.maxOffset = opts.maxOffsetM ?? config.maxYearOffsetMetres;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
  }

  // ------------------------------------------------------------------ transport

  private async waitTurn(): Promise<void> {
    const turn = this.gate.then(async () => {
      const wait = this.lastStart + this.minInterval - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = this.now();
    });
    this.gate = turn.catch(() => undefined);
    return turn;
  }

  /**
   * One request with a timeout. A network failure or timeout is retried (`config.network`),
   * because headset Wi-Fi drops packets; an HTTP answer is returned as is.
   */
  private async send(url: string): Promise<Response> {
    const { apiTimeoutMs, retries, retryDelayMs } = config.network;
    let lastErr: unknown;
    for (let i = 0; i <= retries; i++) {
      if (i > 0) await this.sleep(retryDelayMs * i);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), apiTimeoutMs);
      try {
        return await this.fetchImpl(url, { signal: ctl.signal });
      } catch (err) {
        lastErr = ctl.signal.aborted
          ? new Error(`Mapillary did not answer within ${Math.round(apiTimeoutMs / 1000)} s (slow network?)`)
          : err;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  private async attempt(url: string): Promise<unknown> {
    await this.waitTurn();
    const res = await this.send(url);
    type Body = { error?: { code?: number; message?: string } } | null;
    const body: Body = await (res.json() as Promise<Body>).catch(() => null);
    if (body?.error) {
      if (body.error.code === 4) throw new ThrottledError('Mapillary rate limit hit (code 4)');
      if (body.error.code === 1 && /reduce the amount/i.test(body.error.message ?? '')) {
        throw new TooMuchDataError(body.error.message);
      }
      throw new Error(`Mapillary error ${body.error.code ?? res.status}: ${body.error.message ?? 'unknown'}`);
    }
    if (res.status === 429) throw new ThrottledError('Mapillary rate limit hit (HTTP 429)');
    if (!res.ok) throw new Error(`Mapillary request failed: HTTP ${res.status}`);
    return body;
  }

  /** Throttled, de-duplicated GET. Retries once after a throttle error. */
  private get<T>(path: string, params: Record<string, string | number>): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
    const keyUrl = `${GRAPH}${path}?${q.toString()}`;
    const existing = this.inflight.get(keyUrl);
    if (existing) return existing as Promise<T>;

    q.set('access_token', this.token);
    const url = `${GRAPH}${path}?${q.toString()}`;
    const p = (async () => {
      try {
        return (await this.attempt(url)) as T;
      } catch (err) {
        if (!(err instanceof ThrottledError)) throw err;
        await this.sleep(this.retryDelay);
        try {
          return (await this.attempt(url)) as T;
        } catch (err2) {
          if (err2 instanceof ThrottledError) {
            throw new Error('Mapillary is rate limiting this app; try again in a minute.');
          }
          throw err2;
        }
      }
    })().finally(() => this.inflight.delete(keyUrl));
    this.inflight.set(keyUrl, p);
    return p;
  }

  private cached<T>(key: string, make: () => Promise<T>): Promise<T> {
    let p = this.cache.get(key) as Promise<T> | undefined;
    if (!p) {
      p = make();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key)); // never cache failures
    }
    return p;
  }

  private async search(params: Record<string, string | number>): Promise<{ panos: Pano[]; raw: number }> {
    const res = await this.get<{ data?: RawImage[] }>('/images', { fields: FIELDS, ...params });
    const data = res.data ?? [];
    const panos: Pano[] = [];
    for (const r of data) {
      const p = toPano(r);
      if (p) panos.push(p);
    }
    return { panos, raw: data.length };
  }

  /**
   * Search a bbox ("w,s,e,n"). If Mapillary says it is too dense, search the four quadrants
   * instead (up to MAX_SPLIT_DEPTH levels) and merge, de-duplicating by id.
   */
  private async searchBox(
    bbox: string,
    params: Record<string, string | number>,
    depth = 0,
  ): Promise<{ panos: Pano[]; raw: number }> {
    // A box that already came back "too much data" goes straight to its quadrants, so the
    // browser logs that 500 once per box instead of on every revisit.
    const denseKey = `${bbox}|${JSON.stringify(params)}`;
    let splitErr: unknown = new TooMuchDataError('known dense box');
    if (!(this.denseBoxes.has(denseKey) && depth < MAX_SPLIT_DEPTH)) {
      try {
        return await this.search({ ...params, bbox });
      } catch (err) {
        // In the browser the slow busy-box 500 often surfaces as a bare network TypeError
        // ("Failed to fetch") instead of a readable code-1 body, so split on that too.
        const tooDense = err instanceof TooMuchDataError || err instanceof TypeError;
        if (!tooDense || depth >= MAX_SPLIT_DEPTH) throw err;
        splitErr = err;
        if (err instanceof TooMuchDataError) this.denseBoxes.add(denseKey);
      }
    }
    {
      const err = splitErr;
      const [w, s, e, n] = bbox.split(',').map(Number);
      const mx = (w + e) / 2;
      const my = (s + n) / 2;
      const quads = [
        [w, s, mx, my],
        [mx, s, e, my],
        [w, my, mx, n],
        [mx, my, e, n],
      ].map((q) => q.map((v) => v.toFixed(6)).join(','));
      const seen = new Map<string, Pano>();
      let raw = 0;
      let failures = 0;
      let lastErr: unknown = err;
      // Quadrants go out together (the gate still spaces their starts) instead of one by one.
      const results = await Promise.allSettled(quads.map((q) => this.searchBox(q, params, depth + 1)));
      for (const res of results) {
        if (res.status === 'fulfilled') {
          raw = Math.max(raw, res.value.raw); // saturated only if one quadrant alone hit the limit
          for (const p of res.value.panos) seen.set(p.id, p);
        } else {
          // A throttle must stop everything; any other failed quadrant just loses its own panos.
          if (res.reason instanceof ThrottledError) throw res.reason;
          failures++;
          lastErr = res.reason;
        }
      }
      if (failures === quads.length) throw lastErr;
      return { panos: [...seen.values()], raw };
    }
  }

  // ------------------------------------------------------------------ PanoSource

  panosNear(lat: number, lng: number, radiusM: number = config.searchRadiusM): Promise<Pano[]> {
    const radius = Math.max(1, Math.min(config.searchRadiusM, radiusM));
    const key = `near:${lat.toFixed(5)},${lng.toFixed(5)},${radius}`;
    return this.cached(key, async () => {
      const { panos } = await this.search({ lat, lng, radius, limit: NEAR_LIMIT });
      return sortByDistance(panos, { lat, lng });
    });
  }

  yearsAt(lat: number, lng: number): Promise<Map<number, Pano>> {
    const key = `years:${lat.toFixed(5)},${lng.toFixed(5)}`;
    return this.cached(key, async () => {
      const here = { lat, lng };
      const radius = Math.min(config.searchRadiusM, Math.ceil(this.maxOffset));
      // Panoramas only: flat photos would fill the cap and push real pano years out.
      const first = await this.search({ lat, lng, radius, is_pano: 'true', limit: SEARCH_LIMIT });
      let all = first.panos;
      if (first.raw >= SEARCH_LIMIT) {
        // Saturated: paging does not work, so ask once per year band.
        const thisYear = new Date().getUTCFullYear();
        const years: number[] = [];
        for (let y = FIRST_YEAR; y <= thisYear; y++) years.push(y);
        const results = await Promise.all(
          years.map((y) =>
            this.search({
              lat,
              lng,
              radius,
              is_pano: 'true',
              limit: SEARCH_LIMIT,
              start_captured_at: isoStart(y),
              end_captured_at: isoEnd(y),
            }),
          ),
        );
        all = results.flatMap((r) => r.panos);
      }
      // Also count panoramas the Nearby scan already found, so a year that list showed
      // is always offered here too.
      return nearestPerYear([...all, ...this.placesSeen.values()], here, this.maxOffset);
    });
  }

  placesNear(lat: number, lng: number, onPartial?: (places: NearbyPlace[]) => void): Promise<NearbyPlace[]> {
    const cLat = Math.round(lat / PLACES_GRID_DEG) * PLACES_GRID_DEG;
    const cLng = Math.round(lng / PLACES_GRID_DEG) * PLACES_GRID_DEG;
    const key = `places:${cLat.toFixed(4)},${cLng.toFixed(4)}`;
    return this.cached(key, async () => {
      // Grow when quiet, stop early when busy: start with the nearest small tile and let its
      // answer decide whether one whole-box request or more nearby tiles come next.
      const here = { lat, lng };
      const tiles = placesTiles({ lat: cLat, lng: cLng });
      const seen = new Map<string, Pano>();
      let sentCount = 0;
      const add = (panos: Pano[]): void =>
        panos.forEach((p) => {
          seen.set(p.id, p);
          this.placesSeen.set(p.id, p);
        });
      // Show what is known after each tile, so the list fills in while the walk continues.
      const emit = (): void => {
        if (!onPartial) return;
        const found = clusterPlaces([...seen.values()], here, this.maxOffset, MAX_PLACES);
        if (found.length > 0 && found.length !== sentCount) {
          sentCount = found.length;
          onPartial(found);
        }
      };
      const enough = (): boolean => clusterPlaces([...seen.values()], here, this.maxOffset, MAX_PLACES).length >= MAX_PLACES;

      const known = this.density.get(tiles[0].key);
      if (known === 'quiet') {
        try {
          add((await this.wholeBox(cLat, cLng)).panos);
          return clusterPlaces([...seen.values()], here, this.maxOffset, MAX_PLACES);
        } catch (err) {
          if (err instanceof ThrottledError) throw err;
          this.density.delete(tiles[0].key); // fall through to the tile walk
        }
      }

      let failures = 0;
      let lastErr: unknown = null;
      for (let i = 0; i < tiles.length; i++) {
        let raw: number;
        try {
          const r = await this.placesTile(tiles[i]);
          add(r.panos);
          raw = r.raw;
          emit();
        } catch (err) {
          if (err instanceof ThrottledError) throw err;
          failures++;
          lastErr = err;
          continue;
        }
        if (i === 0) {
          const d = densityOf(raw);
          this.density.set(tiles[0].key, d);
          if (d === 'quiet') {
            try {
              add((await this.wholeBox(cLat, cLng)).panos);
              break;
            } catch (err) {
              if (err instanceof ThrottledError) throw err;
              // Whole box failed after all: keep walking tiles.
            }
          }
        }
        if (enough()) break;
      }
      if (failures === tiles.length) throw lastErr;
      return clusterPlaces([...seen.values()], here, this.maxOffset, MAX_PLACES);
    });
  }

  /** The whole places box (about 1 km) around a snapped centre, in one request where possible. */
  private async wholeBox(cLat: number, cLng: number): Promise<{ panos: Pano[]; raw: number }> {
    const dLng = PLACES_HALF_DEG / Math.max(0.2, Math.cos((cLat * Math.PI) / 180));
    const bbox = [cLng - dLng, cLat - PLACES_HALF_DEG, cLng + dLng, cLat + PLACES_HALF_DEG]
      .map((n) => n.toFixed(6))
      .join(',');
    const r = await this.searchBox(bbox, { is_pano: 'true', limit: BBOX_LIMIT });
    // A quiet centre tile can still sit in a box that hits the cap; a capped answer may miss
    // years, so let the tile walk (which has a per-year fallback) do the work instead.
    if (r.raw >= BBOX_LIMIT) throw new SaturatedError('places box saturated');
    return r;
  }

  /**
   * One small places tile, cached by its grid key. A saturated tile gets one request per year
   * so every year stays represented (rare at this size).
   */
  private placesTile(tile: PlacesTile): Promise<{ panos: Pano[]; raw: number }> {
    return this.cached(tile.key, async () => {
      const base = { is_pano: 'true', limit: BBOX_LIMIT };
      const first = await this.searchBox(tile.bbox, base);
      if (first.raw < BBOX_LIMIT) return first;
      const thisYear = new Date().getUTCFullYear();
      const bands: Pano[] = [];
      let yearsOk = 0;
      let lastErr: unknown = null;
      const years: number[] = [];
      for (let y = FIRST_YEAR; y <= thisYear; y++) years.push(y);
      // All year bands in flight at once; the gate still spaces their starts.
      const results = await Promise.allSettled(
        years.map((y) => this.searchBox(tile.bbox, { ...base, start_captured_at: isoStart(y), end_captured_at: isoEnd(y) })),
      );
      for (const res of results) {
        if (res.status === 'fulfilled') {
          bands.push(...res.value.panos);
          yearsOk++;
        } else {
          if (res.reason instanceof ThrottledError) throw res.reason;
          lastErr = res.reason;
        }
      }
      // Every year failed: fail the tile (not cached) rather than cache an empty success.
      if (yearsOk === 0) throw lastErr;
      return { panos: bands, raw: first.raw };
    });
  }

  neighbours(pano: Pano): Promise<Pano[]> {
    const key = `nb:${pano.id}`;
    return this.cached(key, async () => {
      const year = yearOfMs(pano.capturedAt);
      const dLat = 0.0008; // about 90 m
      const dLng = dLat / Math.max(0.2, Math.cos((pano.lat * Math.PI) / 180));
      const { panos } = await this.search({
        bbox: [pano.lng - dLng, pano.lat - dLat, pano.lng + dLng, pano.lat + dLat]
          .map((n) => n.toFixed(6))
          .join(','),
        is_pano: 'true',
        start_captured_at: isoStart(year),
        end_captured_at: isoEnd(year),
        limit: SEARCH_LIMIT,
      });
      const sameYear = panos.filter((p) => p.id !== pano.id && yearOfMs(p.capturedAt) === year);
      const sameSeq = pano.sequenceId ? sameYear.filter((p) => p.sequenceId === pano.sequenceId) : [];
      return sortByDistance(sameSeq.length > 0 ? sameSeq : sameYear, pano);
    });
  }

  resolve(id: string): Promise<Pano> {
    return this.cached(`id:${id}`, async () => {
      const raw = await this.get<RawImage>(`/${encodeURIComponent(id)}`, { fields: FIELDS });
      const pano = toPano(raw);
      if (!pano) throw new Error(`Mapillary image ${id} is not a usable panorama`);
      return pano;
    });
  }

  spots(): CuratedSpot[] {
    return spotsJson as CuratedSpot[];
  }
}

function sortByDistance(panos: Pano[], to: LatLng): Pano[] {
  return panos
    .map((p) => ({ p, d: distanceM(p, to) }))
    .sort((a, b) => a.d - b.d)
    .map((x) => x.p);
}

/** Group by capture year; keep the nearest per year; drop years whose nearest is too far. */
export function nearestPerYear(panos: Pano[], at: LatLng, maxOffsetM: number): Map<number, Pano> {
  const best = new Map<number, { p: Pano; d: number }>();
  for (const p of panos) {
    const d = distanceM(p, at);
    if (d > maxOffsetM) continue;
    const y = yearOfMs(p.capturedAt);
    const cur = best.get(y);
    if (!cur || d < cur.d) best.set(y, { p, d });
  }
  const out = new Map<number, Pano>();
  for (const y of [...best.keys()].sort((a, b) => a - b)) out.set(y, best.get(y)!.p);
  return out;
}

/**
 * Group panoramas into places: a place is a seed (newest panorama first) plus every panorama
 * within `maxOffsetM` of it. A place's years are exactly the years with a panorama within
 * `maxOffsetM` of its seed — what `yearsAt` finds when the seed is opened — so the list never
 * promises a year the time machine cannot show. Keeps places with 2+ years; a place within
 * `MERGE_REACH` offsets of a kept one (another lane of the same street) is dropped as a
 * duplicate. Nearest to `centre` first.
 */
export function clusterPlaces(panos: Pano[], centre: LatLng, maxOffsetM: number, limit: number): NearbyPlace[] {
  const newestFirst = [...panos].sort((a, b) => b.capturedAt - a.capturedAt);
  const seeds: Pano[] = [];
  for (const p of newestFirst) {
    if (!seeds.some((s) => distanceM(s, p) <= maxOffsetM)) seeds.push(p);
  }
  const kept: { seed: Pano; years: number[] }[] = [];
  for (const seed of seeds) {
    const years = [...nearestPerYear(panos, seed, maxOffsetM).keys()];
    if (years.length < 2) continue;
    if (kept.some((k) => distanceM(k.seed, seed) <= maxOffsetM * MERGE_REACH)) continue;
    kept.push({ seed, years });
  }
  return kept
    .sort((a, b) => distanceM(a.seed, centre) - distanceM(b.seed, centre) || b.years.length - a.years.length)
    .slice(0, limit)
    .map((c) => ({ lat: c.seed.lat, lng: c.seed.lng, panoId: c.seed.id, years: c.years }));
}
