import { describe, expect, it, vi } from 'vitest';
import type { ArchivePhoto } from '../contracts.js';
import { EventBus, createAppState } from '../contracts.js';
import {
  createCommonsService,
  extractYear,
  parseCommonsResponse,
  selectPhotos,
  stripHtml,
} from './commons.js';
import { createController } from './controller.js';

const page = (title: string, date: string | undefined, extra: Record<string, unknown> = {}) => ({
  title: `File:${title}.jpg`,
  coordinates: [{ lat: 40.7581, lon: -73.9852 }],
  imageinfo: [
    {
      thumburl: `https://upload.wikimedia.org/${title}.jpg`,
      thumbwidth: 1024,
      thumbheight: 768,
      mime: 'image/jpeg',
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${title}.jpg`,
      extmetadata: {
        ...(date ? { DateTimeOriginal: { value: date } } : {}),
        Artist: { value: '<a href="//x">Jane &amp; Co</a>' },
        LicenseShortName: { value: 'CC BY-SA 4.0' },
        ...extra,
      },
    },
  ],
});
const response = (...pages: unknown[]) => ({ query: { pages } });

const photo = (year: number, id = String(year)): ArchivePhoto => ({
  title: id, year, imageUrl: `u${id}`, pageUrl: `p${id}`, creator: 'c', license: 'PD',
  width: 1, height: 1, lat: 0, lng: 0,
});

describe('parsing', () => {
  it('strips html and entities', () => {
    expect(stripHtml('<a href="x">Jane &amp; Co</a> <b>Ltd</b>')).toBe('Jane & Co Ltd');
    expect(stripHtml(undefined)).toBe('');
  });
  it('extracts years from messy date text', () => {
    expect(extractYear('Taken on 28 October 2011, 17:19')).toBe(2011);
    expect(extractYear('<time>1925-03-02</time>')).toBe(1925);
    expect(extractYear('c. 1890s')).toBe(1890);
    expect(extractYear('id 12345678')).toBe(null);
    expect(extractYear('year 1650')).toBe(null);
    expect(extractYear('2999-01-01', 2026)).toBe(null);
    expect(extractYear(undefined)).toBe(null);
  });
  it('parses pages, skipping unusable ones', () => {
    const out = parseCommonsResponse(
      response(
        page('a', '1925-03-02'),
        page('nodate', undefined),
        page('nolic', '1930', { LicenseShortName: { value: '' } }),
        { ...page('svg', '1930'), imageinfo: [{ ...page('svg', '1930').imageinfo[0], mime: 'image/svg+xml' }] },
        page('noartist', '1940', { Artist: undefined }),
      ),
      { lat: 1, lng: 2 },
    );
    expect(out.map((p) => p.year)).toEqual([1925, 1940]);
    expect(out[0].creator).toBe('Jane & Co');
    expect(out[0].license).toBe('CC BY-SA 4.0');
    expect(out[0].lat).toBe(40.7581);
    expect(out[0].title).toBe('a');
    expect(out[1].creator).toBe('Unknown author');
  });
  it('survives an empty or odd response', () => {
    expect(parseCommonsResponse({}, { lat: 0, lng: 0 })).toEqual([]);
    expect(parseCommonsResponse(null, { lat: 0, lng: 0 })).toEqual([]);
  });
});

describe('selection', () => {
  it('keeps only photos older than beforeYear', () => {
    const out = selectPhotos([photo(1900), photo(2020), photo(2000)], 2014);
    expect(out.map((p) => p.year)).toEqual([1900, 2000]);
  });
  it('caps at six and spreads across years', () => {
    const many = [1900, 1910, 1920, 1930, 1940, 1950, 1960, 1970, 1980, 1990].map((y) => photo(y));
    const out = selectPhotos(many, 2000);
    expect(out).toHaveLength(6);
    expect(out[0].year).toBe(1900);
    expect(out[5].year).toBe(1990);
  });
  it('does not let one year dominate', () => {
    const same = Array.from({ length: 10 }, (_v, i) => photo(1950, `s${i}`));
    const out = selectPhotos([...same, photo(1900), photo(1990)], 2000);
    expect(out).toHaveLength(6);
    expect(out.some((p) => p.year === 1900)).toBe(true);
    expect(out.some((p) => p.year === 1990)).toBe(true);
  });
});

describe('service', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
  it('caches per place and shares in-flight requests', async () => {
    const fetchMock = vi.fn(async () => ok(response(page('a', '1925'), page('b', '2020'))));
    const svc = createCommonsService(fetchMock);
    const [a, b] = await Promise.all([svc.photosNear(40.7581, -73.9852), svc.photosNear(40.7583, -73.9851, 2000)]);
    expect(a).toHaveLength(2);
    expect(b.map((p) => p.year)).toEqual([1925]);
    await svc.photosNear(40.7581, -73.9852, 1950);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await svc.photosNear(41, -73);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const url = (fetchMock.mock.calls as unknown as string[][])[0][0];
    expect(url).toContain('origin=*');
    expect(url).toContain('ggsnamespace=6');
  });
  it('does not cache failures', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
      .mockResolvedValueOnce(ok(response(page('a', '1925'))));
    const svc = createCommonsService(fetchMock);
    await expect(svc.photosNear(1, 1)).rejects.toThrow('503');
    await expect(svc.photosNear(1, 1)).resolves.toHaveLength(1);
  });
});

describe('controller', () => {
  const setup = () => {
    const bus = new EventBus();
    const state = createAppState(bus);
    const photos = [photo(1900), photo(1950)];
    const service = { photosNear: vi.fn(async () => photos) };
    const renderer = { show: vi.fn(async (p: ArchivePhoto[]) => p), hide: vi.fn() };
    createController({ bus, state, service, renderer });
    const visible: ArchivePhoto[][] = [];
    bus.on('archive:visible', ({ photos: p }) => visible.push(p));
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const toStreet = () => {
      bus.emit('spot:selected', { lat: 40.7, lng: -74 });
      bus.emit('mode:changed', { mode: 'street', previous: 'table' });
      bus.emit('time:yearsKnown', { years: [2022, 2025], earliest: 2022 });
      bus.emit('time:toggled', { on: true });
    };
    return { bus, service, renderer, visible, flush, toStreet, photos };
  };

  it('shows only below the earliest year and emits the photos', async () => {
    const t = setup();
    t.toStreet();
    t.bus.emit('time:yearChanged', { year: 2023 });
    await t.flush();
    expect(t.renderer.show).not.toHaveBeenCalled();
    expect(t.visible).toEqual([]);
    t.bus.emit('time:yearChanged', { year: 2010 });
    await t.flush();
    expect(t.renderer.show).toHaveBeenCalledTimes(1);
    expect(t.service.photosNear).toHaveBeenLastCalledWith(40.7, -74, 2022);
    expect(t.visible).toEqual([t.photos]);
  });

  it('does not refetch or re-show on every year step', async () => {
    const t = setup();
    t.toStreet();
    for (const y of [2010, 2009, 2008, 2007]) t.bus.emit('time:yearChanged', { year: y });
    await t.flush();
    expect(t.renderer.show).toHaveBeenCalledTimes(1);
    expect(t.visible).toHaveLength(1);
  });

  it('hides and emits an empty array when the dial returns, the lens turns off or the mode leaves', async () => {
    for (const hideIt of [
      (t: ReturnType<typeof setup>) => t.bus.emit('time:yearChanged', { year: 2024 }),
      (t: ReturnType<typeof setup>) => t.bus.emit('time:toggled', { on: false }),
      (t: ReturnType<typeof setup>) => t.bus.emit('mode:changed', { mode: 'table', previous: 'street' }),
    ]) {
      const t = setup();
      t.toStreet();
      t.bus.emit('time:yearChanged', { year: 2010 });
      await t.flush();
      hideIt(t);
      expect(t.renderer.hide).toHaveBeenCalled();
      expect(t.visible[t.visible.length - 1]).toEqual([]);
    }
  });

  it('reports only photos that actually loaded', async () => {
    const t = setup();
    t.renderer.show.mockImplementation(async (p: ArchivePhoto[]) => [p[0]]);
    t.toStreet();
    t.bus.emit('time:yearChanged', { year: 2010 });
    await t.flush();
    expect(t.visible[t.visible.length - 1]).toEqual([t.photos[0]]);
  });

  it('drops a show that was hidden while loading', async () => {
    const t = setup();
    let release!: () => void;
    t.renderer.show.mockImplementation(
      (p: ArchivePhoto[]) => new Promise<ArchivePhoto[]>((r) => (release = () => r(p))),
    );
    t.toStreet();
    t.bus.emit('time:yearChanged', { year: 2010 });
    await t.flush();
    t.bus.emit('time:toggled', { on: false });
    release();
    await t.flush();
    expect(t.visible).toEqual([]);
  });

  it('emits an error but stays quiet on photos when the fetch fails', async () => {
    const t = setup();
    t.service.photosNear.mockRejectedValue(new Error('offline'));
    const errors: unknown[] = [];
    t.bus.on('error', (e) => errors.push(e));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    t.toStreet();
    t.bus.emit('time:yearChanged', { year: 2010 });
    await t.flush();
    expect(errors).toHaveLength(1);
    expect(t.visible).toEqual([]);
  });

  it('prefetches when a spot is chosen', async () => {
    const t = setup();
    t.bus.emit('spot:selected', { lat: 1, lng: 2 });
    expect(t.service.photosNear).toHaveBeenCalledWith(1, 2);
  });
});
