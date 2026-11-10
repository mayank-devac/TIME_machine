import { describe, expect, it } from 'vitest';
import { config } from '../config.js';
import fixtures from '../mocks/fixtures.json';
import {
  angleDiff,
  azimuthOfDir,
  azimuthOfU,
  bearingBetween,
  dirOfBearing,
  pickArrowTargets,
  textureSizeFor,
  uOfAzimuth,
  vOfElevation,
  widthCap,
} from './pano-math.js';

describe('heading maths', () => {
  it('maps world directions to compass azimuths (north -Z, east +X)', () => {
    expect(azimuthOfDir(0, -1)).toBeCloseTo(0);
    expect(azimuthOfDir(1, 0)).toBeCloseTo(90);
    expect(azimuthOfDir(0, 1)).toBeCloseTo(180);
    expect(azimuthOfDir(-1, 0)).toBeCloseTo(270);
  });

  it('round-trips bearing -> direction -> azimuth', () => {
    for (const b of [0, 13, 90, 181, 299.5]) {
      const d = dirOfBearing(b);
      expect(azimuthOfDir(d.x, d.z)).toBeCloseTo(b);
    }
  });

  it('puts the centre column on the heading and grows u clockwise', () => {
    expect(uOfAzimuth(202.7, 202.7)).toBeCloseTo(0.5);
    expect(uOfAzimuth(292.7, 202.7)).toBeCloseTo(0.75); // 90 deg clockwise of heading
    expect(uOfAzimuth(112.7, 202.7)).toBeCloseTo(0.25);
    expect(uOfAzimuth(22.7, 202.7)).toBeCloseTo(0); // behind: the seam
  });

  it('inverts uOfAzimuth', () => {
    for (const h of [0, 202.74, 298.23]) {
      for (const az of [5, 120, 359]) expect(azimuthOfU(uOfAzimuth(az, h), h)).toBeCloseTo(az);
    }
  });

  it('keeps north fixed between two panoramas with different headings', () => {
    const [a, b] = fixtures;
    // The same world direction samples each image at the column that looks that way.
    for (const az of [0, 90, 217]) {
      expect(azimuthOfU(uOfAzimuth(az, a.heading), a.heading)).toBeCloseTo(az);
      expect(azimuthOfU(uOfAzimuth(az, b.heading), b.heading)).toBeCloseTo(az);
    }
  });

  it('maps elevation to v with the top row at 0', () => {
    expect(vOfElevation(1)).toBeCloseTo(0);
    expect(vOfElevation(0)).toBeCloseTo(0.5);
    expect(vOfElevation(-1)).toBeCloseTo(1);
  });

  it('measured landmark directions in the fixtures agree with geography (see README)', () => {
    // Columns measured on the 2048 px fixtures; expected bearings from map coordinates.
    const [p2023, p2025] = fixtures;
    const hm = azimuthOfU(940 / 2048, p2023.heading); // H&M tower, 42nd St
    expect(angleDiff(hm, bearingBetween(p2023, { lat: 40.7553, lng: -73.9864 }))).toBeLessThan(10);
    const para23 = azimuthOfU(1129 / 2048, p2023.heading); // Paramount Building
    const para25 = azimuthOfU(665 / 2048, p2025.heading);
    const paramount = { lat: 40.757, lng: -73.9866 };
    expect(angleDiff(para23, bearingBetween(p2023, paramount))).toBeLessThan(10);
    expect(angleDiff(para25, bearingBetween(p2025, paramount))).toBeLessThan(20);
    // A sign error or a 180 deg zero-point error would miss by far more than 20 deg.
    expect(angleDiff(para23, para25)).toBeLessThan(20);
  });
});

describe('bearings', () => {
  it('computes compass bearings between points', () => {
    const o = { lat: 40.758, lng: -73.985 };
    expect(bearingBetween(o, { lat: 40.759, lng: -73.985 })).toBeCloseTo(0, 0);
    expect(bearingBetween(o, { lat: 40.758, lng: -73.984 })).toBeCloseTo(90, 0);
    expect(bearingBetween(o, { lat: 40.757, lng: -73.985 })).toBeCloseTo(180, 0);
    expect(bearingBetween(o, { lat: 40.758, lng: -73.986 })).toBeCloseTo(270, 0);
  });

  it('measures the smallest angle between bearings', () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(20);
    expect(angleDiff(90, 270)).toBe(180);
  });

  it('picks arrow targets nearest first, de-duplicated by direction, capped', () => {
    const o = { lat: 40.758, lng: -73.985 };
    const n1 = { id: 'n1', lat: 40.7581, lng: -73.985 }; // north
    const n2 = { id: 'n2', lat: 40.7585, lng: -73.98499 }; // also north -> dropped
    const s1 = { id: 's1', lat: 40.7579, lng: -73.985 }; // south
    const e1 = { id: 'e1', lat: 40.758, lng: -73.9849 }; // east
    const same = { id: 'same', lat: o.lat, lng: o.lng };
    const picked = pickArrowTargets(o, [same, n1, n2, s1, e1], 2, 35);
    expect(picked.map((p) => p.target.id)).toEqual(['n1', 's1']);
    expect(pickArrowTargets(o, [n1, n2, s1, e1], 4, 35).map((p) => p.target.id)).toEqual(['n1', 's1', 'e1']);
  });
});

describe('texture caps', () => {
  it('reads the caps from config', () => {
    expect(widthCap('current', false)).toBe(config.texture.currentMaxWidthDesktop);
    expect(widthCap('current', true)).toBe(config.texture.currentMaxWidthHeadset);
    expect(widthCap('past', true)).toBe(config.texture.pastMaxWidth);
    expect(widthCap('preview', false)).toBe(2048);
  });

  it('downscales to the cap, keeps 2:1, never upscales', () => {
    expect(textureSizeFor(7680, 3840, 5760, 16384)).toEqual({ width: 5760, height: 2880, resized: true });
    expect(textureSizeFor(5760, 2880, 8192, 16384)).toEqual({ width: 5760, height: 2880, resized: false });
    expect(textureSizeFor(2048, 1024, 4096, 16384)).toEqual({ width: 2048, height: 1024, resized: false });
  });

  it('respects the GPU maxTextureSize', () => {
    expect(textureSizeFor(7680, 3840, 8192, 4096)).toEqual({ width: 4096, height: 2048, resized: true });
    // A tall image is limited by its height.
    expect(textureSizeFor(1000, 9000, 8192, 4096).height).toBeLessThanOrEqual(4096);
  });

  it('assumes 2:1 at the cap when the source size is unknown', () => {
    expect(textureSizeFor(0, 0, 2048, 16384)).toEqual({ width: 2048, height: 1024, resized: true });
  });
});
