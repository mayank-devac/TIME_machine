/**
 * Wrist dial maths. Pure: works on plain `{x, y, z, w}` quaternions so it runs under vitest
 * without Three.js.
 */

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

const TWO_PI = Math.PI * 2;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TWO_PI;
  if (r > Math.PI) r -= TWO_PI;
  else if (r <= -Math.PI) r += TWO_PI;
  return r;
}

/**
 * Signed twist, in radians, of orientation `now` relative to `start`, measured about a
 * fixed WORLD-space unit axis (swing-twist decomposition of `now * start^-1`). The runtime
 * passes the direction the dial hand was pointing when the pinch began, so rolling the wrist
 * counts and swinging the arm does not, whatever axis convention the hand's pose uses.
 * Positive is a right-handed turn about the axis: clockwise for a viewer looking along it.
 * Result is in (-PI, PI].
 */
export function twistAboutAxis(start: QuatLike, now: QuatLike, ax: number, ay: number, az: number): number {
  // rel = now * conj(start), the rotation from `start` to `now` in world space.
  const rx = -now.w * start.x + now.x * start.w - now.y * start.z + now.z * start.y;
  const ry = -now.w * start.y + now.x * start.z + now.y * start.w - now.z * start.x;
  const rz = -now.w * start.z - now.x * start.y + now.y * start.x + now.z * start.w;
  const rw = now.w * start.w + now.x * start.x + now.y * start.y + now.z * start.z;
  const along = rx * ax + ry * ay + rz * az;
  if (along === 0 && rw === 0) return 0; // pure 180 degree swing: twist undefined, call it none
  return wrapAngle(2 * Math.atan2(along, rw));
}

/**
 * Total angle, in radians, of the rotation from `start` to `now` that is NOT twist about the
 * world axis (the swing). Used to notice when the arm has swung so far that twist measured about
 * the pinch-start axis stops meaning "wrist roll". Result is in [0, PI].
 */
export function swingAboutAxis(start: QuatLike, now: QuatLike, ax: number, ay: number, az: number): number {
  const rx = -now.w * start.x + now.x * start.w - now.y * start.z + now.z * start.y;
  const ry = -now.w * start.y + now.x * start.z + now.y * start.w - now.z * start.x;
  const rz = -now.w * start.z - now.x * start.y + now.y * start.x + now.z * start.w;
  const rw = now.w * start.w + now.x * start.x + now.y * start.y + now.z * start.z;
  // Twist part t = (axis * along, rw) normalised; swing = rel * conj(t). Its angle is
  // 2 * acos(|w|), and w of rel * conj(t) is (rw*tw + along*ta) = |twist| magnitude.
  const along = rx * ax + ry * ay + rz * az;
  const tLen = Math.hypot(along, rw);
  if (tLen < 1e-9) return Math.PI;
  const w = Math.min(1, Math.abs(tLen) / Math.hypot(rx, ry, rz, rw));
  return 2 * Math.acos(w);
}

export interface DialFilterOptions {
  /** A frame-to-frame twist change larger than this is a tracking glitch and is ignored, rad. */
  maxJumpRad: number;
  /** Ignore twist for this long after the pinch starts (the pinch itself rolls the wrist), ms. */
  settleMs: number;
}

const DEFAULT_FILTER: DialFilterOptions = { maxJumpRad: Infinity, settleMs: 0 };

/**
 * Turns a continuously changing twist angle into whole detent steps, like a clicking knob.
 * A new step fires only when the angle has moved a full `stepRad` from the last detent, so
 * a hand trembling at a boundary cannot flip the year back and forth. Optional filtering drops
 * single-frame tracking spikes and the wrist roll caused by the pinch gesture itself.
 */
export class DialTracker {
  private anchor = 0;
  private unwrapped = 0;
  private lastRaw = 0;
  private active = false;
  private settleLeftMs = 0;
  /** Frames rejected as tracking glitches since `begin` (diagnostics). */
  glitches = 0;

  constructor(
    private readonly stepRad: number,
    private readonly filter: DialFilterOptions = DEFAULT_FILTER,
  ) {}

  /** True while the dial is still in its post-pinch settle time and ignores twist. */
  get settling(): boolean {
    return this.active && this.settleLeftMs > 0;
  }

  get isActive(): boolean {
    return this.active;
  }

  /** Twist since the last detent, radians. For drawing a dial needle. */
  get offset(): number {
    return this.unwrapped - this.anchor;
  }

  begin(rawAngle = 0): void {
    this.active = true;
    this.lastRaw = rawAngle;
    this.unwrapped = 0;
    this.anchor = 0;
    this.settleLeftMs = this.filter.settleMs;
    this.glitches = 0;
  }

  end(): void {
    this.active = false;
  }

  /**
   * The caller changed its reference orientation (re-anchored the start pose), so the raw
   * angle restarts from `rawAngle`. Progress toward the next detent is kept.
   */
  rebase(rawAngle = 0): void {
    this.lastRaw = rawAngle;
  }

  /**
   * Feed the current twist angle (any range); returns whole steps crossed since last call.
   * `dtMs` drives the settle time; callers without filtering may leave it out.
   */
  update(rawAngle: number, dtMs = 0): number {
    if (!this.active) return 0;
    const change = wrapAngle(rawAngle - this.lastRaw);
    this.lastRaw = rawAngle;
    if (this.settleLeftMs > 0) {
      // Still settling: follow the hand but count none of it.
      this.settleLeftMs -= dtMs;
      return 0;
    }
    if (Math.abs(change) > this.filter.maxJumpRad) {
      this.glitches++;
      return 0;
    }
    this.unwrapped += change;
    const steps = Math.trunc((this.unwrapped - this.anchor) / this.stepRad);
    if (steps === 0) return 0; // also turns Math.trunc's -0 into 0
    this.anchor += steps * this.stepRad;
    return steps;
  }
}

/**
 * Accumulates mouse-wheel travel into year steps. Scrolling down (positive deltaY) goes
 * earlier, so the returned delta is negative for it.
 */
export class WheelAccumulator {
  private travel = 0;

  constructor(private readonly stepPx: number) {}

  add(deltaY: number): void {
    this.travel += deltaY;
  }

  /** Whole year steps gathered since the last call (negative is earlier). */
  take(): number {
    const steps = Math.trunc(this.travel / this.stepPx);
    if (steps !== 0) this.travel -= steps * this.stepPx;
    return steps === 0 ? 0 : -steps;
  }

  reset(): void {
    this.travel = 0;
  }
}
