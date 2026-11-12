/**
 * Place search with Photon (komoot's free, keyless, CORS-open geocoder on OpenStreetMap data).
 * Fair use: debounce typing, at most one request in flight, ask for a few results.
 */

export const PHOTON_URL = 'https://photon.komoot.io/api/';
export const SEARCH_LIMIT = 5;
export const SEARCH_DEBOUNCE_MS = 350;
export const SEARCH_MIN_CHARS = 3;

export interface PlaceResult {
  label: string;
  lat: number;
  lng: number;
}

type Props = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** "Times Square, Manhattan, New York, United States" without repeats. */
export function labelOf(props: Props): string {
  const street = str(props.street);
  const house = str(props.housenumber);
  const parts = [
    str(props.name) ?? (street ? [street, house].filter(Boolean).join(' ') : undefined),
    str(props.district),
    str(props.city),
    str(props.state),
    str(props.country),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (!p || seen.has(p.toLowerCase())) continue;
    seen.add(p.toLowerCase());
    out.push(p);
  }
  return out.join(', ') || 'Unnamed place';
}

/** Parse a Photon GeoJSON FeatureCollection. Ignores anything malformed. */
export function parsePhoton(json: unknown): PlaceResult[] {
  const features = (json as { features?: unknown })?.features;
  if (!Array.isArray(features)) return [];
  const out: PlaceResult[] = [];
  for (const f of features) {
    const coords = (f as { geometry?: { coordinates?: unknown } })?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const [lng, lat] = coords as unknown[];
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    out.push({ label: labelOf(((f as { properties?: Props }).properties ?? {}) as Props), lat, lng });
  }
  return out;
}

export function photonUrl(query: string, limit = SEARCH_LIMIT): string {
  return `${PHOTON_URL}?q=${encodeURIComponent(query.trim())}&limit=${limit}`;
}

/**
 * Nominatim (OpenStreetMap's own free, keyless, CORS-open geocoder). Usually answers in well
 * under a second where Photon can take 8-12 s. Its usage policy allows at most one request a
 * second and forbids autocomplete, so it is only used for explicit searches (Enter, the SEARCH
 * key, a finished voice phrase), never per keystroke.
 */
export const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
export const NOMINATIM_GAP_MS = 1000;
/** Give up on Nominatim after this long and ask Photon instead. */
export const NOMINATIM_TIMEOUT_MS = 4000;

export function nominatimUrl(query: string, limit = SEARCH_LIMIT): string {
  return `${NOMINATIM_URL}?q=${encodeURIComponent(query.trim())}&format=jsonv2&addressdetails=1&limit=${limit}`;
}

/** Parse a Nominatim jsonv2 array into the same shape as Photon results. */
export function parseNominatim(json: unknown): PlaceResult[] {
  if (!Array.isArray(json)) return [];
  const out: PlaceResult[] = [];
  for (const item of json) {
    const r = item as { lat?: unknown; lon?: unknown; name?: unknown; display_name?: unknown; address?: Props };
    const lat = typeof r.lat === 'string' ? Number(r.lat) : r.lat;
    const lng = typeof r.lon === 'string' ? Number(r.lon) : r.lon;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    const a = r.address ?? {};
    const label = labelOf({
      name: r.name,
      street: a.road,
      housenumber: a.house_number,
      district: a.suburb ?? a.city_district ?? a.borough,
      city: a.city ?? a.town ?? a.village ?? a.municipality,
      state: a.state,
      country: a.country,
    });
    out.push({ label: label === 'Unnamed place' ? (str(r.display_name) ?? label) : label, lat, lng });
  }
  return out;
}

type SearchOpts = { fetchFn?: typeof fetch; signal?: AbortSignal; limit?: number };

async function searchPhoton(query: string, opts: SearchOpts): Promise<PlaceResult[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const resp = await fetchFn(photonUrl(query, opts.limit), { signal: opts.signal });
  if (!resp.ok) throw new Error(`Place search failed (HTTP ${resp.status}).`);
  return parsePhoton(await resp.json());
}

let nominatimNext = 0;
const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });

