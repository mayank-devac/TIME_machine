/**
 * Lens direction maths. Pure and allocation-free: every function writes into an `out`
 * argument. Types are structural so Three's Vector3 fits and vitest needs no Three.js.
 *
 * World space (see `src/contracts.ts`): north is -Z, east +X, up +Y.
 */

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

const EPS = 1e-6;

export function normalize(v: Vec3Like): number {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len > EPS) {
    v.x /= len;
    v.y /= len;
    v.z /= len;
  }
  return len;
}

/**
 * Unit vector from the head toward the hand. When the two coincide (untracked hand reported
 * at the head), copies `fallback` instead. Returns false when the fallback was used.
 */
export function directionBetween(head: Vec3Like, hand: Vec3Like, fallback: Vec3Like, out: Vec3Like): boolean {
  out.x = hand.x - head.x;
  out.y = hand.y - head.y;
  out.z = hand.z - head.z;
  if (normalize(out) > EPS) return true;
  out.x = fallback.x;
  out.y = fallback.y;
  out.z = fallback.z;
  return false;
}

/**
 * World-space view direction through a point on screen, for the desktop mouse lens.
 * `ndcX`, `ndcY` are in [-1, 1] (right and up positive). `projection` and `cameraWorld` are
 * the camera's `projectionMatrix.elements` and `matrixWorld.elements` (column-major).
 */
export function ndcToDirection(
  ndcX: number,
  ndcY: number,
  projection: ArrayLike<number>,
  cameraWorld: ArrayLike<number>,
  out: Vec3Like,
): void {
  // Camera-space ray for a symmetric perspective projection: x/m00, y/m11, -1.
  const cx = ndcX / projection[0];
  const cy = ndcY / projection[5];
  const cz = -1;
  out.x = cameraWorld[0] * cx + cameraWorld[4] * cy + cameraWorld[8] * cz;
  out.y = cameraWorld[1] * cx + cameraWorld[5] * cy + cameraWorld[9] * cz;
  out.z = cameraWorld[2] * cx + cameraWorld[6] * cy + cameraWorld[10] * cz;
  normalize(out);
}

/** Pointer position in client pixels to NDC. A zero-sized element maps to the centre. */
export function clientToNdcX(clientX: number, left: number, width: number): number {
  return width > 0 ? ((clientX - left) / width) * 2 - 1 : 0;
}

export function clientToNdcY(clientY: number, top: number, height: number): number {
  return height > 0 ? 1 - ((clientY - top) / height) * 2 : 0;
}

/**
 * Move unit vector `current` toward unit vector `target` by `alpha` (0 to 1) and
 * re-normalise. Used as a low-pass filter on hand jitter. Opposite vectors snap to target.
 */
export function smoothDirection(current: Vec3Like, target: Vec3Like, alpha: number): void {
  current.x += (target.x - current.x) * alpha;
  current.y += (target.y - current.y) * alpha;
  current.z += (target.z - current.z) * alpha;
  if (normalize(current) <= EPS) {
    current.x = target.x;
    current.y = target.y;
    current.z = target.z;
  }
}

/** Filter weight for a frame of `dtMs` and a time constant of `tauMs`. */
export function smoothingAlpha(dtMs: number, tauMs: number): number {
  return tauMs <= 0 ? 1 : 1 - Math.exp(-dtMs / tauMs);
}

export function angleBetween(a: Vec3Like, b: Vec3Like): number {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z;
  return Math.acos(dot < -1 ? -1 : dot > 1 ? 1 : dot);
}

/** Compass azimuth of a direction, degrees clockwise from north (-Z), in [0, 360). */
export function azimuthDeg(d: Vec3Like): number {
  const deg = (Math.atan2(d.x, -d.z) * 180) / Math.PI;
  return (deg + 360) % 360;
}
