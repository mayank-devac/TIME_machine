import type { PanoSource } from '../contracts.js';
import { MockPanoSource } from '../mocks/mock-source.js';
import { MapillaryClient } from './mapillary.js';

/**
 * Track A entry: the Mapillary-backed panorama source. Without a token it logs an error and
 * falls back to the offline mock, so the app still starts.
 */
export function createPanoSource(): PanoSource {
  const token = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;
  if (!token) {
    console.error('[data] VITE_MAPILLARY_TOKEN is not set; using the offline mock source.');
    return new MockPanoSource();
  }
  return new MapillaryClient({ token });
}