async function searchNominatim(query: string, opts: SearchOpts & { timeoutMs?: number }): Promise<PlaceResult[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  // One request a second at most, across the whole app.
  const now = Date.now();
  const wait = nominatimNext - now;
  nominatimNext = Math.max(now, nominatimNext) + NOMINATIM_GAP_MS;
  await sleep(wait, opts.signal);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), opts.timeoutMs ?? NOMINATIM_TIMEOUT_MS);
  const onAbort = (): void => timeout.abort();
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const resp = await fetchFn(nominatimUrl(query, opts.limit), {
      signal: timeout.signal,
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) throw new Error(`Place search failed (HTTP ${resp.status}).`);
    return parseNominatim(await resp.json());
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Recent answers by query, so a repeated search (or Enter after typing) is instant. */
const CACHE_MAX = 50;
const cache = new Map<string, PlaceResult[]>();
const cacheKey = (q: string, limit: number): string => `${limit}|${q.trim().toLowerCase().replace(/\s+/g, ' ')}`;
function remember(key: string, results: PlaceResult[]): void {
  cache.delete(key);
  cache.set(key, results);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
}

/** Test hook: forget cached answers and the Nominatim pacing. */
export function resetPlaceSearch(): void {
  cache.clear();
  nominatimNext = 0;
}

/**
 * Look a place up. `explicit` (the default) means the user asked for this search outright, so
 * the fast Nominatim is tried first and Photon is the fallback. `explicit: false` is for
 * as-you-type suggestions and only ever asks Photon.
 */
export async function searchPlaces(
  query: string,
  opts: SearchOpts & { explicit?: boolean; timeoutMs?: number } = {},
): Promise<PlaceResult[]> {
  const limit = opts.limit ?? SEARCH_LIMIT;
  const key = cacheKey(query, limit);
  const hit = cache.get(key);
  if (hit) return hit;
  let results: PlaceResult[];
  if (opts.explicit === false) {
    results = await searchPhoton(query, { ...opts, limit });
  } else {
    try {
      results = await searchNominatim(query, { ...opts, limit });
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      results = await searchPhoton(query, { ...opts, limit });
    }
  }
  remember(key, results);
  return results;
}

export interface DebouncedSearch {
  /** The text changed. Searches after the debounce delay. */
  input(text: string): void;
  /** Search now (Enter key). */
  flush(): void;
  cancel(): void;
}

/**
 * Debounced search where only the latest query's answer is delivered. A newer query aborts
 * the older request.
 */
export function createDebouncedSearch(opts: {
  /** `explicit` is true for `flush()` (Enter), false for a debounced keystroke. */
  search: (query: string, signal: AbortSignal, explicit: boolean) => Promise<PlaceResult[]>;
  onResults: (results: PlaceResult[], query: string) => void;
  onError?: (err: unknown, query: string) => void;
  onBusy?: (busy: boolean) => void;
  delayMs?: number;
  minChars?: number;
}): DebouncedSearch {
  const delay = opts.delayMs ?? SEARCH_DEBOUNCE_MS;
  const minChars = opts.minChars ?? SEARCH_MIN_CHARS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let text = '';
  let lastRun = '';
  let lastExplicit = false;
  let controller: AbortController | null = null;
  let seq = 0;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const run = (explicit: boolean): void => {
    clearTimer();
    const q = text.trim();
    if (q.length < minChars) {
      controller?.abort();
      controller = null;
      lastRun = '';
      opts.onResults([], q);
      return;
    }
    // Enter while a slow as-you-type search for the same text is pending re-asks the fast
    // explicit geocoder (or the cache) instead of waiting on it.
    if (q === lastRun && (!explicit || lastExplicit)) return;
    lastRun = q;
    lastExplicit = explicit;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const id = ++seq;
    opts.onBusy?.(true);
    opts
      .search(q, mine.signal, explicit)
      .then((results) => {
        if (id === seq) opts.onResults(results, q);
      })
      .catch((err) => {
        if (id !== seq || mine.signal.aborted) return;
        lastRun = '';
        opts.onError?.(err, q);
      })
      .finally(() => {
        if (id === seq) opts.onBusy?.(false);
      });
  };

  return {
    input(next) {
      text = next;
      clearTimer();
      timer = setTimeout(() => run(false), delay);
    },
    flush: () => run(true),
    cancel() {
      clearTimer();
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}
