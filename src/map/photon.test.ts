import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDebouncedSearch,
  labelOf,
  nominatimUrl,
  parseNominatim,
  parsePhoton,
  photonUrl,
  resetPlaceSearch,
  searchPlaces,
  type PlaceResult,
} from './photon.js';

const nominatimSample = [
  {
    lat: '40.7570095',
    lon: '-73.9859724',
    name: 'Times Square',
    display_name: 'Times Square, Manhattan, New York County, New York, United States',
    address: { suburb: 'Manhattan', city: 'New York', state: 'New York', country: 'United States' },
  },
  { lat: 'nope', lon: '2', name: 'Bad' },
  { lat: '48.8584', lon: '2.2945', display_name: 'Somewhere, France', address: {} },
];

const sample = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-73.9855, 40.758] },
      properties: { name: 'Times Square', district: 'Manhattan', city: 'New York', state: 'New York', country: 'United States' },
    },
    { type: 'Feature', geometry: { type: 'Point', coordinates: [500, 40] }, properties: { name: 'Bad' } },
    { type: 'Feature', geometry: null, properties: { name: 'No geometry' } },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [2.2945, 48.8584] },
      properties: { street: 'Avenue Gustave Eiffel', housenumber: '5', city: 'Paris', country: 'France' },
    },
  ],
};

describe('Photon parsing', () => {
  it('keeps valid points, drops malformed ones, and builds labels without repeats', () => {
    const out = parsePhoton(sample);
    expect(out).toEqual([
      { label: 'Times Square, Manhattan, New York, United States', lat: 40.758, lng: -73.9855 },
      { label: 'Avenue Gustave Eiffel 5, Paris, France', lat: 48.8584, lng: 2.2945 },
    ]);
  });

  it('survives junk input', () => {
    expect(parsePhoton(null)).toEqual([]);
    expect(parsePhoton({ features: 'x' })).toEqual([]);
    expect(labelOf({})).toBe('Unnamed place');
  });

  it('encodes the query and limit', () => {
    expect(photonUrl(' Times Square ', 5)).toBe('https://photon.komoot.io/api/?q=Times%20Square&limit=5');
  });

  it('searchPlaces (as-you-type) asks Photon only and reports HTTP errors', async () => {
    resetPlaceSearch();
    const ok = vi.fn(async (_u: string) => new Response(JSON.stringify(sample), { status: 200 }));
    expect((await searchPlaces('Times Square', { fetchFn: ok as unknown as typeof fetch, explicit: false })).length).toBe(2);
    expect(ok.mock.calls[0][0]).toContain('photon.komoot.io');
    const bad = vi.fn(async () => new Response('', { status: 503 }));
    await expect(searchPlaces('x', { fetchFn: bad as unknown as typeof fetch, explicit: false })).rejects.toThrow(/503/);
  });
});

