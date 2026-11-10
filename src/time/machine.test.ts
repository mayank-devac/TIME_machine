import { describe, expect, it } from 'vitest';
import { LensMachine } from './machine.js';
import type { LensSignal, LensTuning } from './machine.js';

const tuning: LensTuning = {
  radius: 0.25,
  openRippleMs: 700,
  pushThroughMs: 1600,
  maxDistortion: 0.02,
  pushHoldMs: 300,
  retractSpeed: 2,
  closeMs: 250,
  archiveFloorYear: 2000,
};

const YEARS = [2019, 2023, 2025];

/** Run `ms` of 16 ms frames; returns every non-'none' signal seen. */
function run(m: LensMachine, ms: number, pushHeld = false, dialHeld = false): LensSignal[] {
  const seen: LensSignal[] = [];
  for (let t = 0; t < ms; t += 16) {
    const s = m.update(16, pushHeld, dialHeld);
    if (s !== 'none') seen.push(s);
  }
  return seen;
}

function openMachine(): LensMachine {
  const m = new LensMachine(tuning);
  m.setYears(YEARS, 2025);
  expect(m.toggle(true)).toBe(true);
  run(m, 720);
  expect(m.phase).toBe('open');
  m.pastReady = true;
  return m;
}

describe('lens state machine', () => {
  it('starts off and stays off without a toggle', () => {
    const m = new LensMachine(tuning);
    m.setYears(YEARS, 2025);
    run(m, 500, true, true);
    expect(m.phase).toBe('off');
    expect(m.year).toBeNull();
    expect(m.isActive).toBe(false);
  });

  it('off -> opening -> open, on the latest earlier year', () => {
    const m = new LensMachine(tuning);
    m.setYears(YEARS, 2025);
    expect(m.toggle(true)).toBe(true);
    expect(m.phase).toBe('opening');
    expect(m.year).toBe(2023);
    expect(m.radius).toBe(0);
    expect(m.ripple).toBe(0);
    run(m, 300);
    expect(m.phase).toBe('opening');
    expect(m.radius).toBeGreaterThan(0);
    expect(m.ripple).toBeGreaterThan(0);
    run(m, 420);
    expect(m.phase).toBe('open');
    expect(m.radius).toBe(0.25);
    expect(m.ripple).toBe(1);
  });

  it('does not open when the spot has one year only', () => {
    const m = new LensMachine(tuning);
    m.setYears([2025], 2025);
    expect(m.toggle(true)).toBe(false);
    expect(m.phase).toBe('off');
    expect(m.year).toBeNull();
    expect(m.step(-1)).toBe(false); // and the dial does nothing
  });

  it('waits for the years when toggled on first', () => {
    const m = new LensMachine(tuning);
    expect(m.toggle(true)).toBe(false);
    expect(m.phase).toBe('off');
    expect(m.setYears(YEARS, 2025)).toBe(true);
    expect(m.phase).toBe('opening');
    expect(m.year).toBe(2023);
  });

  it('open <-> dialling follows the dial pinch; steps change the year and clamp', () => {
    const m = openMachine();
    run(m, 32, false, true);
    expect(m.phase).toBe('dialling');
    expect(m.step(-1)).toBe(true);
    expect(m.year).toBe(2019);
    expect(m.pastReady).toBe(false); // a new panorama must load first
    expect(m.yearHasPano).toBe(true);
    expect(m.step(-1)).toBe(true);
    expect(m.year).toBe(2018); // below the earliest Mapillary year: archive stop
    expect(m.yearHasPano).toBe(false);
    expect(m.step(-99)).toBe(true);
    expect(m.year).toBe(2000);
    expect(m.step(-1)).toBe(false); // clamped at the floor
    expect(m.step(+99)).toBe(true);
    expect(m.year).toBe(2023);
    expect(m.step(+1)).toBe(false); // 2025 is on screen, not on the dial
    run(m, 32, false, false);
    expect(m.phase).toBe('open');
  });

  it('a short tap does not push; a hold does, and completes with a commit', () => {
    const m = openMachine();
    run(m, 200, true);
    expect(m.phase).toBe('open');
    run(m, 32, false);
    run(m, 320, true);
    expect(m.phase).toBe('pushing');
    expect(m.followsHand).toBe(false);
    let prev = m.radius;
    const signals: LensSignal[] = [];
    for (let t = 0; t < 1700 && m.phase === 'pushing'; t += 16) {
      const s = m.update(16, true, false);
      if (s !== 'none') signals.push(s);
      expect(m.radius).toBeGreaterThanOrEqual(prev);
      prev = m.radius;
    }
    expect(signals).toEqual(['commit']);
    expect(m.phase).toBe('committed');
    expect(m.radius).toBe(Math.PI);
    expect(m.year).toBe(2023);
    // next frame: back to off, and TIME MACHINE is no longer wanted
    expect(m.update(16, true, false)).toBe('none');
    expect(m.phase).toBe('off');
    expect(m.wantOn).toBe(false);
    expect(m.year).toBeNull();
  });

  it('takes pushThroughMs to commit, not less', () => {
    const m = openMachine();
    run(m, 320, true);
    expect(m.phase).toBe('pushing');
    expect(run(m, 1500, true)).toEqual([]);
    expect(m.phase).toBe('pushing');
    expect(run(m, 150, true)).toEqual(['commit']);
  });

  it('letting go mid-push shrinks the lens back to open, with no commit', () => {
    const m = openMachine();
    run(m, 320, true);
    run(m, 800, true);
    expect(m.phase).toBe('pushing');
    const big = m.radius;
    expect(big).toBeGreaterThan(0.25);
    const signals = run(m, 100, false);
    expect(m.radius).toBeLessThan(big);
    signals.push(...run(m, 500, false));
    expect(signals).toEqual([]);
    expect(m.phase).toBe('open');
    expect(m.radius).toBe(0.25);
  });

  it('will not push before the past is loaded, on an archive year, or while dialling', () => {
    const m = openMachine();
    m.pastReady = false;
    run(m, 600, true);
    expect(m.phase).toBe('open');
    m.pastReady = true;
    m.step(-2); // 2018: archive stop
    m.pastReady = true;
    run(m, 600, true);
    expect(m.phase).toBe('open');
    m.step(+1); // 2019
    m.pastReady = true;
    run(m, 600, true, true);
    expect(m.phase).toBe('dialling');
  });

  it('ignores the dial while pushing', () => {
    const m = openMachine();
    run(m, 400, true);
    expect(m.phase).toBe('pushing');
    expect(m.step(-1)).toBe(false);
    expect(m.year).toBe(2023);
  });

  it('toggle off closes with a shrink, then reports closed', () => {
    const m = openMachine();
    expect(m.toggle(false)).toBe(false);
    expect(m.phase).toBe('closing');
    m.update(100, false, false);
    expect(m.radius).toBeLessThan(0.25);
    expect(m.radius).toBeGreaterThan(0);
    expect(run(m, 200)).toEqual(['closed']);
    expect(m.phase).toBe('off');
    expect(m.year).toBeNull();
    expect(m.radius).toBe(0);
  });

  it('a new panorama drops the lens at once and re-opens it against the new years', () => {
    const m = openMachine();
    m.clearYears();
    expect(m.phase).toBe('off');
    expect(m.wantOn).toBe(true);
    expect(m.setYears([2016, 2021, 2025], 2025)).toBe(true);
    expect(m.phase).toBe('opening');
    expect(m.year).toBe(2021);
  });

  it('after pushing through to the earliest year, the lens opens on the nearest later one', () => {
    const m = new LensMachine(tuning);
    m.setYears(YEARS, 2019);
    expect(m.toggle(true)).toBe(true);
    expect(m.year).toBe(2023);
    expect(m.years).toEqual([2000, 2010, 2018, 2023, 2025]);
  });
});
