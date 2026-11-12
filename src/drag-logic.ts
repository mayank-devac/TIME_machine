/**
 * Pure maths and memory for draggable panels. No Three.js, no DOM: anything with `x, y, z`
 * (a Three `Vector3` included) is a `Vec3Like`. Tested in `drag-logic.test.ts`.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Where a dropped panel may end up, so it can never be lost. Metres. */
export interface DragLimits {
  /** Horizontal distance from the head. */
  minDist: number;
  maxDist: number;
  /** Height above the floor. */
  minY: number;
  maxY: number;
}

export const DEFAULT_DRAG_LIMITS: Readonly<DragLimits> = { minDist: 0.5, maxDist: 3, minY: 0.3, maxY: 2.2 };

/**
 * Pull `pos` back inside `limits` around `head`. Horizontal distance is clamped along the
 * line from the head; a panel dropped exactly on the head is pushed out toward -Z (north).
 * Writes into `out` (which may be `pos`) and returns it.
 */
export function clampToHead(pos: Vec3Like, head: Vec3Like, limits: DragLimits, out: Vec3Like): Vec3Like {
  let dx = pos.x - head.x;
  let dz = pos.z - head.z;
  let d = Math.hypot(dx, dz);
  const want = Math.min(limits.maxDist, Math.max(limits.minDist, d));
  if (d < 1e-6) {
    dx = 0;
    dz = -1;
    d = 1;
  }
  out.x = head.x + (dx / d) * want;
  out.z = head.z + (dz / d) * want;
  out.y = Math.min(limits.maxY, Math.max(limits.minY, pos.y));
  return out;
}

/**
 * Rotation about +Y that turns an object's +Z (the readable side of a panel) toward `head`.
 * A panel directly above or below the head keeps facing +Z (yaw 0).
 */
export function yawToward(pos: Vec3Like, head: Vec3Like): number {
  const dx = head.x - pos.x;
  const dz = head.z - pos.z;
  return Math.hypot(dx, dz) < 1e-6 ? 0 : Math.atan2(dx, dz);
}

export interface Placement extends Vec3Like {
  yaw: number;
}

/**
 * Where the user left each panel, by panel id. Lives for the page session only: a panel that
 * has an entry is not re-snapped by a recentre, and `clear()` forgets them all (new XR
 * session, desktop recentre key).
 */
export class PanelPlacements {
  private readonly byId = new Map<string, Placement>();

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get(id: string): Readonly<Placement> | undefined {
    return this.byId.get(id);
  }

  /** Remember a placement. Reuses the stored object, so repeated drags do not allocate. */
  set(id: string, pos: Vec3Like, yaw: number): void {
    const p = this.byId.get(id);
    if (p) {
      p.x = pos.x;
      p.y = pos.y;
      p.z = pos.z;
      p.yaw = yaw;
    } else {
      this.byId.set(id, { x: pos.x, y: pos.y, z: pos.z, yaw });
    }
  }

  delete(id: string): void {
    this.byId.delete(id);
  }

  /** Forget every panel whose id starts with `prefix` (a family, e.g. the archive photos). */
  deletePrefix(prefix: string): void {
    for (const id of [...this.byId.keys()]) if (id.startsWith(prefix)) this.byId.delete(id);
  }

  clear(): void {
    this.byId.clear();
  }

  get size(): number {
    return this.byId.size;
  }
}
