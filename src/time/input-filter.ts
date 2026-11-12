/**
 * Input noise filters for real hand tracking. Pure: no Three.js, no allocation per call.
 *
 * Why: emulator input is clean, real input is not. A tracked-hand pinch flickers on and off for
 * a frame or two as the fingertips touch, and drops out briefly when the hand is partly hidden.
 * Without a filter that flicker resets the push-hold timer, retracts a push mid-way, or ends and
 * restarts the wrist dial (re-zeroing its angle, which can skip a year).
 */

export interface DebounceTiming {
  /** The raw signal must stay on this long before the filtered signal turns on, ms. */
  onMs: number;
  /** The raw signal must stay off this long before the filtered signal turns off, ms. */
  offMs: number;
}

/**
 * Time-based press filter with separate on and off delays. A press shorter than `onMs` never
 * registers; a dropout shorter than `offMs` is bridged. With both delays 0 it is a pass-through.
 */
export class PressDebouncer {
  private state = false;
  private pendingMs = 0;

  get value(): boolean {
    return this.state;
  }

  /** Feed the raw state for this frame. Returns the filtered state. */
  update(raw: boolean, dtMs: number, timing: DebounceTiming): boolean {
    if (raw === this.state) {
      this.pendingMs = 0;
      return this.state;
    }
    this.pendingMs += dtMs;
    if (this.pendingMs >= (raw ? timing.onMs : timing.offMs)) {
      this.state = raw;
      this.pendingMs = 0;
    }
    return this.state;
  }

  /** Force off at once (session ended, input source lost for good). */
  reset(): void {
    this.state = false;
    this.pendingMs = 0;
  }
}

/** Debounce timings by input kind. Controllers have a clean trigger; hands do not. */
export const CONTROLLER_PRESS: DebounceTiming = { onMs: 0, offMs: 0 };
export const HAND_PRESS: DebounceTiming = { onMs: 35, offMs: 110 };
