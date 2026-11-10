import type { ArchivePhoto, ArchiveService } from '../contracts.js';

/** Pure data layer: Wikimedia Commons geosearch + image info, parsing, selection, cache. */

export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
export const MAX_PHOTOS = 6;
/** Geosearch radius in metres (API max 10000). Old photos are rarer, so look a bit wider. */
export const SEARCH_RADIUS_M = 1500;
/** Candidates fetched in one request (generator limit for anonymous clients is 50). */
export const CANDIDATE_LIMIT = 50;
export const MIN_YEAR = 1800;
export const MAX_YEAR = 2100;

type Fetch = (input: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

interface MetaValue {
  value?: string;
}
interface CommonsPage {
  title?: string;
  coordinates?: Array<{ lat: number; lon: number }>;
  imageinfo?: Array<{
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    width?: number;
    height?: number;
    mime?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, MetaValue | undefined>;
  }>;
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Remove tags and decode the common entities. Output is plain text for canvas drawing. */
export function stripHtml(input: string | undefined): string {
  if (!input) return '';
  const noTags = input.replace(/<[^>]*>/gu, ' ');
  const decoded = noTags
    .replace(/&#(\d+);/gu, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/giu, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/gu, (m) => ENTITIES[m] ?? m);
  return decoded.replace(/\s+/gu, ' ').trim();
}

/** First plausible 4-digit year in a free-form date string, or null. */
export function extractYear(text: string | undefined, maxYear = new Date().getUTCFullYear()): number | null {
  if (!text) return null;
  const plain = stripHtml(text);
  for (const m of plain.matchAll(/(?<!\d)(\d{4})(?!\d)/gu)) {
    const y = Number(m[1]);
    if (y >= MIN_YEAR && y <= Math.min(MAX_YEAR, maxYear)) return y;
  }
  return null;
}

const SHOWABLE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Turn a geosearch+imageinfo response into photos. Skips anything without a usable year. */
export function parseCommonsResponse(json: unknown, fallback: { lat: number; lng: number }): ArchivePhoto[] {
  const pages = ((json as { query?: { pages?: CommonsPage[] } })?.query?.pages ?? []) as CommonsPage[];
  const out: ArchivePhoto[] = [];
  for (const page of pages) {
    const info = page.imageinfo?.[0];
    if (!info?.thumburl || !info.descriptionurl) continue;
    if (info.mime && !SHOWABLE_MIME.has(info.mime)) continue;
    const meta = info.extmetadata ?? {};
    const year = extractYear(meta.DateTimeOriginal?.value);
    if (year === null) continue;
    const license = stripHtml(meta.LicenseShortName?.value);
    if (!license) continue; // never show a photo without its licence
    const creator = stripHtml(meta.Artist?.value) || 'Unknown author';
    const title = (stripHtml(meta.ObjectName?.value) || (page.title ?? '').replace(/^File:/u, '').replace(/\.[a-z0-9]+$/iu, '')).slice(0, 120);
    const coord = page.coordinates?.[0];
    out.push({
      title,
      year,
      imageUrl: info.thumburl,
      pageUrl: info.descriptionurl,
      creator: creator.slice(0, 80),
      license: license.slice(0, 40),
      width: info.thumbwidth ?? info.width ?? 1024,
      height: info.thumbheight ?? info.height ?? 768,
      lat: coord?.lat ?? fallback.lat,
      lng: coord?.lon ?? fallback.lng,
    });
  }
  return out;
}

/**
 * Choose up to `max` photos spread across years. Photos older than `beforeYear` come first;
 * newer ones only fill remaining slots when nothing older exists (they are then dropped, because
 * showing a 2019 photo under a dial set before 2014 would mislead). Result sorted by year.
 */
export function selectPhotos(candidates: ArchivePhoto[], beforeYear?: number, max = MAX_PHOTOS): ArchivePhoto[] {
  const pool = candidates.filter((p) => beforeYear === undefined || p.year < beforeYear);
  if (pool.length <= max) return [...pool].sort((a, b) => a.year - b.year);
  const byYear = new Map<number, ArchivePhoto[]>();
  for (const p of pool) {
    const list = byYear.get(p.year);
    if (list) list.push(p);
    else byYear.set(p.year, [p]);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  const chosen: ArchivePhoto[] = [];
  if (years.length >= max) {
    // Evenly spaced years across the range, first (nearest) photo of each.
    for (let i = 0; i < max; i++) {
      const y = years[Math.round((i * (years.length - 1)) / (max - 1))];
      chosen.push(byYear.get(y)![0]);
    }
  } else {
    // Round-robin through the years so no single year dominates.
    for (let round = 0; chosen.length < max; round++) {
      let added = false;
      for (const y of years) {
        const p = byYear.get(y)![round];
        if (p && chosen.length < max) {
          chosen.push(p);
          added = true;
        }
      }
      if (!added) break;
    }
  }
  return chosen.sort((a, b) => a.year - b.year);
}

export function placeKey(lat: number, lng: number): string {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

export function buildUrl(lat: number, lng: number): string {
  const params = new URLSearchParams({
    action: 'query',
    generator: 'geosearch',
    ggscoord: `${lat}|${lng}`,
    ggsradius: String(SEARCH_RADIUS_M),
    ggsnamespace: '6',
    ggslimit: String(CANDIDATE_LIMIT),
    prop: 'coordinates|imageinfo',
    iiprop: 'url|extmetadata|size|mime',
    iiurlwidth: '1024',
    iiextmetadatafilter: 'DateTimeOriginal|Artist|LicenseShortName|ObjectName',
    format: 'json',
    formatversion: '2',
    origin: '*',
  });
  return `${COMMONS_API}?${params.toString()}`;
}

export interface CommonsService extends ArchiveService {
  /** Number of network requests made so far (for tests and the README). */
  readonly requestCount: number;
}

/**
 * One request per place (about 110 m cell), cached in memory for the session. A failed request is
 * not cached, so a later attempt can retry.
 */
export function createCommonsService(fetchImpl: Fetch = (u) => fetch(u)): CommonsService {
  const cache = new Map<string, Promise<ArchivePhoto[]>>();
  let requests = 0;

  const load = (lat: number, lng: number): Promise<ArchivePhoto[]> => {
    const key = placeKey(lat, lng);
    let hit = cache.get(key);
    if (!hit) {
      requests++;
      hit = (async () => {
        const res = await fetchImpl(buildUrl(lat, lng));
        if (!res.ok) throw new Error(`Wikimedia Commons answered ${res.status}`);
        return parseCommonsResponse(await res.json(), { lat, lng });
      })();
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
    }
    return hit;
  };

  return {
    get requestCount() {
      return requests;
    },
    async photosNear(lat, lng, beforeYear) {
      return selectPhotos(await load(lat, lng), beforeYear);
    },
  };
}
