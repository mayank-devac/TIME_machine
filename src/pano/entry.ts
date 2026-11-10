import type { World } from '@iwsdk/core';
import type { EventBus, PanoSource, PanoStage } from '../contracts.js';
import { createPanoSource } from '../data/entry.js';
import { PANO_DEV_HARNESS } from './dev-flag.js';
import { ProductionPanoStage } from './stage.js';

/**
 * Track B entry: the production pano stage.
 *
 * `source` feeds the hop arrows (`PanoSource.neighbours`). The frozen signature has no source,
 * so without one the stage creates its own through Track A's entry. CHANGE REQUEST for
 * `index.ts`: pass the shared instance, `createPanoStage(world, bus, source)`, so the arrows
 * share Track A's cache and request throttle.
 */
export function createPanoStage(world: World, bus: EventBus, source?: PanoSource): PanoStage {
  let src = source ?? createPanoSource();
  if (import.meta.env.DEV && PANO_DEV_HARNESS) {
    src = withFixtureNeighbours(src);
  }
  const stage = new ProductionPanoStage(world, bus, src);
  if (import.meta.env.DEV && PANO_DEV_HARNESS) {
    void import('./dev-harness.js').then((m) => m.installPanoHarness(world, bus, stage));
  }
  return stage;
}

/** Dev only: the mock source has one pano per year, so give it neighbours to hop between. */
function withFixtureNeighbours(base: PanoSource): PanoSource {
  return {
    panosNear: (lat, lng, r) => base.panosNear(lat, lng, r),
    yearsAt: (lat, lng) => base.yearsAt(lat, lng),
    resolve: (id) => base.resolve(id),
    placesNear: (lat, lng) => base.placesNear(lat, lng),
    spots: () => base.spots(),
    neighbours: async (pano) => {
      const { devNeighbours } = await import('./dev-harness.js');
      return devNeighbours(pano);
    },
  };
}
