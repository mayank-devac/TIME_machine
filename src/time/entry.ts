import type { TrackFactory } from '../contracts.js';

/** Track entry. Phase 0 stub: does nothing. Replace with the real implementation. */
export const createTrack: TrackFactory = () => ({
  name: 'time',
  dispose() {},
});
