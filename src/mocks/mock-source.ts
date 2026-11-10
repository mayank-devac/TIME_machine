import fixtures from './fixtures.json';
import type { CuratedSpot, Pano, PanoSource } from '../contracts.js';
import { yearOf } from '../contracts.js';

const base = (path: string): string =>
  `${import.meta.env.BASE_URL}${path.replace(/^\/+/u, '')}`;

/** The two fixture panoramas (Times Square, 2023 and 2025), served from `public/dev/`. */
export const FIXTURE_PANOS: Pano[] = (fixtures as Pano[]).map((p) => ({
  ...p,
  imageUrl: base(p.imageUrl),
  previewUrl: base(p.imageUrl),
}));

export const FIXTURE_SPOT: CuratedSpot = {
  name: 'Times Square (fixture)',
  lat: FIXTURE_PANOS[1].lat,
  lng: FIXTURE_PANOS[1].lng,
  panoId: FIXTURE_PANOS[1].id,
  years: FIXTURE_PANOS.map(yearOf).sort(),
};

/** Offline `PanoSource`: always answers with the fixtures. Tracks develop against this. */
export class MockPanoSource implements PanoSource {
  async panosNear(): Promise<Pano[]> {
    return [...FIXTURE_PANOS].reverse();
  }

  async yearsAt(): Promise<Map<number, Pano>> {
    return new Map(FIXTURE_PANOS.map((p) => [yearOf(p), p]));
  }

  async neighbours(pano: Pano): Promise<Pano[]> {
    return FIXTURE_PANOS.filter((p) => yearOf(p) === yearOf(pano) && p.id !== pano.id);
  }

  async resolve(id: string): Promise<Pano> {
    const found = FIXTURE_PANOS.find((p) => p.id === id);
    if (!found) throw new Error(`mock source: unknown pano ${id}`);
    return found;
  }

  spots(): CuratedSpot[] {
    return [FIXTURE_SPOT];
  }
}
