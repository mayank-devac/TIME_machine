import { DistanceGrabbable, MovementMode, RayInteractable, Vector3 } from '@iwsdk/core';
import type { Entity, Object3D } from '@iwsdk/core';
import { config } from '../config.js';
import type { Portal, Track, TrackContext, TrackFactory } from '../contracts.js';
import { stopBubbling } from '../drag.js';
import { HoverFx, PortalFrameTag } from '../track-components.js';
import { PORTAL_DEV_DEMO, runDevDemo } from './dev-demo.js';
import { readHead } from '../head.js';
import { PortalFlow } from './portal-flow.js';
import { placeInFrontOfHead } from './portal-logic.js';
import type { Placement } from './portal-logic.js';
import { PortalSystem } from './portal-system.js';
import { PortalWindow, SLOT } from './portal-window.js';

/** How far in front of the head the window opens, and how far below eye level its centre sits. */
const OPEN_DISTANCE_M = 1.6;
const OPEN_DROP_M = 0.2;

export interface PortalTrack extends Track, Portal {
  readonly flow: PortalFlow;
}

/**
 * Track E: the passthrough portal. In `portal` mode a framed window stands in the room; the
 * stage sphere is drawn only through it (stencil).
 *  - Move it: press and drag the frame or the glass (ray + trigger, or a hand pinch).
 *  - Resize it: drag the block on its bottom-right corner (clamped by `config.portal`).
 *  - Enter the street: step through it, push a hand through it, tap the glass, or press
 *    STEP IN. MAP returns to the room and its table.
 */
export const createTrack: TrackFactory = (ctx: TrackContext): PortalTrack => {
  const { world, bus, state, services } = ctx;
  const win = new PortalWindow();

  const frameEntity = world.createTransformEntity(win.root, { persistent: true });
  frameEntity.addComponent(PortalFrameTag, { slot: SLOT.frame });
  frameEntity.addComponent(RayInteractable);
  frameEntity.addComponent(DistanceGrabbable, {
    movementMode: MovementMode.MoveFromTarget,
    rotate: false,
    scale: false,
    translate: true,
  });
  const children: Entity[] = [];
  const child = (obj: Object3D, slot: string): Entity => {
    const e = world.createTransformEntity(obj, { parent: frameEntity, persistent: true });
    e.addComponent(PortalFrameTag, { slot });
    e.addComponent(RayInteractable);
    children.push(e);
    return e;
  };
  // The glass lets its press bubble to the frame, so dragging the glass moves the window; a
  // short still press is a tap and steps in (decided in PortalSystem).
  child(win.mask, SLOT.glass);
  // Buttons and the handle act on their own: a press on them must not also drag the window.
  for (const [obj, slot] of [
    [win.enterButton, SLOT.enter],
    [win.exitButton, SLOT.exit],
  ] as const) {
    child(obj, slot).addComponent(HoverFx, { slot: 'world' });
    stopBubbling(obj);
  }
  // The handle is dragged by the grab system; PortalSystem turns its distance from the
  // window centre into the window's scale.
  const handleEntity = child(win.handle, SLOT.resize);
  handleEntity.addComponent(HoverFx, { slot: 'grip' });
  handleEntity.addComponent(DistanceGrabbable, {
    movementMode: MovementMode.MoveFromTarget,
    rotate: false,
    scale: false,
    translate: true,
  });
  stopBubbling(win.handle);

  const head = new Vector3();
  const forward = new Vector3();
  const placement: Placement = { position: new Vector3(), yaw: 0 };
  const placeWindow = (): void => {
    readHead(world, head, forward);
    placeInFrontOfHead(head, forward, OPEN_DISTANCE_M, OPEN_DROP_M, placement);
    win.root.position.copy(placement.position as Vector3);
    win.root.rotation.set(0, placement.yaw, 0);
    win.root.updateMatrixWorld(true);
  };

  const flow = new PortalFlow(bus, services.stage, state.get().mode, {
    onOpen() {
      placeWindow();
      win.root.visible = true;
      if (import.meta.env.DEV) {
        win.syncPlane();
        console.log(
          `[portal] open stage.stencilRef=${services.stage.stencilRef} half=${win.plane.halfWidth.toFixed(2)}x${win.plane.halfHeight.toFixed(2)} scale=${win.scale.toFixed(2)} limits=${config.portal.minScale}-${config.portal.maxScale}`,
        );
      }
    },
    onClose() {
      win.root.visible = false;
      if (import.meta.env.DEV) {
        console.log(`[portal] close stage.stencilRef=${services.stage.stencilRef} reason=${flow.lastEnterReason}`);
      }
    },
  });

  world.registerSystem(PortalSystem);
  const system = world.getSystem(PortalSystem)!;
  const target = { flow, window: win, needsPlacement: false, place: placeWindow };
  system.target = target;
  // The head jumps when a session starts or ends; put the open window back in front of it.
  const replace = (): void => {
    target.needsPlacement = true;
  };
  world.renderer.xr.addEventListener('sessionstart', replace);
  world.renderer.xr.addEventListener('sessionend', replace);

  if (import.meta.env.DEV) {
    const attrs = world.renderer.getContext().getContextAttributes();
    console.log(`[portal] renderer stencil buffer=${attrs?.stencil ?? 'unknown'}`);
    if (PORTAL_DEV_DEMO) runDevDemo(ctx, flow);
  }

  return {
    name: 'portal',
    flow,
    open() {
      flow.requestPortal();
    },
    close() {
      flow.exitToRoom();
    },
    dispose() {
      system.target = null;
      world.renderer.xr.removeEventListener('sessionstart', replace);
      world.renderer.xr.removeEventListener('sessionend', replace);
      world.unregisterSystem(PortalSystem);
      flow.dispose();
      for (const e of children) e.dispose();
      frameEntity.dispose();
      win.dispose();
    },
  };
};
