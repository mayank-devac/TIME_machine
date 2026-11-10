import { describe, expect, it, vi } from 'vitest';
import {
  Fader,
  LatestOnly,
  TextureLedger,
  firstSuccess,
  isAbortError,
  loadBitmap,
} from './lifecycle.js';
import type { BitmapLike, LoaderDeps } from './lifecycle.js';

class FakeBitmap implements BitmapLike {
  closed = false;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}
  close(): void {
    this.closed = true;
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TextureLedger', () => {
  it('frees in order: dispose, then close', () => {
    const ledger = new TextureLedger(2);
    const order: string[] = [];
    const tex = {};
    ledger.track(tex, () => {
      order.push('dispose');
      order.push('close');
    });
    expect(ledger.count).toBe(1);
    expect(ledger.release(tex)).toBe(true);
    expect(order).toEqual(['dispose', 'close']);
    expect(ledger.count).toBe(0);
    expect(ledger.release(tex)).toBe(false);
  });

  it('stays flat over many swaps when the old texture is freed first', () => {
    const ledger = new TextureLedger(2);
    let cur: object | null = null;
    const past = {};
    ledger.track(past, () => undefined);
    for (let i = 0; i < 20; i++) {
      ledger.release(cur);
      cur = {};
      ledger.track(cur, () => undefined);
    }
    expect(ledger.count).toBe(2);
    expect(ledger.maxSeen).toBe(2);
    expect(ledger.violations).toBe(0);
  });

  it('records a violation above the cap', () => {
    const ledger = new TextureLedger(2);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ledger.track({}, () => undefined);
    ledger.track({}, () => undefined);
    ledger.track({}, () => undefined);
    expect(ledger.violations).toBe(1);
    spy.mockRestore();
  });
});

describe('LatestOnly', () => {
  it('aborts the previous ticket when a new one begins', () => {
    const gate = new LatestOnly();
    const a = gate.begin();
    expect(a.current).toBe(true);
    const b = gate.begin();
    expect(a.current).toBe(false);
    expect(a.signal.aborted).toBe(true);
    expect(b.current).toBe(true);
    gate.cancel();
    expect(b.current).toBe(false);
  });
});

describe('loadBitmap', () => {
  const okResp = { ok: true, status: 200, blob: async () => new Blob(['x']) };

  it('decodes with resize options only when downscaling', async () => {
    const decode = vi.fn(async (_blob: Blob, _opts: ImageBitmapOptions) => new FakeBitmap(10, 5));
    const deps: LoaderDeps<FakeBitmap> = { fetch: async () => okResp, decode };
    const ac = new AbortController();
    await loadBitmap('u', { width: 5760, height: 2880, resized: true }, ac.signal, deps);
    expect(decode.mock.calls[0][1]).toMatchObject({ resizeWidth: 5760, resizeHeight: 2880, resizeQuality: 'high' });
    await loadBitmap('u', { width: 2048, height: 1024, resized: false }, ac.signal, deps);
    expect(decode.mock.calls[1][1]).not.toHaveProperty('resizeWidth');
  });

  it('closes a bitmap that finishes decoding after the load was cancelled', async () => {
    const d = deferred<FakeBitmap>();
    const deps: LoaderDeps<FakeBitmap> = { fetch: async () => okResp, decode: () => d.promise };
    const ac = new AbortController();
    const p = loadBitmap('u', { width: 1, height: 1, resized: false }, ac.signal, deps);
    await Promise.resolve();
    await Promise.resolve();
    ac.abort();
    const bmp = new FakeBitmap(1, 1);
    d.resolve(bmp);
    await expect(p).rejects.toSatisfy(isAbortError);
    expect(bmp.closed).toBe(true);
  });

  it('rejects immediately when already aborted, without fetching', async () => {
    const fetch = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(
      loadBitmap('u', { width: 1, height: 1, resized: false }, ac.signal, { fetch, decode: vi.fn() }),
    ).rejects.toSatisfy(isAbortError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports HTTP errors', async () => {
    const deps: LoaderDeps<FakeBitmap> = {
      fetch: async () => ({ ok: false, status: 404, blob: async () => new Blob() }),
      decode: vi.fn(),
    };
    await expect(
      loadBitmap('u', { width: 1, height: 1, resized: false }, new AbortController().signal, deps),
    ).rejects.toThrow('404');
  });
});

describe('firstSuccess (preview vs full image)', () => {
  it('takes the preview when it arrives first', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const p = firstSuccess(a.promise, b.promise);
    a.resolve('preview');
    b.resolve('full');
    await expect(p).resolves.toEqual({ key: 'a', value: 'preview' });
  });

  it('takes the full image when it wins', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const p = firstSuccess(a.promise, b.promise);
    b.resolve('full');
    await expect(p).resolves.toEqual({ key: 'b', value: 'full' });
  });

  it('falls back to the full image when the preview fails', async () => {
    const a = deferred<string>();
    const b = deferred<string>();
    const p = firstSuccess(a.promise, b.promise);
    a.reject(new Error('preview 404'));
    b.resolve('full');
    await expect(p).resolves.toEqual({ key: 'b', value: 'full' });
  });

  it('rejects only when both fail', async () => {
    const p = firstSuccess(Promise.reject(new Error('a')), Promise.reject(new Error('b')));
    await expect(p).rejects.toThrow('b');
  });

  it('works without a preview', async () => {
    await expect(firstSuccess(null, Promise.resolve(1))).resolves.toEqual({ key: 'b', value: 1 });
  });
});

describe('Fader', () => {
  it('ramps to black and back over the configured times', () => {
    const f = new Fader(1);
    f.fadeTo(0, 200, 1000);
    expect(f.sample(1000)).toBeCloseTo(1);
    expect(f.sample(1100)).toBeCloseTo(0.5);
    expect(f.sample(1200)).toBeCloseTo(0);
    expect(f.isDimmed(1300)).toBe(true);
    f.fadeTo(1, 200, 1300);
    expect(f.sample(1500)).toBeCloseTo(1);
    expect(f.isDimmed(1600)).toBe(false);
  });

  it('starts a new ramp from wherever the old one was', () => {
    const f = new Fader(1);
    f.fadeTo(0, 200, 0);
    const mid = f.sample(100);
    f.fadeTo(1, 200, 100);
    expect(f.sample(100)).toBeCloseTo(mid);
  });
});
