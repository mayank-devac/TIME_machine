import type { PanoSource } from '../contracts.js';
import { MockPanoSource } from '../mocks/mock-source.js';

/** Track A entry. Phase 0 stub: returns the offline mock. Replace with the Mapillary client. */
export function createPanoSource(): PanoSource {
  return new MockPanoSource();
}
