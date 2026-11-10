import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDebouncedSearch, labelOf, parsePhoton, photonUrl, searchPlaces, type PlaceResult } from './photon.js';

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

  it('searchPlaces uses the given fetch and reports HTTP errors', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify(sample), { status: 200 }));
    expect((await searchPlaces('Times Square', { fetchFn: ok as unknown as typeof fetch })).length).toBe(2);
    const bad = vi.fn(async () => new Response('', { status: 503 }));
    await expect(searchPlaces('x', { fetchFn: bad as unknown as typeof fetch })).rejects.toThrow(/503/);
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
