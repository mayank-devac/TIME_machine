/**
 * Decides when the table map is redrawn and its texture re-uploaded. Pure; time is passed in.
 *
 * Why: in an immersive session the page's `requestAnimationFrame` may stop, so MapLibre stops
 * drawing itself. We drive `map.redraw()` from the render loop instead, but only when needed,
 * because each redraw re-uploads a 2048 x 2048 texture. A redraw never fetches tiles by itself;
 * tiles are fetched only when the view changes.
 */
export class RedrawScheduler {
  private dirty = true;
  private pending = false;
  private last = Number.NEGATIVE_INFINITY;
  /** Redraws done so far (diagnostics). */
  count = 0;

  /**
   * @param activeIntervalMs minimum gap between redraws after a view change (pan, zoom).
   * @param pendingIntervalMs gap between redraws while tiles are still arriving.
   */
  constructor(
    private readonly activeIntervalMs = 33,
    private readonly pendingIntervalMs = 150,
  ) {}

  /** The view changed or new data arrived. */
  markDirty(): void {
    this.dirty = true;
  }

  /** Whether the map is still loading tiles (MapLibre `!map.loaded()`). */
  setPending(pending: boolean): void {
    this.pending = pending;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /** Call once per frame. Returns true when a redraw should happen now, and consumes it. */
  due(now: number): boolean {
    const since = now - this.last;
    const go = (this.dirty && since >= this.activeIntervalMs) || (this.pending && since >= this.pendingIntervalMs);
    if (!go) return false;
    this.dirty = false;
    this.last = now;
    this.count++;
    return true;
  }
}
