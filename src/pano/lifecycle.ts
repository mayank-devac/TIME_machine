/**
 * Texture accounting, load cancellation, fades and decoding for the pano stage.
 * No Three.js imports here so it runs under vitest in node with fakes.
 */

/** Counts live panorama textures and frees them in the agreed order. */
export class TextureLedger<T extends object = object> {
  private readonly live = new Map<T, () => void>();
  /** Highest count ever reached. Must stay at or below `max`. */
  maxSeen = 0;
  /** Number of times `track` pushed the count above `max` (a bug if ever non-zero). */
  violations = 0;

  constructor(readonly max: number) {}

  get count(): number {
    return this.live.size;
  }

  /** Start counting `item`. `release` frees it (texture.dispose(), then bitmap.close()). */
  track(item: T, release: () => void): void {
    this.live.set(item, release);
    this.maxSeen = Math.max(this.maxSeen, this.live.size);
    if (this.live.size > this.max) {
      this.violations++;
      console.error(`[pano] ${this.live.size} live panorama textures; the cap is ${this.max}`);
    }
  }

  /** Free and stop counting `item`. Returns false if it was not tracked. */
  release(item: T | null | undefined): boolean {
    if (!item) return false;
    const release = this.live.get(item);
    if (!release) return false;
    this.live.delete(item);
    release();
    return true;
  }

  has(item: T): boolean {
    return this.live.has(item);
  }

  releaseAll(): void {
    for (const item of [...this.live.keys()]) this.release(item);
  }
}

export interface Ticket {
  readonly id: number;
  readonly signal: AbortSignal;
  /** True while no newer ticket has been issued and this one was not cancelled. */
  readonly current: boolean;
}

/** Only the most recent request survives: `begin()` aborts the previous ticket. */
export class LatestOnly {
  private seq = 0;
  private controller: AbortController | null = null;

  begin(): Ticket {
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const id = ++this.seq;
    const self = this;
    return {
      id,
      signal: controller.signal,
      get current() {
        return self.seq === id && !controller.signal.aborted;
      },
    };
  }

  cancel(): void {
    this.controller?.abort();
    this.controller = null;
    this.seq++;
  }
}

export function abortError(): Error {
  const err = new Error('superseded');
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

/** Brightness ramp for fade-to-black. Value 1 = full picture, 0 = black. Time in ms. */
export class Fader {
  private from: number;
  private to: number;
  private start = 0;
  private duration = 0;

  constructor(initial = 1) {
    this.from = initial;
    this.to = initial;
  }

  /** Jump straight to a value. */
  set(value: number): void {
    this.from = value;
    this.to = value;
    this.duration = 0;
  }

  fadeTo(target: number, durationMs: number, now: number): void {
    this.from = this.sample(now);
    this.to = target;
    this.start = now;
    this.duration = Math.max(0, durationMs);
  }

  sample(now: number): number {
    if (this.duration <= 0) return this.to;
    const t = Math.min(1, Math.max(0, (now - this.start) / this.duration));
    // Smoothstep: no visible kink at the start or end of the ramp.
    const s = t * t * (3 - 2 * t);
    return this.from + (this.to - this.from) * s;
  }

  /** True while ramping or holding below full brightness. */
  isDimmed(now: number): boolean {
    return this.sample(now) < 0.999 || (this.duration > 0 && now - this.start < this.duration);
  }

  get target(): number {
    return this.to;
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** The parts of an ImageBitmap the stage relies on. */
export interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close(): void;
}

export interface LoaderDeps<B extends BitmapLike = ImageBitmap> {
  fetch: (url: string, init: { signal: AbortSignal; mode: 'cors' }) => Promise<{
    ok: boolean;
    status: number;
    blob(): Promise<Blob>;
  }>;
  decode: (blob: Blob, options: ImageBitmapOptions) => Promise<B>;
}

export const browserLoaderDeps = (): LoaderDeps => ({
  fetch: (url, init) => fetch(url, init),
  decode: (blob, options) => createImageBitmap(blob, options),
});

/**
 * Fetch and decode a panorama off the main thread, downscaled during decode
 * (`createImageBitmap` with `resizeWidth/Height`). Rows stay top-first (no flip): the shader
 * samples with v = 0 at the top. Aborting closes any bitmap already decoded.
 */
export async function loadBitmap<B extends BitmapLike>(
  url: string,
  size: { width: number; height: number; resized: boolean },
  signal: AbortSignal,
  deps: LoaderDeps<B>,
): Promise<B> {
  if (signal.aborted) throw abortError();
  const resp = await deps.fetch(url, { signal, mode: 'cors' });
  if (!resp.ok) throw new Error(`panorama fetch failed (${resp.status})`);
  const blob = await resp.blob();
  if (signal.aborted) throw abortError();
  const options: ImageBitmapOptions = size.resized
    ? { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' }
    : {};
  options.colorSpaceConversion = 'none';
  options.premultiplyAlpha = 'none';
  const bitmap = await deps.decode(blob, options);
  if (signal.aborted) {
    bitmap.close();
    throw abortError();
  }
  return bitmap;
}

/**
 * Resolve with the first of `a`/`b` to succeed, tagged with its key. Rejects only when both
 * fail (with `b`'s error). `b` may be null.
 */
export function firstSuccess<A, B>(
  a: Promise<A> | null,
  b: Promise<B>,
): Promise<{ key: 'a'; value: A } | { key: 'b'; value: B }> {
  return new Promise((resolve, reject) => {
    let failures = 0;
    const needed = a ? 2 : 1;
    let settled = false;
    let lastErr: unknown;
    const fail = (err: unknown, isB: boolean) => {
      failures++;
      if (isB || !lastErr) lastErr = err;
      if (failures >= needed && !settled) reject(lastErr);
    };
    a?.then(
      (value) => {
        if (!settled) {
          settled = true;
          resolve({ key: 'a', value });
        }
      },
      (err) => fail(err, false),
    );
    b.then(
      (value) => {
        if (!settled) {
          settled = true;
          resolve({ key: 'b', value });
        }
      },
      (err) => fail(err, true),
    );
  });
}
