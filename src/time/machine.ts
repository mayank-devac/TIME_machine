/**
 * The lens state machine. Pure logic: no Three.js, no bus, no stage. The runtime
 * (`time-machine.ts`) feeds it inputs and applies what it says.
 *
 *   off -> opening -> open <-> dialling
 *                      |  ^
 *            (hold)    v  | (let go early: lens shrinks back)
 *                    pushing -> committed -> off
 *   any active phase -> closing -> off      (TIME MACHINE switched off)
 */
import { closeRadius, openRadius, pushRadius } from './curves.js';
import { buildLadder, defaultYear, isPanoYear, stepYear } from './years.js';

export type LensPhase = 'off' | 'opening' | 'open' | 'dialling' | 'pushing' | 'committed' | 'closing';

/** What `update` reports back, at most one per call. */
export type LensSignal = 'none' | 'commit' | 'closed';

export interface LensTuning {
  radius: number;
  openRippleMs: number;
  pushThroughMs: number;
  maxDistortion: number;
  pushHoldMs: number;
  retractSpeed: number;
  closeMs: number;
}

export class LensMachine {
  phase: LensPhase = 'off';
  /** Year on the dial, or null while the lens is off. */
  year: number | null = null;
  /** Angular radius to give the stage this frame. */
  radius = 0;
  /** 0 to 1 through the push. */
  pushT = 0;
  /** 0 to 1 through the opening ripple; 1 once open. Drives the rim's ripple rings. */
  ripple = 1;
  /** The user wants the lens (TIME MACHINE is on), whether or not it could open yet. */
  wantOn = false;
  /** Set by the runtime: the past panorama for `year` is loaded, so pushing is allowed. */
  pastReady = false;

  private panoYears: number[] = [];
  private ladder: number[] = [];
  private currentYear: number | null = null;
  private phaseMs = 0;
  private holdMs = 0;
  private closeFrom = 0;
  /** After a push ends, the hold must be released before another can start. */
  private needRelease = false;

  constructor(private readonly t: LensTuning) {}

  get isActive(): boolean {
    return this.phase !== 'off' && this.phase !== 'committed';
  }

  /** True while the lens should follow the hand. Frozen during push-through for comfort. */
  get followsHand(): boolean {
    return this.phase !== 'pushing' && this.phase !== 'committed';
  }

  /** The dialled year has a panorama (false only when off). */
  get yearHasPano(): boolean {
    return isPanoYear(this.panoYears, this.year);
  }

  get years(): readonly number[] {
    return this.ladder;
  }

  /**
   * New panorama on screen: `panoYears` are the years with imagery here, `currentYear` the
   * one being shown. Returns true when this opened the lens (the user had already asked).
   */
  setYears(panoYears: readonly number[], currentYear: number | null): boolean {
    this.panoYears = [...panoYears];
    this.currentYear = currentYear;
    this.ladder = buildLadder(panoYears, currentYear);
    if (this.isActive && (this.year === null || !this.ladder.includes(this.year))) this.reset();
    return this.tryOpen();
  }

  /** Forget the years (a new panorama is loading). Closes the lens at once, keeps `wantOn`. */
  clearYears(): void {
    this.panoYears = [];
    this.ladder = [];
    this.currentYear = null;
    this.reset();
  }

  /** TIME MACHINE button. Returns true when the lens opened as a result. */
  toggle(on: boolean): boolean {
    this.wantOn = on;
    if (on) return this.tryOpen();
    if (this.isActive) {
      this.closeFrom = this.radius;
      this.enter('closing');
    }
    return false;
  }

  /** Drop to `off` immediately, with no animation (mode change, new panorama). */
  reset(): void {
    this.phase = 'off';
    this.year = null;
    this.radius = 0;
    this.pushT = 0;
    this.ripple = 1;
    this.pastReady = false;
    this.holdMs = 0;
    this.phaseMs = 0;
  }

