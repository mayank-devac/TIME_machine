/**
 * Pure portal maths: no Three.js, no DOM, no allocation in the per-frame paths.
 * Anything with `x, y, z` fields (a Three `Vector3` included) is a `Vec3Like`.
 *
 * The window is a rectangle in world space described by `WindowPlane`:
 *  - `origin`  centre of the opening
 *  - `normal`  unit vector pointing to the ROOM side (toward the viewer when placed)
 *  - `right`, `up`  unit vectors in the plane
 *  - `halfWidth`, `halfHeight`  half the opening size, metres
 * The street is on the side opposite `normal`.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface WindowPlane {
  origin: Vec3Like;
  normal: Vec3Like;
  right: Vec3Like;
  up: Vec3Like;
  halfWidth: number;
  halfHeight: number;
}

/** Signed distance from the plane. Positive on the room side, negative on the street side. */
export function signedDistance(plane: WindowPlane, p: Vec3Like): number {
  const n = plane.normal;
  const o = plane.origin;
  return (p.x - o.x) * n.x + (p.y - o.y) * n.y + (p.z - o.z) * n.z;
}

/**
 * Whether the segment a→b passes through the opening (inside the rectangle, shrunk by
 * `inset` metres on every side). Assumes a and b are on opposite sides of the plane.
 */
export function segmentHitsOpening(plane: WindowPlane, a: Vec3Like, b: Vec3Like, inset = 0): boolean {
  const da = signedDistance(plane, a);
  const db = signedDistance(plane, b);
  const denom = da - db;
  if (denom === 0) return false;
  const t = da / denom;
  if (t < 0 || t > 1) return false;
  const o = plane.origin;
  const px = a.x + (b.x - a.x) * t - o.x;
  const py = a.y + (b.y - a.y) * t - o.y;
  const pz = a.z + (b.z - a.z) * t - o.z;
  const u = px * plane.right.x + py * plane.right.y + pz * plane.right.z;
  const v = px * plane.up.x + py * plane.up.y + pz * plane.up.z;
  return Math.abs(u) <= plane.halfWidth - inset && Math.abs(v) <= plane.halfHeight - inset;
}

export interface CrossingOptions {
  /** Must be at least this far on the room side to count as "in the room" (metres). */
  roomMargin: number;
  /** Must be at least this far on the street side to count as "through" (metres). */
  streetDepth: number;
  /** Shrink the opening by this much when checking where the crossing happened (metres). */
  inset: number;
  /**
   * A single-frame move longer than this is not a person walking: it is a recentre (holding
   * the Meta button), tracking lost and found, or a hand appearing from the origin. Such a jump
   * disarms the detector instead of counting as a crossing (metres). Omit for no limit.
   */
  maxJumpM?: number;
}

/**
 * Tracks one point (the head, or one hand) and reports a single crossing from the room
 * side to the street side THROUGH the opening. Going around the frame, or crossing the
 * plane outside the opening, does not count. Hysteresis: the point has to be clearly in
 * the room (`roomMargin`) before a crossing can arm, and clearly through (`streetDepth`)
 * before it fires. Fires once per arming. No allocation per call.
 */
export class CrossingDetector {
  private armed = false;
  private readonly last = { x: 0, y: 0, z: 0 };
  private readonly prev = { x: 0, y: 0, z: 0 };
  private hasPrev = false;

  constructor(private readonly opts: CrossingOptions) {}

  /** Forget history, e.g. after the window was moved or reopened. */
  reset(): void {
    this.armed = false;
    this.hasPrev = false;
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** Feed the latest position. Returns true on the frame the point goes through. */
  update(plane: WindowPlane, p: Vec3Like): boolean {
    const max = this.opts.maxJumpM;
    if (max !== undefined && this.hasPrev) {
      const jump = Math.hypot(p.x - this.prev.x, p.y - this.prev.y, p.z - this.prev.z);
      if (jump > max) this.armed = false; // teleported, not walked: re-arm from the new spot
    }
    this.prev.x = p.x;
    this.prev.y = p.y;
    this.prev.z = p.z;
    this.hasPrev = true;
    const d = signedDistance(plane, p);
    if (d >= this.opts.roomMargin) {
      this.armed = true;
      this.last.x = p.x;
      this.last.y = p.y;
      this.last.z = p.z;
      return false;
    }
    if (!this.armed || d > -this.opts.streetDepth) return false;
    // Clearly on the street side now. Did it get there through the opening?
    this.armed = false;
    return segmentHitsOpening(plane, this.last, p, this.opts.inset);
  }
}

/**
 * Corner-handle resize. The handle started `startDistance` metres from the window centre
 * when the window was at `startScale`; it is now `distance` metres away. The window scales by
 * the same ratio, clamped to [min, max]. A degenerate start keeps the scale.
 */
export function resizeScale(
  startScale: number,
  startDistance: number,
  distance: number,
  min: number,
  max: number,
): number {
  if (!(startDistance > 1e-4) || !Number.isFinite(distance)) return Math.min(max, Math.max(min, startScale));
  return Math.min(max, Math.max(min, (startScale * distance) / startDistance));
}

/** A press on the glass counts as a tap (step in) only if it was short and the window stayed put. */
export const GLASS_TAP_MAX_MS = 400;
export const GLASS_TAP_MAX_MOVE_M = 0.02;

/**
 * Pressing the glass either steps into the street (a tap) or drags the window (a hold and
 * move). `movedM` is how far the window travelled during the press, `heldMs` how long it lasted.
 */
export function isGlassTap(movedM: number, heldMs: number): boolean {
  return movedM <= GLASS_TAP_MAX_MOVE_M && heldMs <= GLASS_TAP_MAX_MS;
}

export interface Placement {
  position: Vec3Like;
  /** Rotation about +Y, radians. At 0 the window's room-side normal points along +Z. */
  yaw: number;
}

/**
 * Where to put the window when it opens: `distance` metres in front of the head along the
 * horizontal view direction, its centre `drop` metres below eye height, facing the head.
 * `forward` is the head's view direction (need not be unit or level). Looking straight up
 * or down falls back to world north (-Z).
 */
export function placeInFrontOfHead(
  head: Vec3Like,
  forward: Vec3Like,
  distance: number,
  drop: number,
  out: Placement,
): Placement {
  let fx = forward.x;
  let fz = forward.z;
  const len = Math.hypot(fx, fz);
  if (len < 1e-4) {
    fx = 0;
    fz = -1;
  } else {
    fx /= len;
    fz /= len;
  }
  out.position.x = head.x + fx * distance;
  out.position.y = head.y - drop;
  out.position.z = head.z + fz * distance;
  // Normal (+Z rotated by yaw) must point back at the head: (sin yaw, cos yaw) = (-fx, -fz).
  out.yaw = Math.atan2(-fx, -fz);
  return out;
}
