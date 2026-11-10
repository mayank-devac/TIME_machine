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

export async function searchPlaces(
  query: string,
  opts: { fetchFn?: typeof fetch; signal?: AbortSignal; limit?: number } = {},
): Promise<PlaceResult[]> {
  const fetchFn = opts.fetchFn ?? fetch;
  const resp = await fetchFn(photonUrl(query, opts.limit), { signal: opts.signal });
  if (!resp.ok) throw new Error(`Place search failed (HTTP ${resp.status}).`);
  return parsePhoton(await resp.json());
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
  search: (query: string, signal: AbortSignal) => Promise<PlaceResult[]>;
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
  let controller: AbortController | null = null;
  let seq = 0;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const run = (): void => {
    clearTimer();
    const q = text.trim();
    if (q.length < minChars) {
      controller?.abort();
      controller = null;
      lastRun = '';
      opts.onResults([], q);
      return;
    }
    if (q === lastRun) return;
    lastRun = q;
    controller?.abort();
    const mine = new AbortController();
    controller = mine;
    const id = ++seq;
    opts.onBusy?.(true);
    opts
      .search(q, mine.signal)
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
      timer = setTimeout(run, delay);
    },
    flush: run,
    cancel() {
      clearTimer();
      controller?.abort();
      controller = null;
      seq++;
    },
  };
}