  /**
   * Set by `step`/`jumpTo` when the dial hit an end of the ladder: the direction it tried to
   * go and the year it is stuck on. Cleared by the next successful move.
   */
  blocked: { direction: 'earlier' | 'later'; edgeYear: number } | null = null;

  private get canDial(): boolean {
    return this.phase === 'opening' || this.phase === 'open' || this.phase === 'dialling';
  }

  /** Dial input: move `delta` stops (negative is earlier). Returns true if the year changed. */
  step(delta: number): boolean {
    if (delta === 0 || this.year === null || !this.canDial) return false;
    const next = stepYear(this.ladder, this.year, delta);
    if (next === this.year) {
      this.blocked = { direction: delta < 0 ? 'earlier' : 'later', edgeYear: this.year };
      return false;
    }
    this.blocked = null;
    this.year = next;
    this.pastReady = false;
    return true;
  }

  /** Jump straight to a listed year (the year panel). Returns true if the year changed. */
  jumpTo(year: number): boolean {
    if (this.year === null || !this.canDial || year === this.year || !this.ladder.includes(year)) return false;
    this.blocked = null;
    this.year = year;
    this.pastReady = false;
    return true;
  }

  /**
   * Advance by `dtMs`. `pushHeld`: the lens hand is pinching or squeezing the trigger.
   * `dialHeld`: the dial hand is pinching (the user is turning the dial).
   */
  update(dtMs: number, pushHeld: boolean, dialHeld: boolean): LensSignal {
    const t = this.t;
    if (!pushHeld) this.needRelease = false;
    switch (this.phase) {
      case 'off':
        return 'none';

      case 'committed':
        this.reset();
        this.wantOn = false;
        return 'none';

      case 'opening':
        this.phaseMs += dtMs;
        this.ripple = Math.min(1, this.phaseMs / t.openRippleMs);
        this.radius = openRadius(this.phaseMs, t.radius, t.openRippleMs, t.maxDistortion);
        if (this.phaseMs >= t.openRippleMs) this.enter(dialHeld ? 'dialling' : 'open');
        return 'none';

      case 'open':
      case 'dialling':
        this.phase = dialHeld ? 'dialling' : 'open';
        this.radius = t.radius;
        this.ripple = 1;
        if (pushHeld && !dialHeld && !this.needRelease && this.pastReady && this.yearHasPano) {
          this.holdMs += dtMs;
          if (this.holdMs >= t.pushHoldMs) {
            this.enter('pushing');
            this.pushT = 0;
          }
        } else {
          this.holdMs = 0;
        }
        return 'none';

      case 'pushing': {
        const rate = pushHeld ? 1 : -t.retractSpeed;
        this.pushT += (dtMs * rate) / t.pushThroughMs;
        if (this.pushT >= 1) {
          this.pushT = 1;
          this.radius = Math.PI;
          this.phase = 'committed';
          this.needRelease = true;
          return 'commit';
        }
        if (this.pushT <= 0) {
          this.pushT = 0;
          this.radius = t.radius;
          this.enter('open');
          return 'none';
        }
        this.radius = pushRadius(this.pushT, t.radius);
        return 'none';
      }

      case 'closing': {
        this.phaseMs += dtMs;
        const u = this.phaseMs / t.closeMs;
        if (u >= 1) {
          this.reset();
          return 'closed';
        }
        this.radius = closeRadius(u, this.closeFrom);
        return 'none';
      }
    }
  }

  private tryOpen(): boolean {
    if (!this.wantOn || this.phase === 'opening' || this.phase === 'open') return false;
    if (this.phase === 'dialling' || this.phase === 'pushing' || this.phase === 'committed') return false;
    const year = defaultYear(this.panoYears, this.currentYear);
    if (year === null) return false; // one year only: nothing to show, no lens
    this.year = year;
    this.pastReady = false;
    this.radius = 0;
    this.ripple = 0;
    this.pushT = 0;
    this.enter('opening');
    return true;
  }

  private enter(phase: LensPhase): void {
    this.phase = phase;
    this.phaseMs = 0;
    this.holdMs = 0;
  }
}
