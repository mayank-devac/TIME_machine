import {
  CircleGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  RayInteractable,
  Shape,
  ShapeGeometry,
} from '@iwsdk/core';
import type { Entity, Object3D, World } from '@iwsdk/core';
import type { Pano } from '../contracts.js';
import { setHoverTint } from '../hover.js';
import { currentTokens, hexNumber, onThemeChange } from '../theme.js';
import { HoverFx, PanoSphereTag } from '../track-components.js';
import { dirOfBearing } from './pano-math.js';

/** At most this many arrows; a pool, so hops never create or free entities. */
export const MAX_ARROWS = 4;
/** Two arrows closer than this (degrees) collapse into the nearer one. */
export const ARROW_MIN_SEPARATION_DEG = 35;
/** Horizontal distance from the viewer's feet to each arrow, metres. */
const ARROW_DISTANCE_M = 1.6;
/** Arrows lie just above the floor (local-floor y = 0 in XR, y = 0 on desktop). */
const ARROW_FLOOR_Y = 0.02;

interface ArrowSlot {
  entity: Entity;
  group: Group;
  chevronMat: MeshBasicMaterial;
  discMat: MeshBasicMaterial;
  target: Pano | null;
  bearing: number;
}

function chevronShape(): Shape {
  // Points toward local -Z once laid flat (shape +Y becomes world -Z after rotation.x = -PI/2).
  const s = new Shape();
  s.moveTo(0, 0.2);
  s.lineTo(0.17, 0.0);
  s.lineTo(0.1, 0.0);
  s.lineTo(0, 0.11);
  s.lineTo(-0.1, 0.0);
  s.lineTo(-0.17, 0.0);
  s.closePath();
  return s;
}

/**
 * Floor markers toward neighbouring panoramas. Selectable with the ray input
 * (`RayInteractable`, controller ray or desktop mouse). Picking one calls `onPick`.
 * Hover is the shared `world` variant (`HoverFx`): the marker grows and its chevron takes
 * the `hover` colour.
 */
export class HopArrows {
  readonly container: Group;
  private readonly containerEntity: Entity;
  private readonly slots: ArrowSlot[] = [];
  private shown = false;
  private readonly offTheme: () => void;

  constructor(
    world: World,
    parent: Entity,
    private readonly onPick: (pano: Pano) => void,
  ) {
    this.container = new Group();
    this.container.name = 'PanoHopArrows';
    this.container.visible = false;
    this.containerEntity = world.createTransformEntity(this.container, {
      parent,
      persistent: true,
    });

    const chevronGeo = new ShapeGeometry(chevronShape());
    chevronGeo.rotateX(-Math.PI / 2);
    chevronGeo.translate(0, 0.005, 0.05);
    const discGeo = new CircleGeometry(0.28, 32);
    discGeo.rotateX(-Math.PI / 2);

    for (let i = 0; i < MAX_ARROWS; i++) {
      const group = new Group();
      group.name = `PanoHopArrow${i}`;
      const discMat = new MeshBasicMaterial({
        color: hexNumber(currentTokens().background),
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        side: DoubleSide,
      });
      const chevronMat = new MeshBasicMaterial({
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: DoubleSide,
      });
      const disc = new Mesh(discGeo, discMat);
      const chevron = new Mesh(chevronGeo, chevronMat);
      disc.renderOrder = 10;
      chevron.renderOrder = 11;
      group.add(disc, chevron);
      group.visible = false;
      const entity = world.createTransformEntity(group, {
        parent: this.containerEntity,
        persistent: true,
      });
      entity.addComponent(PanoSphereTag, { slot: 'arrow', value: i });
      entity.addComponent(RayInteractable);
      entity.addComponent(HoverFx, { slot: 'world' });
      setHoverTint(group, [chevronMat], 'textPrimary');
      const slot: ArrowSlot = { entity, group, chevronMat, discMat, target: null, bearing: 0 };
      const obj = group as Object3D & {
        addEventListener(type: string, fn: (e: unknown) => void): void;
      };
      obj.addEventListener('click', () => {
        if (this.shown && slot.group.visible && slot.target) this.onPick(slot.target);
      });
      this.slots.push(slot);
    }
    this.offTheme = onThemeChange((t) => {
      for (const slot of this.slots) slot.discMat.color.setHex(hexNumber(t.background));
    });
  }

  /** Point the pool at a new set of targets (nearest first, already de-duplicated). */
  setTargets(targets: ReadonlyArray<{ target: Pano; bearing: number }>): void {
    this.slots.forEach((slot, i) => {
      const t = targets[i];
      slot.target = t?.target ?? null;
      slot.bearing = t?.bearing ?? 0;
      slot.group.visible = !!t;
      if (!t) return;
      const d = dirOfBearing(t.bearing);
      slot.group.position.set(d.x * ARROW_DISTANCE_M, 0, d.z * ARROW_DISTANCE_M);
      // Local -Z is the chevron's tip; rotating by -bearing about Y turns -Z toward the bearing.
      slot.group.rotation.set(0, (-t.bearing * Math.PI) / 180, 0);
    });
  }

  clear(): void {
    this.setTargets([]);
  }

  setShown(shown: boolean): void {
    if (this.shown === shown) return;
    this.shown = shown;
    this.container.visible = shown;
  }

  /** Keep the ring centred under the viewer. Called once per frame. */
  follow(x: number, z: number): void {
    this.container.position.set(x, ARROW_FLOOR_Y, z);
    this.container.updateMatrixWorld(true);
  }

  /** Snapshot for dev logging. */
  describe(): Array<{ id: string; bearing: number; visible: boolean }> {
    return this.slots
      .filter((s) => s.target)
      .map((s) => ({
        id: s.target!.id,
        bearing: Math.round(s.bearing),
        visible: this.shown && s.group.visible,
      }));
  }

  dispose(): void {
    this.offTheme();
    for (const slot of this.slots) slot.entity.dispose();
    this.containerEntity.dispose();
  }
}
