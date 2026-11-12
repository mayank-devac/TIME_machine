import type { ArchiveService, Track, TrackFactory } from '../contracts.js';
import { createCommonsService } from './commons.js';
import { createController } from './controller.js';
import { ArchiveFadeSystem, createFrameRenderer, followTheme, forgetFramePlacements } from './frames.js';

/** Dev driver (fixture events, no other track needed). MUST be false when finishing. */
const DEV_DRIVER = false;

/** Track F: old Wikimedia Commons photographs as floating frames below the earliest Mapillary year. */
export const createTrack: TrackFactory = (ctx): Track & ArchiveService => {
  const service = createCommonsService();
  ctx.world.registerSystem(ArchiveFadeSystem);
  const stopController = createController({
    bus: ctx.bus,
    state: ctx.state,
    service,
    renderer: createFrameRenderer(ctx.world),
  });
  const offTheme = followTheme();
  // The world origin moves when an XR session starts or ends; dragged spots stop meaning anything.
  const xr = ctx.world.renderer.xr;
  xr.addEventListener('sessionstart', forgetFramePlacements);
  xr.addEventListener('sessionend', forgetFramePlacements);
  if (import.meta.env.DEV) {
    (window as unknown as { __archive: unknown }).__archive = service;
    ctx.bus.on('archive:visible', ({ photos }) =>
      console.log(
        `[archive] archive:visible ${JSON.stringify(photos.map((p) => ({ year: p.year, creator: p.creator, license: p.license, title: p.title })))}`,
      ),
    );
    if (DEV_DRIVER) void import('./dev-driver.js').then((m) => m.runDevDriver(ctx));
  }
  return {
    name: 'archive',
    photosNear: (lat, lng, beforeYear) => service.photosNear(lat, lng, beforeYear),
    dispose() {
      stopController();
      offTheme();
      xr.removeEventListener('sessionstart', forgetFramePlacements);
      xr.removeEventListener('sessionend', forgetFramePlacements);
      forgetFramePlacements();
      ctx.world.unregisterSystem(ArchiveFadeSystem);
    },
  };
};
