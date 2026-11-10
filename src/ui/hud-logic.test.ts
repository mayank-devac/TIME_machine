import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pano } from '../contracts.js';
import {
  BusyScopes,
  SLOTS,
  ToastQueue,
  canUseTimeMachine,
  composeCredits,
  deriveHud,
  slotPosition,
  yawFromForward,
} from './hud-logic.js';
import type { Toast } from './hud-logic.js';

const pano = (creator: string, year = 2025): Pano =>
  ({ id: 'p', creator, capturedAt: Date.UTC(year, 5, 1) }) as Pano;

describe('composeCredits', () => {
  it('is never empty and always credits Mapillary and OpenStreetMap', () => {
    for (const text of [composeCredits(null), composeCredits(undefined, []), composeCredits(pano(''))]) {
      expect(text).toContain('Mapillary');
      expect(text).toContain('OpenStreetMap');
    }
  });

  it('adds the street imagery creator', () => {
    expect(composeCredits(pano('alice'))).toContain('Photo: alice');
  });

  it('adds archive creators with licences and dedupes', () => {
    const text = composeCredits(pano('alice'), [
      { creator: 'Bob', license: 'CC BY-SA 4.0' },
      { creator: 'bob ', license: 'cc by-sa 4.0' },
      { creator: 'Carol', license: '' },
      { creator: '', license: 'PD' },
    ]);
    expect(text).toContain('Archive: Bob (CC BY-SA 4.0), Carol, unknown (PD)');
    expect(text.match(/Bob/gu)).toHaveLength(1);
  });

  it('is plain ASCII', () => {
    expect(/^[\x20-\x7e]*$/u.test(composeCredits(pano('x'), [{ creator: 'y', license: 'z' }]))).toBe(true);
  });
});

describe('deriveHud', () => {
  const base = { mode: 'street' as const, pano: pano('a'), years: [2022, 2025], timeOn: false, year: null };

  it('shows only credits and status on the table', () => {
    const v = deriveHud({ state: { ...base, mode: 'table' }, yearsKnown: true });
    expect(v.showTimeButton || v.showYear || v.showPortalButton).toBe(false);
    expect(v.noEarlierImagery).toBe(false);
  });

  it('shows button and year in street and portal modes', () => {
    for (const mode of ['street', 'portal'] as const) {
      const v = deriveHud({ state: { ...base, mode }, yearsKnown: true });
      expect(v.showTimeButton && v.showYear && v.showPortalButton).toBe(true);
    }
  });

  it('enables the button only with two or more years', () => {
    expect(deriveHud({ state: base, yearsKnown: true }).timeButtonEnabled).toBe(true);
    const one = deriveHud({ state: { ...base, years: [2025] }, yearsKnown: true });
    expect(one.timeButtonEnabled).toBe(false);
    expect(one.noEarlierImagery).toBe(true);
    expect(canUseTimeMachine([], true)).toBe(false);
    expect(canUseTimeMachine([2020, 2021], false)).toBe(false);
  });

  it('does not claim "no earlier imagery" before years are known', () => {
    const v = deriveHud({ state: { ...base, years: [] }, yearsKnown: false });
    expect(v.noEarlierImagery).toBe(false);
    expect(v.timeButtonEnabled).toBe(false);
  });

  it('shows the present year, then the dialled year when the lens is on', () => {
    expect(deriveHud({ state: base, yearsKnown: true }).yearText).toBe('2025');
    const on = deriveHud({ state: { ...base, timeOn: true, year: 2022 }, yearsKnown: true });
    expect(on.yearText).toBe('2022');
    expect(on.yearIsPast).toBe(true);
    expect(on.timeButtonLabel).toBe('BACK TO NOW');
    expect(deriveHud({ state: { ...base, pano: null }, yearsKnown: false }).yearText).toBe('----');
  });

  it('portal button toggles between portal and street', () => {
    expect(deriveHud({ state: base, yearsKnown: true }).portalTarget).toBe('portal');
    expect(deriveHud({ state: { ...base, mode: 'portal' }, yearsKnown: true }).portalTarget).toBe('street');
  });
});

