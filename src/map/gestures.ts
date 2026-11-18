/**
 * Turns presses on the table map into what the user meant: a tap (pick a street), a one-pointer
 * drag (pan), or a two-pointer pinch (zoom about the midpoint, and pan with it). Pure: canvas
 * pixels and timestamps in, calls on a `GestureSink` out. No Three.js, no DOM, no MapLibre.
 * Tested in `gestures.test.ts`.
 *
 *  - A press does nothing until it gets `slopPx` from where it went down. Released before that,
 *    and within `TAP_MAX_MS`, it is a tap. Past it, it is a drag for the rest of the press, and
 *    the first pan catches up with the whole offset from the press point.
 *  - Two pointers held: a pinch. It pans with the midpoint, and zooms only once the spread has
 *    changed by `PINCH_DEADZONE` (so two hands moving together, or ray jitter, never zoom).
 *  - A press sequence that ever had two pointers never taps.
 */

import { pinchZoom, type Pixel } from "./geo.js";

/** What a recognised gesture does. The table map implements it. */
export interface GestureSink {
  /** Pan by (dx, dy) canvas px ending at `end`. `end` is reused: read it, do not keep it. */
  pan(end: Pixel, dx: number, dy: number): void;
  zoomTo(zoom: number, ax: number, ay: number): void;
  tap(x: number, y: number): void;
  /** Forget a pointer the recogniser dropped as lost (release its capture). */
  dropped(pointerId: number): void;
  /** The zoom a new pinch starts from (where an ease in progress is heading). */
  zoomTarget(): number;
}

/** How far a pointer may wander on the table during a press and still count as a tap, metres. */
export const TAP_TRAVEL_M = 0.017;
/** Longest press that still counts as a tap, ms. */
export const TAP_MAX_MS = 700;
/** A pinch zooms only once the spread has changed by this much, log2 units (about 11 %). */
export const PINCH_DEADZONE = 0.15;
/**
 * Workaround, unproven on a device: a held pointer with no event for this long is dropped when
 * another one goes down. IWSDK's MultiPointer switches a hand between its ray, poke and grab
 * pointers and only runs the active one's button lifecycle, so a pointer switched away from
 * mid-press may never send its release. Left in place it would turn the next click into a
 * pinch. Pointer events do not say which hand they come from (`pointerState` is empty and the
 * per-hand pointers are private), so "one held pointer per hand" cannot be enforced directly.
 * See docs/untested-on-device.md.
 */
export const STALE_POINTER_MS = 1500;

/** `TAP_TRAVEL_M` as canvas pixels on a table `tableSizeM` across drawn at `canvasPx`. */
export function tapSlopPx(canvasPx: number, tableSizeM: number): number {
  return (TAP_TRAVEL_M / tableSizeM) * canvasPx;
}

interface Press {
  x: number;
  y: number;
  /** Where it went down. */
  sx: number;
  sy: number;
  t0: number;
  /** Last down or move event, ms. */
  last: number;
  /** Past the slop: pans for the rest of the press. */
  dragging: boolean;
}

interface Pinch {
  /** Zoom and spread the zoom is measured from; reset once, when the dead zone is crossed. */
  baseZoom: number;
  baseDist: number;
  zooming: boolean;
  midX: number;
  midY: number;
}

export class TableGestures {
  private readonly presses = new Map<number, Press>();
  private pinch: Pinch | null = null;
  /** This press sequence has had two pointers at once: no tap until every pointer is up. */
  private multi = false;
  private readonly mid: Pixel = { x: 0, y: 0 };

  constructor(
    private readonly sink: GestureSink,
    private readonly slopPx: number,
  ) {}

  /** Pointers currently held. */
  get count(): number {
    return this.presses.size;
  }

  down(id: number, p: Pixel, now: number): void {
    for (const [other, press] of this.presses) {
      if (other !== id && now - press.last > STALE_POINTER_MS) {
        this.presses.delete(other);
        this.sink.dropped(other);
      }
    }
    this.presses.set(id, {
      x: p.x,
      y: p.y,
      sx: p.x,
      sy: p.y,
      t0: now,
      last: now,
      dragging: false,
    });
    this.sync();
  }

  move(id: number, p: Pixel, now: number): void {
    const press = this.presses.get(id);
    if (!press) return;
    press.last = now;
    if (p.x === press.x && p.y === press.y) return;
    let fromX = press.x;
    let fromY = press.y;
    press.x = p.x;
    press.y = p.y;
    if (!press.dragging) {
      if (Math.hypot(p.x - press.sx, p.y - press.sy) <= this.slopPx) return;
      press.dragging = true;
      fromX = press.sx;
      fromY = press.sy;
    }
    if (this.pinch) this.updatePinch(this.pinch);
    else this.sink.pan(p, p.x - fromX, p.y - fromY);
  }

  up(id: number, now: number, cancelled: boolean): void {
    const press = this.presses.get(id);
    if (!press) return;
    this.presses.delete(id);
    const tap =
      !cancelled &&
      !this.multi &&
      !press.dragging &&
      now - press.t0 <= TAP_MAX_MS;
    this.sync();
    if (tap) this.sink.tap(press.x, press.y);
  }

  /** Forget every held pointer (the table was hidden), reporting each through `dropped`. */
  reset(): void {
    for (const id of this.presses.keys()) this.sink.dropped(id);
    this.presses.clear();
    this.sync();
  }

  /** The one place the pinch and multi state follow the number of held pointers. */
  private sync(): void {
    const n = this.presses.size;
    if (n >= 2) {
      this.multi = true;
      if (!this.pinch) this.pinch = this.startPinch();
    } else {
      this.pinch = null;
      if (n === 0) this.multi = false;
    }
  }

  private startPinch(): Pinch {
    const dist = this.measure();
    return {
      baseZoom: this.sink.zoomTarget(),
      baseDist: dist,
      zooming: false,
      midX: this.mid.x,
      midY: this.mid.y,
    };
  }

  private updatePinch(g: Pinch): void {
    const dist = this.measure();
    const { x, y } = this.mid;
    if (!g.zooming && Math.abs(Math.log2(dist / g.baseDist)) > PINCH_DEADZONE) {
      // Measure from here, so the dead zone is not added to the zoom.
      g.zooming = true;
      g.baseDist = dist;
    }
    if (g.zooming)
      this.sink.zoomTo(pinchZoom(g.baseZoom, g.baseDist, dist), x, y);
    this.sink.pan(this.mid, x - g.midX, y - g.midY);
    g.midX = x;
    g.midY = y;
  }

  /** Spread of the first two held pointers; writes their midpoint into `this.mid`. */
  private measure(): number {
    let a: Press | null = null;
    for (const p of this.presses.values()) {
      if (!a) {
        a = p;
        continue;
      }
      this.mid.x = (a.x + p.x) / 2;
      this.mid.y = (a.y + p.y) / 2;
      return Math.hypot(a.x - p.x, a.y - p.y);
    }
    return 0;
  }
}
