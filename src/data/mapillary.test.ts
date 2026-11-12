import { describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { MapillaryClient } from './mapillary.js';
import spots from './spots.json';
import spotsMeta from './spots.meta.json';

const Y = (year: number, month = 5): number => Date.UTC(year, month, 10);

// Roughly 1e-5 degrees of latitude is 1.11 m.
const raw = (id: number, year: number, dMetres: number, extra: Record<string, unknown> = {}) => ({
  id: String(id),
  captured_at: Y(year),
  computed_geometry: { type: 'Point', coordinates: [-73.9855, 40.758 + dMetres / 111_195] },
  computed_compass_angle: 90,
  is_pano: true,
  sequence: 'seq',
  thumb_2048_url: `https://cdn/${id}-2048.jpg`,
  thumb_original_url: `https://cdn/${id}-orig.jpg`,
  width: 5760,
  height: 2880,
  creator: { username: 'someone', id: '1' },
  ...extra,
});

function setup(handler: (url: URL) => unknown | Promise<unknown>) {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const body = await handler(new URL(String(input)));
    const status = (body as { __status?: number })?.__status ?? 200;
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  const sleeps: number[] = [];
  let clock = 0;
  const client = new MapillaryClient({
    token: 'TESTTOKEN',
    fetchImpl: fetchImpl as unknown as typeof fetch,
    minIntervalMs: 100,
    retryDelayMs: 500,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  return { client, fetchImpl, sleeps };
}

describe('yearsAt', () => {
  it('groups by year and keeps the nearest per year', async () => {
    const m = config.maxYearOffsetMetres;
    const { client } = setup(() => ({
      data: [raw(1, 2022, m * 0.9), raw(2, 2022, m * 0.25), raw(3, 2023, m * 0.5), raw(4, 2025, m * 0.75)],
    }));
    const years = await client.yearsAt(40.758, -73.9855);
    expect([...years.keys()]).toEqual([2022, 2023, 2025]);
    expect(years.get(2022)?.id).toBe('2');
  });

  it('drops years whose nearest pano is beyond maxYearOffsetMetres', async () => {
    const far = config.maxYearOffsetMetres + 5;
    const { client } = setup(() => ({ data: [raw(1, 2022, 5), raw(2, 2019, far)] }));
    const years = await client.yearsAt(40.758, -73.9855);
    expect([...years.keys()]).toEqual([2022]);
  });

  it('ignores non-panoramas', async () => {
    const { client } = setup(() => ({ data: [raw(1, 2022, 5, { is_pano: false })] }));
    expect((await client.yearsAt(40.758, -73.9855)).size).toBe(0);
  });

  it('detects a one-year spot', async () => {
    const { client } = setup(() => ({ data: [raw(1, 2024, 3), raw(2, 2024, 9)] }));
    const years = await client.yearsAt(40.758, -73.9855);
    expect(years.size).toBe(1);
    expect([...years.keys()]).toEqual([2024]);
  });

  it('caches per spot', async () => {
    const { client, fetchImpl } = setup(() => ({ data: [raw(1, 2022, 5)] }));
    await client.yearsAt(40.758, -73.9855);
    await client.yearsAt(40.758, -73.9855);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back to one request per year band when the search is saturated', async () => {
    const { client, fetchImpl } = setup((url) => {
      const start = url.searchParams.get('start_captured_at');
      if (!start) return { data: Array.from({ length: 100 }, (_, i) => raw(1000 + i, 2025, 8)) };
      const y = Number(start.slice(0, 4));
      return { data: y === 2018 || y === 2025 ? [raw(y, y, 4)] : [] };
    });
    const years = await client.yearsAt(40.758, -73.9855);
    expect([...years.keys()]).toEqual([2018, 2025]);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(5);
  });
});

describe('field mapping', () => {
  it('maps fields and falls back to geometry / compass_angle', async () => {
    const { client } = setup(() => ({
      data: [
        {
          id: 77,
          captured_at: Y(2021),
          geometry: { coordinates: [10, 20] },
          compass_angle: 123,
          is_pano: true,
          sequence: 's',
          thumb_original_url: 'https://cdn/o.jpg',
          width: 1,
          height: 2,
        },
      ],
    }));
    const [p] = await client.panosNear(20, 10);
    expect(p).toMatchObject({
      id: '77',
      lat: 20,
      lng: 10,
      heading: 123,
      imageUrl: 'https://cdn/o.jpg',
      sequenceId: 's',
      creator: 'unknown',
    });
    expect(p.previewUrl).toBeUndefined();
  });

  it('prefers computed values and fills previewUrl', async () => {
    const { client } = setup(() => ({
      data: [raw(1, 2022, 0, { compass_angle: 5, geometry: { coordinates: [0, 0] } })],
    }));
    const [p] = await client.panosNear(40.758, -73.9855);
    expect(p.heading).toBe(90);
    expect(p.lng).toBeCloseTo(-73.9855);
    expect(p.previewUrl).toBe('https://cdn/1-2048.jpg');
    expect(p.imageUrl).toBe('https://cdn/1-orig.jpg');
    expect(p.creator).toBe('someone');
  });

  it('panosNear clamps radius to the Mapillary cap and sorts nearest first', async () => {
    const { client, fetchImpl } = setup(() => ({ data: [raw(1, 2022, 30), raw(2, 2023, 4)] }));
    const out = await client.panosNear(40.758, -73.9855, 500);
    expect(out.map((p) => p.id)).toEqual(['2', '1']);
    const url = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(url.searchParams.get('radius')).toBe('50');
    expect(url.searchParams.get('access_token')).toBe('TESTTOKEN');
  });
});

describe('neighbours', () => {
  it('returns same-year, same-sequence panos nearest first, excluding itself', async () => {
    const { client } = setup(() => ({
      data: [
        raw(1, 2022, 0),
        raw(2, 2022, 30),
        raw(3, 2022, 10),
        raw(4, 2023, 5),
        raw(5, 2022, 6, { sequence: 'other' }),
      ],
    }));
    const [self] = await client.panosNear(40.758, -73.9855, 1);
    const out = await client.neighbours(self);
    expect(out.map((p) => p.id)).toEqual(['3', '2']);
  });
});

describe('resolve', () => {
  it('fetches by id and caches', async () => {
    const { client, fetchImpl } = setup(() => raw(9, 2022, 0));
    const a = await client.resolve('9');
    await client.resolve('9');
    expect(a.id).toBe('9');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toContain('/9?');
  });
});

describe('throttling', () => {
  it('spaces request starts by minRequestIntervalMs', async () => {
    const { client, sleeps } = setup(() => ({ data: [] }));
    await Promise.all([client.panosNear(1, 1), client.panosNear(2, 2), client.panosNear(3, 3)]);
    expect(sleeps.filter((s) => s > 0)).toEqual([100, 100]);
  });

  it('de-duplicates identical in-flight requests', async () => {
    const { client, fetchImpl } = setup(() => raw(5, 2022, 5));
    const [a, b] = await Promise.all([client.resolve('5'), client.resolve('5')]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries once after code 4, then succeeds', async () => {
    let calls = 0;
    const { client, fetchImpl, sleeps } = setup(() => {
      calls++;
      return calls === 1 ? { error: { code: 4, message: 'rate' }, __status: 400 } : { data: [] };
    });
    await expect(client.panosNear(1, 1)).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toContain(500);
  });

  it('throws a clear error when the retry is throttled too, and does not cache it', async () => {
    let throttled = true;
    const { client, fetchImpl } = setup(() =>
      throttled ? { error: { code: 4, message: 'rate' }, __status: 400 } : { data: [] },
    );
    await expect(client.panosNear(1, 1)).rejects.toThrow(/rate limiting/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    throttled = false;
    await expect(client.panosNear(1, 1)).resolves.toEqual([]);
  });

  it('surfaces other API errors without retrying', async () => {
    const { client, fetchImpl } = setup(() => ({ error: { code: 1, message: 'bad' }, __status: 400 }));
    await expect(client.panosNear(1, 1)).rejects.toThrow(/bad/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('spots.json', () => {
  it('was built at the offset limit the runtime enforces', () => {
    // Fails when config.maxYearOffsetMetres changes: re-run `node src/data/build-spots.mjs`.
    expect(spotsMeta.maxOffsetM).toBe(config.maxYearOffsetMetres);
  });

  it('has 20 to 30 entries, each with at least 3 years and a pano id, and no URLs', () => {
    expect(spots.length).toBeGreaterThanOrEqual(20);
    expect(spots.length).toBeLessThanOrEqual(30);
    for (const s of spots) {
      expect(s.years.length, s.name).toBeGreaterThanOrEqual(3);
      expect(new Set(s.years).size).toBe(s.years.length);
      expect(typeof s.panoId).toBe('string');
      expect(JSON.stringify(s)).not.toMatch(/https?:/);
    }
  });
});

describe('clusterPlaces', () => {
  const mk = (id: string, year: number, northM: number) => ({
    id,
    lat: 40.758 + northM / 111_320,
    lng: -73.9855,
    capturedAt: Date.UTC(year, 5, 1),
    heading: 0,
    imageUrl: '',
    width: 1,
    height: 1,
    creator: 'x',
    sequenceId: 's',
  });

  it('merges years within the offset and drops one-year places', async () => {
    const { clusterPlaces } = await import('./mapillary.js');
    const panos = [mk('a', 2025, 0), mk('b', 2020, 6), mk('c', 2016, 9), mk('d', 2024, 300), mk('e', 2024, 305)];
    const out = clusterPlaces(panos, { lat: 40.758, lng: -73.9855 }, 12, 30);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ panoId: 'a', years: [2016, 2020, 2025] });
  });

  it('never counts a year from beyond the offset (the time machine could not show it)', async () => {
    const { clusterPlaces } = await import('./mapillary.js');
    const c = { lat: 40.758, lng: -73.9855 };
    expect(clusterPlaces([mk('a', 2025, 0), mk('b', 2023, 30)], c, 12, 30)).toHaveLength(0);
    expect(clusterPlaces([mk('a', 2025, 0), mk('b', 2025, 30)], c, 12, 30)).toHaveLength(0);
  });

  it('keeps one row for two valid places a lane apart', async () => {
    const { clusterPlaces } = await import('./mapillary.js');
    const c = { lat: 40.758, lng: -73.9855 };
    const panos = [mk('a', 2025, 0), mk('a2', 2022, 5), mk('b', 2024, 30), mk('b2', 2016, 33)];
    const out = clusterPlaces(panos, c, 12, 30);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ panoId: 'a', years: [2022, 2025] });
  });

  it('puts the nearest place first', async () => {
    const { clusterPlaces } = await import('./mapillary.js');
    const panos = [mk('far1', 2025, 400), mk('far2', 2020, 400), mk('near1', 2025, 20), mk('near2', 2020, 20)];
    const out = clusterPlaces(panos, { lat: 40.758, lng: -73.9855 }, 12, 30);
    expect(out.map((p) => p.panoId)).toEqual(['near1', 'far1']);
  });
});

describe('placesNear on a dense box', () => {
  it('splits the box into quadrants when Mapillary says it holds too much data', async () => {
    const tooMuch = {
      __status: 500,
      error: { code: 1, message: "Please reduce the amount of data you're asking for, then retry your request" },
    };
    const area = (u: URL): number => {
      const [w, s, e, n] = (u.searchParams.get('bbox') ?? '').split(',').map(Number);
      return (e - w) * (n - s);
    };
    let full = 0;
    const { client, fetchImpl } = setup((u) => {
      if (full === 0) full = area(u);
      return area(u) >= full * 0.99 ? tooMuch : { data: [raw(1, 2022, 5), raw(2, 2024, 5)] };
    });
    const places = await client.placesNear(40.758, -73.9855);
    // The first (centre tile) request is refused and split into four quadrants.
    expect(area(new URL(String(fetchImpl.mock.calls[1][0]))) / full).toBeCloseTo(0.25, 2);
    expect(places.length).toBeGreaterThan(0);
  });

  it('also splits when the browser reports the dense box as a network failure', async () => {
    const area = (u: URL): number => {
      const [w, s, e, n] = (u.searchParams.get('bbox') ?? '').split(',').map(Number);
      return (e - w) * (n - s);
    };
    let full = 0;
    let quad = 0;
    const { client } = setup((u) => {
      if (full === 0) full = area(u);
      if (area(u) >= full * 0.99) throw new TypeError('Failed to fetch');
      // One quadrant fails too; the other three still produce places.
      if (++quad === 1) throw new TypeError('Failed to fetch');
      return { data: [raw(quad * 10 + 1, 2022, 5), raw(quad * 10 + 2, 2024, 5)] };
    });
    const places = await client.placesNear(40.758, -73.9855);
    expect(places.length).toBeGreaterThan(0);
  });
});

describe('placesNear grows when quiet and stops when busy', () => {
  const bboxArea = (input: unknown): number => {
    const [w, s, e, n] = (new URL(String(input)).searchParams.get('bbox') ?? '').split(',').map(Number);
    return (e - w) * (n - s);
  };
  /** `count` raw images forming `places` two-year places, 50 m apart going north. */
  const crowd = (count: number, places: number, idBase = 0) =>
    Array.from({ length: count }, (_, i) =>
      raw(idBase + i, 2018 + (Math.floor(i / places) % 2) * 4, (i % places) * 50),
    );

  it('quiet: one small centre tile, then the whole box in one request', async () => {
    const { client, fetchImpl } = setup(() => ({ data: crowd(6, 3) }));
    const places = await client.placesNear(40.758, -73.9855);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [tile, whole] = fetchImpl.mock.calls.map((c) => bboxArea(c[0]));
    expect(whole).toBeGreaterThan(tile * 8); // grew from ~250 m to ~1 km
    expect(places.length).toBe(3);
  });

  it('quiet tile but saturated whole box: falls back to walking tiles', async () => {
    let call = 0;
    const { client, fetchImpl } = setup(() => {
      call++;
      if (call === 1) return { data: crowd(6, 3) }; // quiet centre tile
      if (call === 2) return { data: crowd(2000, 3, 50_000) }; // whole box hits the cap
      return { data: crowd(300, 12, call * 1000) };
    });
    const places = await client.placesNear(40.758, -73.9855);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(2); // walked on past the capped box
    expect(places.length).toBe(12);
  });

  it('busy: stops after the centre tile when it already fills the list', async () => {
    const { client, fetchImpl } = setup(() => ({ data: crowd(1200, 40) }));
    const places = await client.placesNear(40.758, -73.9855);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(places.length).toBe(15); // MAX_PLACES
  });

  it('normal: walks nearby tiles nearest first until the list is full', async () => {
    let call = 0;
    const { client, fetchImpl } = setup(() => ({ data: crowd(300, 12, ++call * 1000) }));
    // Each tile adds places at the same 12 spots, so ids differ but clusters do not grow past 12:
    // the walk covers every tile, never the whole box.
    await client.placesNear(40.758, -73.9855);
    const areas = fetchImpl.mock.calls.map((c) => bboxArea(c[0]));
    expect(Math.max(...areas)).toBeLessThan(areas[0] * 1.5);
    expect(fetchImpl.mock.calls.length).toBeGreaterThan(1);
  });

  it('a failed tile does not empty the list', async () => {
    let call = 0;
    const { client } = setup(() => {
      call++;
      if (call === 2) return { __status: 400, error: { code: 100, message: 'bad' } };
      return { data: crowd(300, 12, call * 1000) };
    });
    const places = await client.placesNear(40.758, -73.9855);
    expect(places.length).toBe(12);
  });

  it('reuses cached tiles after a small pan', async () => {
    const { client, fetchImpl } = setup(() => ({ data: crowd(1200, 40) }));
    await client.placesNear(40.758, -73.9855);
    await client.placesNear(40.7582, -73.9855); // a few metres: same centre tile
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
