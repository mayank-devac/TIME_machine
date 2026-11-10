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
const BBOX_LIMIT = 2000;
/** Half-width of the places box in degrees (about 500 m) and the grid the centre snaps to. */
const PLACES_HALF_DEG = 0.0045;
const PLACES_GRID_DEG = 0.003;
const MAX_PLACES = 30;

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

  private async attempt(url: string): Promise<unknown> {
    await this.waitTurn();
    const res = await this.fetchImpl(url);
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
    try {
      return await this.search({ ...params, bbox });
    } catch (err) {
      // In the browser the slow busy-box 500 often surfaces as a bare network TypeError
      // ("Failed to fetch") instead of a readable code-1 body, so split on that too.
      const tooDense = err instanceof TooMuchDataError || err instanceof TypeError;
      if (!tooDense || depth >= MAX_SPLIT_DEPTH) throw err;
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
      for (const q of quads) {
        try {
          const r = await this.searchBox(q, params, depth + 1);
          raw = Math.max(raw, r.raw); // saturated only if one quadrant alone hit the limit
          for (const p of r.panos) seen.set(p.id, p);
        } catch (qErr) {
          // A throttle must stop everything; any other failed quadrant just loses its own panos.
          if (qErr instanceof ThrottledError) throw qErr;
          failures++;
          lastErr = qErr;
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
      const { panos } = await this.search({ lat, lng, radius, limit: SEARCH_LIMIT });
      return sortByDistance(panos, { lat, lng });
    });
  }

  yearsAt(lat: number, lng: number): Promise<Map<number, Pano>> {
    const key = `years:${lat.toFixed(5)},${lng.toFixed(5)}`;
    return this.cached(key, async () => {
      const here = { lat, lng };
      const radius = Math.min(config.searchRadiusM, Math.ceil(this.maxOffset));
      const first = await this.search({ lat, lng, radius, limit: SEARCH_LIMIT });
      let all = first.panos;
      if (first.raw >= SEARCH_LIMIT) {
        // Saturated: paging does not work, so ask once per year band.
        const thisYear = new Date().getUTCFullYear();
        const bands: Pano[] = [];
        for (let y = FIRST_YEAR; y <= thisYear; y++) {
          const r = await this.search({
            lat,
            lng,
            radius,
            limit: SEARCH_LIMIT,
            start_captured_at: isoStart(y),
            end_captured_at: isoEnd(y),
          });
          bands.push(...r.panos);
        }
        all = bands;
      }
      return nearestPerYear(all, here, this.maxOffset);
    });
  }

  placesNear(lat: number, lng: number): Promise<NearbyPlace[]> {
    const cLat = Math.round(lat / PLACES_GRID_DEG) * PLACES_GRID_DEG;
    const cLng = Math.round(lng / PLACES_GRID_DEG) * PLACES_GRID_DEG;
    const key = `places:${cLat.toFixed(4)},${cLng.toFixed(4)}`;
    return this.cached(key, async () => {
      const dLng = PLACES_HALF_DEG / Math.max(0.2, Math.cos((cLat * Math.PI) / 180));
      const bbox = [cLng - dLng, cLat - PLACES_HALF_DEG, cLng + dLng, cLat + PLACES_HALF_DEG]
        .map((n) => n.toFixed(6))
        .join(',');
      const base = { is_pano: 'true', limit: BBOX_LIMIT };
      const first = await this.searchBox(bbox, base);
      let all = first.panos;
      if (first.raw >= BBOX_LIMIT) {
        // Saturated: one request per year band so every year is represented.
        const thisYear = new Date().getUTCFullYear();
        const bands: Pano[] = [];
        for (let y = FIRST_YEAR; y <= thisYear; y++) {
          try {
            const r = await this.searchBox(bbox, {
              ...base,
              start_captured_at: isoStart(y),
              end_captured_at: isoEnd(y),
            });
            bands.push(...r.panos);
          } catch (err) {
            // One bad year must not lose the others (Mapillary's busy-box error is flaky).
            if (err instanceof ThrottledError) throw err;
          }
        }
        all = bands;
      }
      return clusterPlaces(all, { lat, lng }, this.maxOffset, MAX_PLACES);
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
 * within `maxOffsetM` of it. Keeps places with 2+ distinct capture years, nearest to `centre` first.
 */
export function clusterPlaces(panos: Pano[], centre: LatLng, maxOffsetM: number, limit: number): NearbyPlace[] {
  const newestFirst = [...panos].sort((a, b) => b.capturedAt - a.capturedAt);
  const clusters: { seed: Pano; years: Set<number> }[] = [];
  for (const p of newestFirst) {
    const home = clusters.find((c) => distanceM(c.seed, p) <= maxOffsetM);
    if (home) home.years.add(yearOfMs(p.capturedAt));
    else clusters.push({ seed: p, years: new Set([yearOfMs(p.capturedAt)]) });
  }
  return clusters
    .filter((c) => c.years.size >= 2)
    .sort((a, b) => distanceM(a.seed, centre) - distanceM(b.seed, centre) || b.years.size - a.years.size)
    .slice(0, limit)
    .map((c) => ({ lat: c.seed.lat, lng: c.seed.lng, panoId: c.seed.id, years: [...c.years].sort((x, y) => x - y) }));
}
