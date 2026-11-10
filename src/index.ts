import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { createPanoSource } from './data/entry.js';
import { createPanoStage } from './pano/entry.js';
import { createTrack as createArchive } from './archive/entry.js';
import { createTrack as createMap } from './map/entry.js';
import { createTrack as createPortal } from './portal/entry.js';
import { createTrack as createTime } from './time/entry.js';
import { createTrack as createUi } from './ui/entry.js';
import { EventBus, createAppState } from './contracts.js';
import type { TrackContext } from './contracts.js';
import { wireFlow } from './flow.js';

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then(async (world) => {
  const bus = new EventBus();
  const state = createAppState(bus);
  const source = createPanoSource();
  const stage = createPanoStage(world, bus, source);
  const ctx: TrackContext = { world, bus, state, services: { source, stage } };

  wireFlow(ctx);
  for (const create of [createUi, createMap, createTime, createPortal, createArchive]) {
    await create(ctx);
  }

  if (import.meta.env.DEV) {
    // Handle for the emulator / MCP tools: window.__tm.bus.emit('spot:selected', {...})
    (window as unknown as { __tm: unknown }).__tm = { ...ctx };
    const { ACTIVE_SPIKE } = await import('./spikes/active.js');
    if (ACTIVE_SPIKE) (await import('./spikes/spike.js')).runSpike(ACTIVE_SPIKE, ctx);
  }
});
