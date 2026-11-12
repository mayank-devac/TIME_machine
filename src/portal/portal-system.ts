import { Grabbed, Pressed, Vector3, createSystem } from '@iwsdk/core';
import type { Entity } from '@iwsdk/core';
import { config } from '../config.js';
import { readHead } from '../head.js';
import { PortalFrameTag } from '../track-components.js';
import type { PortalFlow } from './portal-flow.js';
import { CrossingDetector, isGlassTap, resizeScale } from './portal-logic.js';
import { SLOT } from './portal-window.js';
import type { PortalWindow } from './portal-window.js';

/** Head: must start 10 cm into the room, counts once 5 cm through; 5 cm inset from the frame. */
// maxJumpM: a recentre or tracking loss moves the head or hand far in one frame. A walking head
// moves ~2 cm a frame and a quick hand ~5 cm; the limits allow a long frame hitch on top.
const HEAD_CROSSING = { roomMargin: 0.1, streetDepth: 0.05, inset: 0.05, maxJumpM: 0.4 };
/** Hand: a deliberate push, 12 cm through the opening; 8 cm inset so holding the frame never fires. */
const HAND_CROSSING = { roomMargin: 0.05, streetDepth: 0.12, inset: 0.08, maxJumpM: 0.5 };

/** What the system drives. Set by `entry.ts` right after registration. */
export interface PortalSystemTarget {
  flow: PortalFlow;
  window: PortalWindow;
  /** Set true to re-place the window in front of the head on the next frame (session start). */
  needsPlacement: boolean;
  place(): void;
}

/**
 * Per frame, while the portal is open:
 *  - watches the head and both index tips (controllers fall back to their ray pose) for a
 *    crossing through the opening;
 *  - turns button presses into intents, and a short still press on the glass into "step in"
 *    (a longer press or a moving one is a drag of the window, handled by the grab system);
 *  - while the corner handle is held, resizes the window from the handle's distance to the
 *    window centre.
 * Crossings are ignored while any part is held, because dragging or resizing the window over
 * yourself is not stepping through it. Button hover is the shared `HoverSystem`.
 */
export class PortalSystem extends createSystem({
  parts: { required: [PortalFrameTag] },
  pressed: { required: [PortalFrameTag, Pressed] },
  grabbed: { required: [PortalFrameTag, Grabbed] },
}) {
  target: PortalSystemTarget | null = null;

  private head!: Vector3;
  private hand!: Vector3;
  private centre!: Vector3;
  private glassStart!: Vector3;
  private headDetector!: CrossingDetector;
  private handDetectors!: [CrossingDetector, CrossingDetector];
  private wasOpen = false;
  private glassPressedAt = 0;
  private resizing = false;
  private resizeStartScale = 1;
  private resizeStartDistance = 0;

  init(): void {
    this.head = new Vector3();
    this.hand = new Vector3();
    this.centre = new Vector3();
    this.glassStart = new Vector3();
    this.headDetector = new CrossingDetector(HEAD_CROSSING);
    this.handDetectors = [new CrossingDetector(HAND_CROSSING), new CrossingDetector(HAND_CROSSING)];

    this.cleanupFuncs.push(
      this.queries.pressed.subscribe('qualify', (entity) => {
        const t = this.target;
        if (!t) return;
        const slot = entity.getValue(PortalFrameTag, 'slot');
        if (slot === SLOT.enter) t.flow.enterStreet('press');
        else if (slot === SLOT.exit) t.flow.exitToRoom();
        else if (slot === SLOT.glass) {
          // Might be a tap or the start of a drag; decided when the press ends.
          this.glassPressedAt = performance.now();
          t.window.root.getWorldPosition(this.glassStart);
        }
      }),
      this.queries.pressed.subscribe('disqualify', (entity) => {
        const t = this.target;
        if (!t || !entity.hasComponent(PortalFrameTag) || entity.getValue(PortalFrameTag, 'slot') !== SLOT.glass) return;
        t.window.root.getWorldPosition(this.centre);
        if (isGlassTap(this.centre.distanceTo(this.glassStart), performance.now() - this.glassPressedAt)) {
          t.flow.enterStreet('press');
        }
      }),
      this.queries.grabbed.subscribe('qualify', (entity) => {
        if (this.isHandle(entity)) this.beginResize(entity);
      }),
      this.queries.grabbed.subscribe('disqualify', (entity) => {
        if (this.resizing && this.isHandle(entity)) {
          this.resizing = false;
          this.target?.window.restHandle();
        }
        // After a move or a resize, require a fresh start on the room side before anything counts.
        this.resetDetectors();
      }),
    );
  }

  private isHandle(entity: Entity): boolean {
    return entity.hasComponent(PortalFrameTag) && entity.getValue(PortalFrameTag, 'slot') === SLOT.resize;
  }

  private beginResize(entity: Entity): void {
    const t = this.target;
    const handle = entity.object3D;
    if (!t || !handle) return;
    t.window.root.getWorldPosition(this.centre);
    handle.getWorldPosition(this.hand);
    this.resizeStartScale = t.window.scale;
    this.resizeStartDistance = this.hand.distanceTo(this.centre);
    this.resizing = true;
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
      this.resizing = false;
      t?.window.restHandle();
      this.resetDetectors();
    }
    if (!open || !t) return;

    if (this.resizing) {
      // The grab system moves the handle with the ray; the window follows its distance.
      const win = t.window;
      win.root.getWorldPosition(this.centre);
      win.handle.getWorldPosition(this.hand);
      const scale = resizeScale(
        this.resizeStartScale,
        this.resizeStartDistance,
        this.hand.distanceTo(this.centre),
        config.portal.minScale,
        config.portal.maxScale,
      );
      if (scale !== win.scale) win.setScale(scale);
    }

    readHead(this.world, this.head);
    // The open window always faces the viewer, including while it is being dragged: it turns
    // about Y (staying upright) so its readable side and the street behind it are presented
    // from wherever the head is. The grab is translate-only, so it never fights this.
    const at = t.window.root.position;
    t.window.root.rotation.set(0, Math.atan2(this.head.x - at.x, this.head.z - at.z), 0);
    t.window.root.updateMatrixWorld(true);

    if (this.queries.grabbed.entities.size > 0) return;

    if (t.needsPlacement) {
      t.needsPlacement = false;
      t.place();
      this.resetDetectors();
      readHead(this.world, this.head);
    }

    t.window.syncPlane();
    const plane = t.window.plane;

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