describe('BusyScopes', () => {
  it('is busy while any scope is busy', () => {
    const b = new BusyScopes();
    expect(b.busy).toBe(false);
    b.set('a', true);
    b.set('b', true);
    b.set('a', true);
    expect(b.count).toBe(2);
    b.set('a', false);
    expect(b.busy).toBe(true);
    b.set('b', false);
    expect(b.busy).toBe(false);
    b.set('never-started', false);
    expect(b.count).toBe(0);
  });
});

describe('ToastQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (): { q: ToastQueue; log: Array<Toast | null> } => {
    const log: Array<Toast | null> = [];
    return { q: new ToastQueue({ onChange: (t) => log.push(t) }), log };
  };

  it('auto-dismisses a recoverable toast after the duration', () => {
    const { q, log } = make();
    q.push('x', 'oops', true);
    expect(q.current?.message).toBe('oops');
    vi.advanceTimersByTime(ToastQueue.DEFAULT_DURATION_MS - 1);
    expect(q.current).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(q.current).toBeNull();
    expect(log.map((t) => t?.message ?? null)).toEqual(['oops', null]);
  });

  it('shows queued toasts one after another', () => {
    const { q } = make();
    q.push('x', 'one', true);
    q.push('x', 'two', true);
    expect(q.pending).toBe(1);
    vi.advanceTimersByTime(ToastQueue.DEFAULT_DURATION_MS);
    expect(q.current?.message).toBe('two');
    vi.advanceTimersByTime(ToastQueue.DEFAULT_DURATION_MS);
    expect(q.current).toBeNull();
  });

  it('ignores an identical consecutive message', () => {
    const { q } = make();
    q.push('x', 'same', true);
    q.push('y', 'same', true);
    expect(q.pending).toBe(0);
  });

  it('keeps a non-recoverable toast until cleared', () => {
    const { q } = make();
    q.push('x', 'fatal', false);
    vi.advanceTimersByTime(60_000);
    expect(q.current?.message).toBe('fatal');
    expect(q.current?.sticky).toBe(true);
    q.clear();
    expect(q.current).toBeNull();
  });

  it('caps the queue and never fires after dispose', () => {
    const { q, log } = make();
    q.push('x', 'm0', true);
    for (let i = 1; i <= 9; i++) q.push('x', `m${i}`, true);
    expect(q.pending).toBe(5);
    q.dispose();
    const before = log.length;
    vi.advanceTimersByTime(60_000);
    expect(log.length).toBe(before);
  });
});

describe('placement', () => {
  it('puts the credits line 1.5 m ahead and below the eye line', () => {
    const out = { x: 0, y: 0, z: 0 };
    slotPosition({ x: 0, y: 1.6, z: 1 }, 0, SLOTS.credits, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(-0.5);
    expect(out.y).toBeLessThan(1.6);
  });

  it('places the time button to the left of forward, whatever the heading', () => {
    const out = { x: 0, y: 0, z: 0 };
    slotPosition({ x: 0, y: 1.6, z: 0 }, 0, SLOTS.time, out);
    expect(out.x).toBeLessThan(0); // left of -Z is -X
    const yaw = yawFromForward(-1, 0); // facing -X
    expect(yaw).toBeCloseTo(Math.PI / 2);
    slotPosition({ x: 0, y: 1.6, z: 0 }, yaw, SLOTS.credits, out);
    expect(out.x).toBeCloseTo(-1.5);
    expect(out.z).toBeCloseTo(0);
  });
});

describe('stale lens state', () => {
  it('shows the present and the plain label when the lens is on but nothing earlier exists', () => {
    const v = deriveHud({
      state: { mode: 'street', pano: pano('a', 2025), years: [2025], timeOn: true, year: 2023 },
      yearsKnown: true,
    });
    expect(v.timeButtonLabel).toBe('TIME MACHINE');
    expect(v.yearText).toBe('2025');
    expect(v.yearIsPast).toBe(false);
  });
});
