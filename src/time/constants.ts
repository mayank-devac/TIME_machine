/**
 * Track C tuning values that are NOT in `src/config.ts`. Lens radius, feather, ripple and
 * push-through durations and the distortion cap come from `config.lens.*`; never copy them
 * here. Everything below is UNTESTED on a headset.
 */
export const TIME = {
  /** Which hand carries the lens, and which one is the wrist dial. */
  lensHand: 'right',
  dialHand: 'left',

  /** Wrist twist needed for one year step, radians (about 25 degrees). */
  dialStepRad: (25 * Math.PI) / 180,
  /**
   * Sign that turns a twist into a year delta. The twist is measured right-handed about the
   * direction the dial hand points (away from the user), so a clockwise turn, as the user
   * sees it, is positive, and clockwise means "later".
   */
  dialDirection: 1,

  /** Wrist dial face: diameter, and how far above the dial hand it floats, metres. */
  dialSizeM: 0.09,
  dialLiftM: 0.09,

  /** A pinch or trigger must be held this long before push-through starts (ignores taps). */
  pushHoldMs: 300,
  /** Letting go mid-push shrinks the lens back this many times faster than it grew. */
  retractSpeed: 2,
  /** Lens shrink time when TIME MACHINE is switched off. */
  closeMs: 250,

  /** Minimum gap between two "no more imagery" messages while the user keeps pushing. */
  limitMessageGapSec: 2,

  /** Mouse wheel travel (deltaY units) for one year step. One notch is about 100. */
  wheelStepPx: 100,

  /** Time constant of the lens-direction low-pass filter, ms. Hides hand jitter. */
  directionSmoothingMs: 45,

  /** Rim band: how far the glow reaches inside and outside the mask edge, radians. */
  rimInnerRad: 0.035,
  rimOuterRad: 0.16,
  /** Rim opacity fades from this lens radius up to PI during push-through. */
  rimFadeStartRad: 1.1,
  /** Distance of the rim band from the head, as a fraction of the stage sphere radius. */
  rimDistanceFactor: 0.8,
  rimSegments: 96,
} as const;
