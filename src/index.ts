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
import { DragSystem } from './drag.js';
import { wireFlow } from './flow.js';
import { HoverSystem } from './hover.js';
import { PrefsStore } from './prefs.js';

// The XR emulator asks for pointer lock on click; the browser refuses it for a moment after the
// user pressed Esc. That refusal is harmless, so keep it out of the console as an unhandled error.
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { name?: string; message?: string } | undefined;
  if (r?.name === 'SecurityError' && /pointer lock/i.test(r.message ?? '')) e.preventDefault();
});

World.create(
  document.getElementById('scene-container') as HTMLDivElement,
  projectOptions,
).then(async (world) => {
  const bus = new EventBus();
  const state = createAppState(bus);
  const source = createPanoSource();
  const stage = createPanoStage(world, bus, source);
  // Loads the saved settings and applies the theme before any surface is built.
  const prefs = new PrefsStore(bus);
  const ctx: TrackContext = { world, bus, state, prefs, services: { source, stage } };

  world.registerSystem(HoverSystem);
  world.registerSystem(DragSystem);
  wireFlow(ctx);
  for (const create of [createUi, createMap, createTime, createPortal, createArchive]) {
    await create(ctx);
  }

  if (import.meta.env.DEV) {
    // Handle for the emulator / MCP tools: window.__tm.bus.emit('spot:selected', {...})
    (window as unknown as { __tm: unknown }).__tm = { ...ctx };
  }
});
