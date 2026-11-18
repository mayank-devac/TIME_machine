/**
 * The viewer's frame of reference. Orchestrator-owned.
 *
 * The one place that decides "the user's view has a new origin or heading, so world-placed
 * things should snap in front of them again": app start, an XR session starting or ending
 * (the world origin moves), the headset's own recentre (holding the Meta button resets the
 * reference space), and the desktop C key. Each emits `viewer:recentred` with the head pose
 * once it can be trusted; tracks only listen. Hard snaps, never animated.
 */
import { Vector3 } from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import type { EventBus } from './contracts.js';
import { readHead } from './head.js';

/** How long the head pose needs before it can be trusted after each trigger, ms. */
const SETTLE_MS = {
  /** First frames of the page: the camera has not been posed yet. */
  appStart: 300,
  /** A new or ended XR session: the viewer pose arrives a few frames later. */
  session: 700,
  /** Headset recentre: the next XR frame carries the new pose. */
  reset: 100,
  key: 0,
} as const;

export function wireViewer(world: World, bus: EventBus): () => void {
  const xr = world.renderer.xr;
  const head = new Vector3();
  const forward = new Vector3();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let space: XRReferenceSpace | null = null;

  const emit = (): void => {
    timer = null;
    readHead(world, head, forward);
    bus.emit('viewer:recentred', { head: head.clone(), forward: forward.clone(), immersive: xr.isPresenting });
  };
  // A newer trigger replaces a pending one: one snap per burst, from the latest pose.
  const schedule = (ms: number): void => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(emit, ms);
  };

  const onReset = (): void => schedule(SETTLE_MS.reset);
  const watchResets = (next: XRReferenceSpace | null): void => {
    space?.removeEventListener('reset', onReset);
    space = next;
    space?.addEventListener('reset', onReset);
  };
  const onSessionStart = (): void => {
    watchResets(xr.getReferenceSpace());
    schedule(SETTLE_MS.session);
  };
  const onSessionEnd = (): void => {
    watchResets(null);
    schedule(SETTLE_MS.session);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyC' || event.repeat || event.ctrlKey || event.metaKey) return;
    schedule(SETTLE_MS.key);
  };

  xr.addEventListener('sessionstart', onSessionStart);
  xr.addEventListener('sessionend', onSessionEnd);
  window.addEventListener('keydown', onKey);
  schedule(SETTLE_MS.appStart);

  return () => {
    if (timer !== null) clearTimeout(timer);
    watchResets(null);
    xr.removeEventListener('sessionstart', onSessionStart);
    xr.removeEventListener('sessionend', onSessionEnd);
    window.removeEventListener('keydown', onKey);
  };
}
