import type { World } from '@iwsdk/core';
import type { EventBus, PanoStage } from '../contracts.js';
import { MockPanoStage } from '../mocks/mock-stage.js';

/** Track B entry. Phase 0 stub: returns the minimal mock stage. Replace with the real one. */
export function createPanoStage(world: World, bus: EventBus): PanoStage {
  return new MockPanoStage(world, bus);
}
