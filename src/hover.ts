/**
 * Pointer-ray hover for mesh controls (hop arrows, portal buttons, drag grips, zoom knob).
 * Orchestrator-owned. UIKitML elements use `src/ui/hover.ts` instead; both follow the `HOVER`
 * table in `src/theme.ts`.
 *
 * An entity opts in with `RayInteractable` + `HoverFx { slot: <HoverVariant> }`. While it is
 * hovered the system scales its object, shows a child named `hover-outline` if it has one,
 * and tints the materials registered with `setHoverTint`. Event-driven: no per-frame work.
 */
import { Hovered, createSystem } from '@iwsdk/core';
import type { Entity, MeshBasicMaterial, Object3D } from '@iwsdk/core';
import { HOVER, currentTokens, hexNumber, isHoverVariant, onThemeChange } from './theme.js';
import type { TokenName } from './theme.js';
import { HoverFx } from './track-components.js';

export const HOVER_OUTLINE_NAME = 'hover-outline';

interface HoverData {
  materials: MeshBasicMaterial[];
  /** Token the materials show when not hovered. */
  base: TokenName;
  on: boolean;
  scaled: number;
}

const data = new WeakMap<Object3D, HoverData>();

function dataOf(obj: Object3D): HoverData {
  let d = data.get(obj);
  if (!d) {
    d = { materials: [], base: 'textPrimary', on: false, scaled: 1 };
    data.set(obj, d);
  }
  return d;
}

/** The object a HoverFx applies to: a named child when `target` is set, else its own object. */
function objectFor(entity: Entity): Object3D | null {
  const obj = entity.object3D;
  if (!obj) return null;
  const target = entity.getValue(HoverFx, 'target') ?? '';
  return target ? (obj.getObjectByName(target) ?? null) : obj;
}

/**
 * Register the materials a hover should tint, and the token they show at rest. Sets the rest
 * colour now; the system keeps it right across hovers and theme changes.
 */
export function setHoverTint(obj: Object3D, materials: MeshBasicMaterial[], base: TokenName): void {
  const d = dataOf(obj);
  d.materials = materials;
  d.base = base;
  const hex = hexNumber(currentTokens()[base]);
  for (const m of materials) m.color.setHex(hex);
}

function paint(d: HoverData, variant: string): void {
  const t = currentTokens();
  const spec = isHoverVariant(variant) ? HOVER[variant] : HOVER.default;
  const token: TokenName = d.on && spec.fill === 'accent' ? 'accent' : d.on && spec.fill === 'hover' ? 'hover' : d.base;
  const hex = hexNumber(t[token]);
  for (const m of d.materials) m.color.setHex(hex);
}

export class HoverSystem extends createSystem({
  fx: { required: [HoverFx] },
  hovered: { required: [HoverFx, Hovered] },
}) {
  init(): void {
    this.cleanupFuncs.push(
      this.queries.hovered.subscribe('qualify', (entity) => this.apply(entity, true)),
      this.queries.hovered.subscribe('disqualify', (entity) => this.apply(entity, false)),
      onThemeChange(() => {
        for (const entity of this.queries.fx.entities) {
          const obj = objectFor(entity);
          const d = obj ? data.get(obj) : undefined;
          if (d) paint(d, entity.getValue(HoverFx, 'slot') ?? '');
        }
      }),
    );
  }

  private apply(entity: Entity, on: boolean): void {
    const obj = objectFor(entity);
    if (!obj) return; // disposed while hovered
    const variant = entity.getValue(HoverFx, 'slot') ?? '';
    const spec = isHoverVariant(variant) ? HOVER[variant] : HOVER.default;
    const d = dataOf(obj);
    if (d.on === on) return;
    d.on = on;
    // Multiply rather than set: some controls are sized through their scale.
    if (on) {
      d.scaled = spec.scale;
      obj.scale.multiplyScalar(spec.scale);
    } else {
      obj.scale.multiplyScalar(1 / d.scaled);
      d.scaled = 1;
    }
    const outline = obj.getObjectByName(HOVER_OUTLINE_NAME);
    if (outline) outline.visible = on && spec.outline;
    paint(d, variant);
  }
}