describe('Nominatim (explicit search)', () => {
  beforeEach(() => resetPlaceSearch());

  it('parses jsonv2 rows into short labels and drops bad coordinates', () => {
    expect(parseNominatim(nominatimSample)).toEqual([
      { label: 'Times Square, Manhattan, New York, United States', lat: 40.7570095, lng: -73.9859724 },
      { label: 'Somewhere, France', lat: 48.8584, lng: 2.2945 },
    ]);
    expect(parseNominatim({})).toEqual([]);
    expect(nominatimUrl(' Times Square ', 5)).toBe(
      'https://nominatim.openstreetmap.org/search?q=Times%20Square&format=jsonv2&addressdetails=1&limit=5',
    );
  });

  it('asks Nominatim first and caches the answer', async () => {
    const f = vi.fn(async (_u: string) => new Response(JSON.stringify(nominatimSample), { status: 200 }));
    const fetchFn = f as unknown as typeof fetch;
    expect(await searchPlaces('Times Square', { fetchFn })).toHaveLength(2);
    expect(f.mock.calls[0][0]).toContain('nominatim.openstreetmap.org');
    expect(await searchPlaces('  times   square ', { fetchFn })).toHaveLength(2);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('falls back to Photon when Nominatim fails', async () => {
    const f = vi.fn(async (u: string) =>
      u.includes('nominatim') ? new Response('', { status: 503 }) : new Response(JSON.stringify(sample), { status: 200 }),
    );
    expect(await searchPlaces('Eiffel', { fetchFn: f as unknown as typeof fetch })).toHaveLength(2);
    expect(f.mock.calls.map((c) => new URL(c[0]).host)).toEqual(['nominatim.openstreetmap.org', 'photon.komoot.io']);
  });

  it('falls back to Photon when Nominatim is too slow', async () => {
    const f = vi.fn((u: string, init?: RequestInit) =>
      u.includes('nominatim')
        ? new Promise<Response>((_, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
          )
        : Promise.resolve(new Response(JSON.stringify(sample), { status: 200 })),
    );
    const out = await searchPlaces('Slow', { fetchFn: f as unknown as typeof fetch, timeoutMs: 10 });
    expect(out).toHaveLength(2);
  });
});

describe('debounced search', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for typing to pause and sends one request', async () => {
    const search = vi.fn(async (q: string): Promise<PlaceResult[]> => [{ label: q, lat: 0, lng: 0 }]);
    const onResults = vi.fn();
    const d = createDebouncedSearch({ search, onResults, delayMs: 300 });
    d.input('Tim');
    d.input('Time');
    d.input('Times');
    await vi.advanceTimersByTimeAsync(299);
    expect(search).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0]).toBe('Times');
    await vi.runAllTimersAsync();
    expect(onResults).toHaveBeenCalledWith([{ label: 'Times', lat: 0, lng: 0 }], 'Times');
  });

  it('does not search short text and does not repeat the same query', async () => {
    const search = vi.fn(async (): Promise<PlaceResult[]> => []);
    const onResults = vi.fn();
    const d = createDebouncedSearch({ search, onResults });
    d.input('ab');
    d.flush();
    expect(search).not.toHaveBeenCalled();
    expect(onResults).toHaveBeenCalledWith([], 'ab');
    d.input('Paris');
    d.flush();
    d.flush();
    expect(search).toHaveBeenCalledTimes(1);
  });

  it('marks typing as as-you-type and Enter as explicit, re-asking once on Enter', async () => {
    const search = vi.fn(async (): Promise<PlaceResult[]> => []);
    const d = createDebouncedSearch({ search, onResults: vi.fn(), delayMs: 100 });
    d.input('Paris');
    await vi.advanceTimersByTimeAsync(100);
    expect(search).toHaveBeenLastCalledWith('Paris', expect.anything(), false);
    d.flush();
    expect(search).toHaveBeenLastCalledWith('Paris', expect.anything(), true);
    d.flush();
    expect(search).toHaveBeenCalledTimes(2);
  });

  it('only delivers the newest answer and aborts the older request', async () => {
    let first: AbortSignal | null = null;
    const resolvers: Array<(r: PlaceResult[]) => void> = [];
    const search = vi.fn((q: string, signal: AbortSignal) => {
      if (q === 'Paris') first = signal;
      return new Promise<PlaceResult[]>((res) => resolvers.push(res));
    });
    const onResults = vi.fn();
    const d = createDebouncedSearch({ search, onResults });
    d.input('Paris');
    d.flush();
    d.input('London');
    d.flush();
    expect(first!.aborted).toBe(true);
    resolvers[0]([{ label: 'Paris', lat: 0, lng: 0 }]);
    resolvers[1]([{ label: 'London', lat: 0, lng: 0 }]);
    await vi.runAllTimersAsync();
    expect(onResults).toHaveBeenCalledTimes(1);
    expect(onResults.mock.calls[0][1]).toBe('London');
  });

  it('reports errors and allows a retry of the same query', async () => {
    const search = vi.fn(async (): Promise<PlaceResult[]> => {
      throw new Error('offline');
    });
    const onError = vi.fn();
    const d = createDebouncedSearch({ search, onResults: vi.fn(), onError });
    d.input('Paris');
    d.flush();
    await vi.runAllTimersAsync();
    expect(onError).toHaveBeenCalledTimes(1);
    d.flush();
    await vi.runAllTimersAsync();
    expect(search).toHaveBeenCalledTimes(2);
  });
});
