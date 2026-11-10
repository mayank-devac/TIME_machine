/** Timing curves for the lens. Pure functions of time; no state. */

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

/** Fraction of the opening taken by the grow; the rest is the ripple settling. */
const GROW_PART = 0.45;
const RIPPLE_CYCLES = 2.5;

/**
 * Lens radius while it opens. Grows from 0 to `radius`, then the edge ripples: a damped
 * wobble of at most `maxWobble` radians that has died out by `rippleMs`. Lands exactly on
 * `radius`.
 */
export function openRadius(elapsedMs: number, radius: number, rippleMs: number, maxWobble: number): number {
  const u = clamp01(elapsedMs / rippleMs);
  if (u >= 1) return radius;
  const grow = easeOutCubic(u / GROW_PART);
  const decay = (1 - u) * (1 - u);
  const wobble = maxWobble * Math.sin(u * Math.PI * 2 * RIPPLE_CYCLES) * decay * grow;
  return Math.max(0, radius * grow + wobble);
}

/** Lens radius during push-through: `startRadius` at t = 0, exactly PI at t = 1. */
export function pushRadius(t: number, startRadius: number): number {
  return startRadius + (Math.PI - startRadius) * easeInOutCubic(t);
}

/** Lens radius while closing: `startRadius` down to 0. */
export function closeRadius(t: number, startRadius: number): number {
  return startRadius * (1 - easeOutCubic(t));
}

/** Rim glow strength: full on the hand-sized lens, gone by the time the past surrounds you. */
export function rimOpacity(radius: number, fadeStart: number): number {
  return 1 - smoothstep(fadeStart, Math.PI, radius);
}
