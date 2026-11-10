import { describe, expect, it } from 'vitest';
import { closeRadius, easeInOutCubic, openRadius, pushRadius, rimOpacity } from './curves.js';
import { DialTracker, WheelAccumulator, twistAboutLocalZ, wrapAngle } from './dial.js';
import type { QuatLike } from './dial.js';
import {
  angleBetween,
  azimuthDeg,
  clientToNdcX,
  clientToNdcY,
  directionBetween,
  ndcToDirection,
  smoothDirection,
  smoothingAlpha,
} from './lens-math.js';
import { archiveStops, buildLadder, defaultYear, isPanoYear, stepYear } from './years.js';

const deg = (d: number): number => (d * Math.PI) / 180;

/** Quaternion for a rotation of `angle` about a unit axis. */
function quat(ax: number, ay: number, az: number, angle: number): QuatLike {
  const s = Math.sin(angle / 2);
  return { x: ax * s, y: ay * s, z: az * s, w: Math.cos(angle / 2) };
}
function mul(a: QuatLike, b: QuatLike): QuatLike {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

describe('year ladder', () => {
  it('builds archive stops in decades plus the year before the earliest', () => {
    expect(archiveStops(2016, 1990)).toEqual([1990, 2000, 2010, 2015]);
    expect(archiveStops(2011, 2000)).toEqual([2000, 2010]);
    expect(archiveStops(1900, 1900)).toEqual([]);
  });

  it('leaves the year on screen out of the ladder', () => {
    expect(buildLadder([2025, 2019, 2023], 2025, 2000)).toEqual([2000, 2010, 2018, 2019, 2023]);
    expect(buildLadder([2019, 2023, 2025], 2019, 2010)).toEqual([2010, 2018, 2023, 2025]);
    expect(buildLadder([], 2025, 1900)).toEqual([]);
  });

  it('opens on the latest earlier year, else the nearest later one, else nothing', () => {
    expect(defaultYear([2019, 2023, 2025], 2025)).toBe(2023);
    expect(defaultYear([2019, 2023, 2025], 2023)).toBe(2019);
    expect(defaultYear([2019, 2023, 2025], 2019)).toBe(2023);
    expect(defaultYear([2025], 2025)).toBeNull();
    expect(defaultYear([], 2025)).toBeNull();
  });

  it('steps and clamps at both ends', () => {
    const ladder = buildLadder([2019, 2023, 2025], 2025, 2000);
    expect(stepYear(ladder, 2023, -1)).toBe(2019);
    expect(stepYear(ladder, 2019, -1)).toBe(2018); // below the earliest Mapillary year
    expect(stepYear(ladder, 2018, -1)).toBe(2010);
    expect(stepYear(ladder, 2000, -1)).toBe(2000); // floor
    expect(stepYear(ladder, 2023, +1)).toBe(2023); // ceiling: 2025 is on screen
    expect(stepYear(ladder, 2023, -99)).toBe(2000);
    expect(stepYear(ladder, 2000, +99)).toBe(2023);
    expect(stepYear([], 2023, -1)).toBe(2023);
  });

  it('snaps a year that is not on the ladder to the nearest stop before stepping', () => {
    expect(stepYear([2000, 2010, 2019], 2012, +1)).toBe(2019);
  });

  it('knows which years have a panorama', () => {
    expect(isPanoYear([2019, 2023], 2019)).toBe(true);
    expect(isPanoYear([2019, 2023], 2018)).toBe(false);
    expect(isPanoYear([2019, 2023], null)).toBe(false);
  });
});

describe('dial', () => {
  it('wraps angles to (-PI, PI]', () => {
    expect(wrapAngle(deg(190))).toBeCloseTo(deg(-170));
    expect(wrapAngle(deg(-190))).toBeCloseTo(deg(170));
    expect(wrapAngle(deg(720))).toBeCloseTo(0);
  });

  it('measures roll about the hand axis and ignores arm swing', () => {
    const start = quat(0, 1, 0, deg(40)); // hand turned 40 degrees to the side
    const rolled = mul(start, quat(0, 0, 1, deg(30))); // then rolled 30 degrees about its own Z
    expect(twistAboutLocalZ(start, rolled)).toBeCloseTo(deg(30));
    const rolledBack = mul(start, quat(0, 0, 1, deg(-50)));
    expect(twistAboutLocalZ(start, rolledBack)).toBeCloseTo(deg(-50));
    const swung = mul(start, quat(1, 0, 0, deg(35))); // pitch only: not a twist
    expect(twistAboutLocalZ(start, swung)).toBeCloseTo(0);
    expect(twistAboutLocalZ(start, start)).toBeCloseTo(0);
  });

  it('maps twist angle to whole year steps', () => {
    const dial = new DialTracker(deg(25));
    dial.begin(0);
    expect(dial.update(deg(10))).toBe(0);
    expect(dial.update(deg(26))).toBe(1);
    expect(dial.update(deg(49))).toBe(0);
    expect(dial.update(deg(80))).toBe(2); // 26..80 crosses 50 and 75
    expect(dial.update(deg(-30))).toBe(-4); // back through 50, 25, 0, -25
  });

  it('has hysteresis: trembling at a boundary does not flip the year', () => {
    const dial = new DialTracker(deg(25));
    dial.begin(0);
    expect(dial.update(deg(25.5))).toBe(1);
    expect(dial.update(deg(24.5))).toBe(0);
    expect(dial.update(deg(25.5))).toBe(0);
    expect(dial.update(deg(1))).toBe(0);
    expect(dial.update(deg(-0.5))).toBe(-1); // a full step back from the detent at 25
  });

  it('unwraps through 180 degrees and does nothing when inactive', () => {
    const dial = new DialTracker(deg(30));
    expect(dial.update(deg(90))).toBe(0); // not begun
    dial.begin(0);
    let steps = 0;
    for (const a of [60, 120, 170, -170, -120]) steps += dial.update(deg(a)); // really 60..240
    expect(steps).toBe(8);
    dial.end();
    expect(dial.update(deg(0))).toBe(0);
  });

  it('turns wheel travel into steps; scrolling down goes earlier', () => {
    const wheel = new WheelAccumulator(100);
    wheel.add(40);
    expect(wheel.take()).toBe(0);
    wheel.add(70);
    expect(wheel.take()).toBe(-1);
    wheel.add(-310);
    expect(wheel.take()).toBe(3);
    expect(wheel.take()).toBe(0);
  });
});

describe('curves', () => {
  it('opens from 0, lands exactly on the radius, never wobbles more than the cap', () => {
    const R = 0.25;
    const cap = 0.02;
    expect(openRadius(0, R, 700, cap)).toBe(0);
    expect(openRadius(700, R, 700, cap)).toBe(R);
    expect(openRadius(5000, R, 700, cap)).toBe(R);
    for (let ms = 0; ms <= 700; ms += 5) {
      const r = openRadius(ms, R, 700, cap);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(R + cap);
      if (ms >= 700 * 0.45) expect(Math.abs(r - R)).toBeLessThanOrEqual(cap); // ripple part
    }
  });

  it('push-through runs from the lens radius to exactly PI, monotonically', () => {
    expect(pushRadius(0, 0.25)).toBe(0.25);
    expect(pushRadius(1, 0.25)).toBe(Math.PI);
    expect(pushRadius(2, 0.25)).toBe(Math.PI);
    let prev = 0;
    for (let t = 0; t <= 1.0001; t += 0.01) {
      const r = pushRadius(t, 0.25);
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5);
    // gentle start: a tenth of the way in, under 1 percent of the travel
    expect(easeInOutCubic(0.1)).toBeLessThan(0.01);
  });

  it('closes to zero and fades the rim out by PI', () => {
    expect(closeRadius(0, 0.25)).toBe(0.25);
    expect(closeRadius(1, 0.25)).toBe(0);
    expect(rimOpacity(0.25, 1.1)).toBe(1);
    expect(rimOpacity(Math.PI, 1.1)).toBe(0);
    expect(rimOpacity(2, 1.1)).toBeGreaterThan(0);
    expect(rimOpacity(2, 1.1)).toBeLessThan(1);
  });
});

describe('lens direction', () => {
  it('points from the head to the hand, unit length', () => {
    const out = { x: 0, y: 0, z: 0 };
    const ok = directionBetween({ x: 0, y: 1.6, z: 0 }, { x: 0.3, y: 1.2, z: -0.4 }, { x: 0, y: 0, z: -1 }, out);
    expect(ok).toBe(true);
    expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1);
    expect(out.x).toBeGreaterThan(0);
    expect(out.y).toBeLessThan(0);
    expect(out.z).toBeLessThan(0);
  });

  it('falls back when the hand is at the head', () => {
    const out = { x: 9, y: 9, z: 9 };
    const ok = directionBetween({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: -1 }, out);
    expect(ok).toBe(false);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
  });

  // 90 degree vertical fov, aspect 2: m00 = 1 / (aspect * tan 45) = 0.5, m11 = 1.
  const proj = [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

  it('turns a screen point into a view ray', () => {
    const out = { x: 0, y: 0, z: 0 };
    ndcToDirection(0, 0, proj, identity, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.y).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(-1);
    ndcToDirection(0, 1, proj, identity, out); // top edge: 45 degrees up
    expect(angleBetween(out, { x: 0, y: 0, z: -1 })).toBeCloseTo(deg(45));
    expect(out.y).toBeGreaterThan(0);
    ndcToDirection(1, 0, proj, identity, out); // right edge: atan(2) to the right
    expect(out.x).toBeGreaterThan(0);
    expect(angleBetween(out, { x: 0, y: 0, z: -1 })).toBeCloseTo(Math.atan(2));
  });

  it('follows the camera when it has turned (drag to look)', () => {
    // Camera yawed 90 degrees to the right: its -Z now looks along world +X (east).
    const yawRight = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 5, 1.6, 2, 1];
    const out = { x: 0, y: 0, z: 0 };
    ndcToDirection(0, 0, proj, yawRight, out);
    expect(out.x).toBeCloseTo(1);
    expect(out.z).toBeCloseTo(0);
    expect(azimuthDeg(out)).toBeCloseTo(90); // east; camera position does not matter
  });

  it('maps client pixels to NDC and survives a zero-sized canvas', () => {
    expect(clientToNdcX(100, 100, 800)).toBe(-1);
    expect(clientToNdcX(900, 100, 800)).toBe(1);
    expect(clientToNdcY(50, 50, 600)).toBe(1);
    expect(clientToNdcY(650, 50, 600)).toBe(-1);
    expect(clientToNdcX(500, 0, 0)).toBe(0);
    expect(clientToNdcY(500, 0, 0)).toBe(0);
  });

  it('smooths toward the target and stays unit length', () => {
    const cur = { x: 0, y: 0, z: -1 };
    const target = { x: 1, y: 0, z: 0 };
    const before = angleBetween(cur, target);
    smoothDirection(cur, target, smoothingAlpha(16, 45));
    expect(Math.hypot(cur.x, cur.y, cur.z)).toBeCloseTo(1);
    expect(angleBetween(cur, target)).toBeLessThan(before);
    for (let i = 0; i < 200; i++) smoothDirection(cur, target, smoothingAlpha(16, 45));
    expect(angleBetween(cur, target)).toBeLessThan(1e-3);
    expect(smoothingAlpha(16, 0)).toBe(1);
  });

  it('reports compass azimuth with north at -Z and east at +X', () => {
    expect(azimuthDeg({ x: 0, y: 0, z: -1 })).toBeCloseTo(0);
    expect(azimuthDeg({ x: 1, y: 0, z: 0 })).toBeCloseTo(90);
    expect(azimuthDeg({ x: 0, y: 0, z: 1 })).toBeCloseTo(180);
    expect(azimuthDeg({ x: -1, y: 0, z: 0 })).toBeCloseTo(270);
  });
});
