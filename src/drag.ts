/**
 * Draggable panels. Orchestrator-owned; used by the HUD, the map table and the archive frames.
 *
 * A `DragRig` is a Group entity that can be grabbed with a ray (controller trigger, hand
 * pinch, desktop mouse) through IWSDK's `DistanceGrabbable`. It carries a small grip bar; the
 * panel itself is added as a child entity by the caller and marked with `stopBubbling`, so
 * pressing the panel's own buttons never starts a grab.
 *
 * When a rig is let go, `DragSystem` clamps it to a reachable range around the head, turns it
 * to face the head (a snap of the panel, never of the camera) and remembers where it is in
 * `placements` for the rest of the page session.
 */
import {
  CapsuleGeometry,
  DistanceGrabbable,
  Grabbed,
  Group,
  Mesh,
  MeshBasicMaterial,
  MovementMode,
  RayInteractable,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity, Object3D, World } from '@iwsdk/core';
import { DEFAULT_DRAG_LIMITS, PanelPlacements, clampToHead, yawToward } from './drag-logic.js';
import type { DragLimits } from './drag-logic.js';
import { readHead } from './head.js';
import { setHoverTint } from './hover.js';
import { currentTokens, hexNumber, onThemeChange } from './theme.js';
import { DragGrip, HoverFx } from './track-components.js';

/** Where the user left each panel this session. */
export const placements = new PanelPlacements();

const GRIP_WIDTH_M = 0.16;
const GRIP_HEIGHT_M = 0.022;
const GRIP_DEPTH_M = 0.012;

/** Stops a press on `obj` (or anything inside it) from bubbling up and starting a grab. */
export function stopBubbling(obj: Object3D): void {
  (obj as unknown as { addEventListener(t: string, f: (e: { stopPropagation(): void }) => void): void })
    .addEventListener('pointerdown', (e) => e.stopPropagation());
}

export interface DragRigOptions {
  /** Panel id: the key in `placements`, and the `DragGrip.slot` value. */
  id: string;
  /** False for things that are grabbed by their own body (archive photos): no grip bar. */
  grip?: boolean;
  /** Width of the grip bar, metres. */
  gripWidthM?: number;
  /** Height of the grip bar, metres. A grip seen from above (the table's) wants to be taller. */
  gripHeightM?: number;
  /** Turn to face the head when dropped. False for things with a fixed heading (the map table). */
  faceHead?: boolean;
  limits?: Partial<DragLimits>;
  /** Called after a drop has been clamped, turned and remembered. */
  onSettled?: () => void;
}

const rigs = new Map<Entity, DragRig>();

export class DragRig {
  readonly id: string;
  readonly root = new Group();
  readonly entity: Entity;
  /** The grip bar (hidden and inert when the rig was made with `grip: false`). */
  readonly grip: Mesh;
  private readonly gripEntity: Entity | null;
  private readonly gripMaterial: MeshBasicMaterial;
  private readonly limits: DragLimits;
  private readonly faceHead: boolean;
  private readonly onSettled: (() => void) | undefined;
  private readonly offTheme: () => void;

  constructor(world: World, opts: DragRigOptions) {
    this.id = opts.id;
    this.faceHead = opts.faceHead ?? true;
    this.limits = { ...DEFAULT_DRAG_LIMITS, ...opts.limits };
    this.onSettled = opts.onSettled;

    this.root.name = `DragRig-${opts.id}`;
    this.entity = world.createTransformEntity(this.root, { persistent: true });
    this.entity.addComponent(DragGrip, { slot: opts.id });

    this.gripMaterial = new MeshBasicMaterial({ color: hexNumber(currentTokens().border), toneMapped: false });
    // The grip is a capsule: a rod with rounded ends, lying along its width (X). Squashing Z
    // keeps the shallow depth, so a grip keeps the footprint the placement maths expect —
    // only the shape reads rounded instead of boxy.
    const heightM = opts.gripHeightM ?? GRIP_HEIGHT_M;
    const widthM = opts.gripWidthM ?? GRIP_WIDTH_M;
    this.grip = new Mesh(new CapsuleGeometry(heightM / 2, Math.max(0, widthM - heightM), 4, 16), this.gripMaterial);
    this.grip.rotation.z = Math.PI / 2; // the capsule's own axis (Y) becomes the bar's length (X)
    this.grip.scale.z = GRIP_DEPTH_M / heightM;
    this.grip.name = `DragGrip-${opts.id}`;
    setHoverTint(this.grip, [this.gripMaterial], 'border');
    if (opts.grip === false) {
      this.gripEntity = null;
    } else {
      this.gripEntity = world.createTransformEntity(this.grip, { parent: this.entity, persistent: true });
      // The press must land on the rig itself. A RayInteractable on the grip would let
      // InputSystem's own pointerdown handler stopPropagation at the grip, so the press
      // never bubbles up to the rig's DistanceGrabbable and the grab never starts.
      // The grip's hover feedback is proxied through the rig instead (HoverFx.target).
      this.entity.addComponent(HoverFx, { slot: 'grip', target: this.grip.name });
      this.arm();
    }

    this.offTheme = onThemeChange((t) => this.gripMaterial.color.setHex(hexNumber(t.border)));
    rigs.set(this.entity, this);
  }

  /**
   * Make the rig grabbable. IWSDK needs a mesh under the rig when the grab component is
   * added, so this runs after the grip exists; a rig without a grip is armed by its owner
   * once the content mesh has been added as a child.
   */
  arm(): void {
    if (this.entity.hasComponent(DistanceGrabbable)) return;
    this.entity.addComponent(RayInteractable);
    this.entity.addComponent(DistanceGrabbable, {
      movementMode: MovementMode.MoveFromTarget,
      translate: true,
      rotate: false,
      scale: false,
    });
  }

  /** Put the grip bar somewhere on the rig (rig-local metres), e.g. under the panel. */
  placeGrip(x: number, y: number, z: number): void {
    this.grip.position.set(x, y, z);
  }

  /** Clamp to the reachable range, face the head, remember. Called when the grab ends. */
  settle(head: Vector3): void {
    const p = this.root.position;
    clampToHead(p, head, this.limits, p);
    // Same facing a recentre gives: +Z (the readable side) straight at the head, so a low
    // panel tilts up toward the eyes.
    if (this.faceHead) this.root.lookAt(head);
    this.root.updateMatrixWorld(true);
    placements.set(this.id, p, yawToward(p, head));
    this.onSettled?.();
  }

  dispose(): void {
    rigs.delete(this.entity);
    this.offTheme();
    this.gripEntity?.dispose();
    this.entity.dispose();
    this.grip.geometry.dispose();
    this.gripMaterial.dispose();
  }
}

/** Settles a rig on the frame its grab ends. No per-frame work. */
export class DragSystem extends createSystem({
  held: { required: [DragGrip, Grabbed] },
}) {
  private head!: Vector3;

  init(): void {
    this.head = new Vector3();
    this.cleanupFuncs.push(
      this.queries.held.subscribe('disqualify', (entity) => {
        const rig = rigs.get(entity);
        if (!rig) return; // disposed while held
        readHead(this.world, this.head);
        rig.settle(this.head);
      }),
    );
  }
}
