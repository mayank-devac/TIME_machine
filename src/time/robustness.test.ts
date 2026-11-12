import { describe, expect, it } from 'vitest';
import { DialTracker, swingAboutAxis } from './dial.js';
import { HAND_PRESS, PressDebouncer } from './input-filter.js';
import { CrossingDetector } from '../portal/portal-logic.js';
import type { WindowPlane } from '../portal/portal-logic.js';
import { FrameGovernor, initialTier, widthCap } from '../pano/pano-math.js';
import { TimeoutError, fetchBlobWithRetry } from '../pano/lifecycle.js';
import { createVoiceInput } from '../ui/voice.js';

const deg = (d: number): number => (d * Math.PI) / 180;
const quatAbout = (ax: number, ay: number, az: number, a: number) => {
  const s = Math.sin(a / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(a / 2) };
};
const ID = { x: 0, y: 0, z: 0, w: 1 };

describe('PressDebouncer (hand pinch noise)', () => {
  it('ignores a one-frame flicker and bridges a short dropout', () => {
    const f = new PressDebouncer();
    expect(f.update(true, 11, HAND_PRESS)).toBe(false); // 11 ms < onMs
    expect(f.update(false, 11, HAND_PRESS)).toBe(false); // flicker gone
    for (let i = 0; i < 4; i++) f.update(true, 11, HAND_PRESS);
    expect(f.value).toBe(true);
    // 3 frames (33 ms) of dropout are bridged.
    for (let i = 0; i < 3; i++) expect(f.update(false, 11, HAND_PRESS)).toBe(true);
    expect(f.update(true, 11, HAND_PRESS)).toBe(true);
    // A real release (> offMs) lets go.
    for (let i = 0; i < 11; i++) f.update(false, 11, HAND_PRESS);
    expect(f.value).toBe(false);
  });
});

describe('DialTracker filtering', () => {
  const step = deg(25);
  it('drops a single-frame tracking spike', () => {
    const d = new DialTracker(step, { maxJumpRad: deg(60), settleMs: 0 });
    d.begin(0);
    expect(d.update(deg(170), 11)).toBe(0); // spike
    expect(d.glitches).toBe(1);
    expect(d.update(deg(10), 11)).toBe(0);
  });
  it('ignores wrist roll during the post-pinch settle time', () => {
    const d = new DialTracker(step, { maxJumpRad: deg(60), settleMs: 100 });
    d.begin(0);
    expect(d.update(deg(20), 50)).toBe(0);
    expect(d.update(deg(30), 60)).toBe(0); // still settling: 30 degrees not counted
    expect(d.settling).toBe(false);
    expect(d.update(deg(50), 11)).toBe(0); // 20 degrees since settle: no click yet
    expect(d.update(deg(56), 11)).toBe(1);
  });
  it('keeps progress across a rebase', () => {
    const d = new DialTracker(step);
    d.begin(0);
    d.update(deg(20));
    d.rebase(0);
    expect(d.update(deg(6))).toBe(1);
  });
  it('measures swing separately from twist', () => {
    const twist = quatAbout(0, 0, -1, deg(40));
    expect(swingAboutAxis(ID, twist, 0, 0, -1)).toBeLessThan(1e-6);
    const swing = quatAbout(0, 1, 0, deg(50));
    expect(swingAboutAxis(ID, swing, 0, 0, -1)).toBeCloseTo(deg(50), 5);
  });
});

