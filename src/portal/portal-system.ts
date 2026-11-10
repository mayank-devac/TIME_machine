import { Grabbed, Hovered, Pressed, Vector3, createSystem } from '@iwsdk/core';
import { PortalFrameTag } from '../track-components.js';
import type { PortalFlow } from './portal-flow.js';
import { CrossingDetector } from './portal-logic.js';
import { SLOT } from './portal-window.js';
import type { PortalWindow } from './portal-window.js';

/** Head: must start 10 cm into the room, counts once 5 cm through; 5 cm inset from the frame. */
const HEAD_CROSSING = { roomMargin: 0.1, streetDepth: 0.05, inset: 0.05 };
/** Hand: a deliberate push, 12 cm through the opening; 8 cm inset so holding the frame never fires. */
const HAND_CROSSING = { roomMargin: 0.05, streetDepth: 0.12, inset: 0.08 };

/** What the system drives. Set by `entry.ts` right after registration. */
export interface PortalSystemTarget {
  flow: PortalFlow;
  window: PortalWindow;
}

/**
 * Per frame, while the portal is open: watches the head and both index tips (controllers
 * fall back to their ray pose) for a crossing through the opening, and turns button
 * presses into intents. Ignores crossings while the frame is held, because dragging the
 * window over yourself is not stepping through it.
 */
export class PortalSystem extends createSystem({
  parts: { required: [PortalFrameTag] },
  pressed: { required: [PortalFrameTag, Pressed] },
  hovered: { required: [PortalFrameTag, Hovered] },
  grabbed: { required: [PortalFrameTag, Grabbed] },
}) {
  target: PortalSystemTarget | null = null;

  private head!: Vector3;
  private hand!: Vector3;
  private headDetector!: CrossingDetector;
  private handDetectors!: [CrossingDetector, CrossingDetector];
  private wasOpen = false;

  init(): void {
    this.head = new Vector3();
    this.hand = new Vector3();
    this.headDetector = new CrossingDetector(HEAD_CROSSING);
    this.handDetectors = [new CrossingDetector(HAND_CROSSING), new CrossingDetector(HAND_CROSSING)];

    this.cleanupFuncs.push(
      this.queries.pressed.subscribe('qualify', (entity) => {
        const t = this.target;
        if (!t) return;
        const slot = entity.getValue(PortalFrameTag, 'slot');
        if (slot === SLOT.enter || slot === SLOT.glass) t.flow.enterStreet('press');
        else if (slot === SLOT.exit) t.flow.exitToRoom();
      }),
      this.queries.hovered.subscribe('qualify', (entity) => {
        const slot = entity.getValue(PortalFrameTag, 'slot');
        if (slot === SLOT.enter || slot === SLOT.exit) this.target?.window.setHighlight(entity.object3D!, true);
      }),
      this.queries.hovered.subscribe('disqualify', (entity) => {
        if (entity.object3D) this.target?.window.setHighlight(entity.object3D, false);
      }),
      // After a move, require a fresh start on the room side before anything counts.
      this.queries.grabbed.subscribe('disqualify', () => this.resetDetectors()),
    );
  }

  private resetDetectors(): void {
    this.headDetector.reset();
    this.handDetectors[0].reset();
    this.handDetectors[1].reset();
  }

  update(): void {
    const t = this.target;
    const open = !!t && t.flow.isOpen;
    if (open !== this.wasOpen) {
      this.wasOpen = open;
      this.resetDetectors();
    }
    if (!open || !t || this.queries.grabbed.entities.size > 0) return;

    t.window.syncPlane();
    const plane = t.window.plane;

    this.world.camera.getWorldPosition(this.head);
    if (this.headDetector.update(plane, this.head)) {
      t.flow.enterStreet('head');
      return;
    }

    // Hands only exist inside a session; outside one the spaces sit at the origin.
    if (!this.world.session) return;
    const tips = this.player.indexTipSpaces;
    tips.left.getWorldPosition(this.hand);
    if (this.handDetectors[0].update(plane, this.hand)) {
      t.flow.enterStreet('hand');
      return;
    }
    tips.right.getWorldPosition(this.hand);
    if (this.handDetectors[1].update(plane, this.hand)) t.flow.enterStreet('hand');
  }
}