describe('CrossingDetector teleport guard', () => {
  const plane: WindowPlane = {
    origin: { x: 0, y: 1.5, z: 0 },
    normal: { x: 0, y: 0, z: 1 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    halfWidth: 0.7,
    halfHeight: 0.85,
  };
  it('a recentre jump through the opening does not count', () => {
    const c = new CrossingDetector({ roomMargin: 0.1, streetDepth: 0.05, inset: 0.05, maxJumpM: 0.4 });
    c.update(plane, { x: 0, y: 1.5, z: 0.5 });
    expect(c.update(plane, { x: 0, y: 1.5, z: -0.5 })).toBe(false);
  });
  it('walking through still counts', () => {
    const c = new CrossingDetector({ roomMargin: 0.1, streetDepth: 0.05, inset: 0.05, maxJumpM: 0.4 });
    let hit = false;
    for (let z = 0.5; z > -0.3; z -= 0.02) hit = c.update(plane, { x: 0, y: 1.5, z }) || hit;
    expect(hit).toBe(true);
  });
});

describe('FrameGovernor', () => {
  it('steps down after sustained slow frames, never on one hitch', () => {
    const g = new FrameGovernor(0);
    let t = 0;
    for (let i = 0; i < 300; i++) g.frame((t += 13.9)); // 72 Hz
    g.frame((t += 200)); // one hitch
    expect(g.tier).toBe(0);
    let dropped = false;
    for (let i = 0; i < 200 && !dropped; i++) dropped = g.frame((t += 25)); // 40 fps
    expect(dropped).toBe(true);
    expect(g.tier).toBe(1);
  });
  it('a steady 60 Hz display with one very short frame is not slow', () => {
    const g = new FrameGovernor(0);
    let t = 0;
    for (let i = 0; i < 50; i++) g.frame((t += 16.7));
    g.frame((t += 1));
    for (let i = 0; i < 600; i++) g.frame((t += 16.7));
    expect(g.tier).toBe(0);
  });
  it('uses the reported session rate when given', () => {
    const g = new FrameGovernor(0);
    let t = 0;
    let dropped = false;
    for (let i = 0; i < 400 && !dropped; i++) dropped = g.frame((t += 16.7), 90); // 60 fps on a 90 Hz panel
    expect(dropped).toBe(true);
  });
  it('a steady 72 fps on a 90 or 120 Hz session meets the target and is not slow', () => {
    for (const hz of [90, 120]) {
      const g = new FrameGovernor(0);
      let t = 0;
      for (let i = 0; i < 600; i++) g.frame((t += 13.9), hz);
      expect(g.tier).toBe(0);
    }
  });
  it('treats long gaps as a pause, not slowness', () => {
    const g = new FrameGovernor(0);
    let t = 0;
    for (let i = 0; i < 100; i++) g.frame((t += 1000));
    expect(g.tier).toBe(0);
  });
  it('lower tiers lower the caps', () => {
    expect(widthCap('current', true, 0)).toBe(5760);
    expect(widthCap('current', true, 2)).toBe(3072);
    expect(widthCap('past', true, 3)).toBe(2048);
    expect(initialTier({ saveData: true })).toBe(2);
    expect(initialTier({})).toBe(0);
  });
});

describe('fetchBlobWithRetry', () => {
  const blob = new Blob(['x']);
  const noWait = async () => undefined;
  it('retries a network error once', async () => {
    let calls = 0;
    const f = async () => {
      if (calls++ === 0) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, blob: async () => blob };
    };
    const out = await fetchBlobWithRetry('u', new AbortController().signal, f, { timeoutMs: 0, retries: 1, retryDelayMs: 0 }, noWait);
    expect(out).toBe(blob);
    expect(calls).toBe(2);
  });
  it('does not retry a 403 (expired URL)', async () => {
    let calls = 0;
    const f = async () => {
      calls++;
      return { ok: false, status: 403, blob: async () => blob };
    };
    await expect(
      fetchBlobWithRetry('u', new AbortController().signal, f, { timeoutMs: 0, retries: 2, retryDelayMs: 0 }, noWait),
    ).rejects.toThrow('403');
    expect(calls).toBe(1);
  });
  it('times out a stalled request', async () => {
    const f = (_u: string, init: { signal: AbortSignal }) =>
      new Promise<never>((_r, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await expect(
      fetchBlobWithRetry('u', new AbortController().signal, f, { timeoutMs: 20, retries: 0, retryDelayMs: 0 }, noWait),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
  /** A body that sends `n` chunks `gapMs` apart, or never sends anything when n is 0. */
  const trickle = (n: number, gapMs: number) => (_u: string, init: { signal: AbortSignal }) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        init.signal.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
        let sent = 0;
        const tick = (): void => {
          if (init.signal.aborted) return;
          if (sent === n) return void c.close();
          c.enqueue(new Uint8Array([sent++]));
          setTimeout(tick, gapMs);
        };
        if (n > 0) setTimeout(tick, gapMs);
      },
    });
    return Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(), body });
  };
  it('lets a slow but moving download run past the timeout', async () => {
    // 6 chunks 15 ms apart = ~90 ms total, well past the 40 ms stall timeout.
    const out = await fetchBlobWithRetry('u', new AbortController().signal, trickle(6, 15), { timeoutMs: 40, retries: 0, retryDelayMs: 0 }, noWait);
    expect(out.size).toBe(6);
  });
  it('times out a body that stops sending', async () => {
    await expect(
      fetchBlobWithRetry('u', new AbortController().signal, trickle(0, 0), { timeoutMs: 20, retries: 0, retryDelayMs: 0 }, noWait),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('voice watchdog', () => {
  it('gives up when the mic never opens, and hides the mic after a fatal error', async () => {
    class Rec {
      static last: Rec;
      lang = '';
      interimResults = false;
      continuous = false;
      maxAlternatives = 1;
      onresult = null;
      onerror: ((e: { error?: string }) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() {
        Rec.last = this;
      }
      start() {}
      stop() {}
      abort() {}
    }
    const voice = createVoiceInput('en-US', { SpeechRecognition: Rec }, { startTimeoutMs: 10, maxListenMs: 1000 });
    const ended = await new Promise<string | undefined>((resolve) => voice.start({ onText() {}, onEnd: resolve }));
    expect(ended).toMatch(/did not start/);
    expect(voice.listening).toBe(false);

    const second = new Promise<string | undefined>((resolve) => voice.start({ onText() {}, onEnd: resolve }));
    Rec.last.onerror?.({ error: 'not-allowed' });
    Rec.last.onend?.();
    expect(await second).toMatch(/blocked/i);
    expect(voice.supported).toBe(false);
  });
});
