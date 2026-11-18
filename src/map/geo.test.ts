import { describe, expect, it } from 'vitest';
import {
  clampZoom,
  isTap,
  latLngToPixel,
  MAX_ZOOM,
  MIN_ZOOM,
  nearestOnPolylines,
  panByPixels,
  pinchZoom,
  pixelToLatLng,
  planeLocalToPixel,
  project,
  unproject,
  wheelZoom,
  zoomAround,
  type MapView,
} from './geo.js';

const PX = 2048;
const timesSquare = (): MapView => ({ lat: 40.758, lng: -73.9855, zoom: 15 });

describe('projection', () => {
  it('round-trips lat/lng through world pixels', () => {
    const p = project(40.758, -73.9855, 15);
    const ll = unproject(p.x, p.y, 15);
    expect(ll.lat).toBeCloseTo(40.758, 9);
    expect(ll.lng).toBeCloseTo(-73.9855, 9);
  });

  it('puts the view centre at the canvas centre', () => {
    const v = timesSquare();
    const c = latLngToPixel(v, v.lat, v.lng, PX);
    expect(c.x).toBeCloseTo(PX / 2, 6);
    expect(c.y).toBeCloseTo(PX / 2, 6);
    const ll = pixelToLatLng(v, PX / 2, PX / 2, PX);
    expect(ll.lat).toBeCloseTo(v.lat, 9);
  });

  it('north is up and east is right', () => {
    const v = timesSquare();
    const north = latLngToPixel(v, v.lat + 0.001, v.lng, PX);
    const east = latLngToPixel(v, v.lat, v.lng + 0.001, PX);
    expect(north.y).toBeLessThan(PX / 2);
    expect(east.x).toBeGreaterThan(PX / 2);
  });
});

describe('table plane to canvas', () => {
  it('maps the far edge (local +y) to the top of the canvas', () => {
    expect(planeLocalToPixel(0, 0, 0.9, PX)).toEqual({ x: PX / 2, y: PX / 2 });
    const far = planeLocalToPixel(0, 0.45, 0.9, PX);
    expect(far.y).toBeCloseTo(0, 9);
    const right = planeLocalToPixel(0.45, 0, 0.9, PX);
    expect(right.x).toBeCloseTo(PX, 9);
  });
});

describe('pan', () => {
  it('content follows the pointer: dragging right moves the centre west', () => {
    const v = timesSquare();
    panByPixels(v, 100, 0);
    expect(v.lng).toBeLessThan(-73.9855);
    expect(v.lat).toBeCloseTo(40.758, 9);
  });

  it('a point under the pointer stays under it after the drag', () => {
    const v = timesSquare();
    const grabbed = pixelToLatLng(v, 800, 900, PX);
    const g = { lat: grabbed.lat, lng: grabbed.lng };
    panByPixels(v, 150, -70);
    const after = latLngToPixel(v, g.lat, g.lng, PX);
    expect(after.x).toBeCloseTo(950, 6);
    expect(after.y).toBeCloseTo(830, 6);
  });
});

describe('zoom', () => {
  it('clamps to the table range', () => {
    expect(clampZoom(3)).toBe(MIN_ZOOM);
    expect(clampZoom(25)).toBe(MAX_ZOOM);
    expect(clampZoom(15.5)).toBe(15.5);
  });

  it('two-hand spread: doubling the distance zooms in one level', () => {
    expect(pinchZoom(15, 100, 200)).toBeCloseTo(16, 9);
    expect(pinchZoom(15, 200, 100)).toBeCloseTo(14, 9);
    expect(pinchZoom(15, 0, 100)).toBe(15);
  });

  it('wheel: a notch is a quarter level, scroll up zooms in', () => {
    expect(wheelZoom(15, -100)).toBeCloseTo(15.25, 9);
    expect(wheelZoom(15, 100)).toBeCloseTo(14.75, 9);
  });

  it('zoomAround keeps the anchor point fixed on the canvas', () => {
    const v = timesSquare();
    const a = pixelToLatLng(v, 1500, 400, PX);
    const anchor = { lat: a.lat, lng: a.lng };
    zoomAround(v, 1500, 400, 16.3, PX);
    expect(v.zoom).toBeCloseTo(16.3, 9);
    const p = latLngToPixel(v, anchor.lat, anchor.lng, PX);
    expect(p.x).toBeCloseTo(1500, 5);
    expect(p.y).toBeCloseTo(400, 5);
  });
});

describe('pick snapping', () => {
  const line = [
    { x: 0, y: 100 },
    { x: 200, y: 100 },
  ];

  it('snaps onto the nearest segment', () => {
    const s = nearestOnPolylines(50, 120, [line], 48);
    expect(s).not.toBeNull();
    expect(s!.x).toBeCloseTo(50, 9);
    expect(s!.y).toBeCloseTo(100, 9);
    expect(s!.distance).toBeCloseTo(20, 9);
  });

  it('returns null when nothing is close enough', () => {
    expect(nearestOnPolylines(50, 300, [line], 48)).toBeNull();
    expect(nearestOnPolylines(50, 300, [], 48)).toBeNull();
  });

  it('picks the closer of two lines and handles single points', () => {
    const other = [
      { x: 0, y: 130 },
      { x: 200, y: 130 },
    ];
    expect(nearestOnPolylines(50, 125, [line, other])!.y).toBeCloseTo(130, 9);
    expect(nearestOnPolylines(12, 10, [[{ x: 10, y: 10 }]])!.distance).toBeCloseTo(2, 9);
  });
});

describe('tap versus drag', () => {
  it('a short, still press is a tap', () => {
    expect(isTap(5, 200, PX, 1.7)).toBe(true);
    expect(isTap(80, 200, PX, 1.7)).toBe(false);
    expect(isTap(5, 1500, PX, 1.7)).toBe(false);
    // The threshold is a distance on the table (17 mm), not a share of the canvas.
    expect(isTap(PX * 0.0099, 200, PX, 1.7)).toBe(true);
    expect(isTap(PX * 0.0099, 200, PX, 3.4)).toBe(false);
  });
});

describe('smooth zoom', () => {
  it('eases toward the target without overshoot and lands exactly on it', async () => {
    const { stepZoom, ZOOM_EASE_MS } = await import('./geo.js');
    let z = 14;
    const seen: number[] = [];
    for (let i = 0; i < 60; i++) {
      z = stepZoom(z, 16, 14); // 72 Hz frames
      seen.push(z);
    }
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(Math.max(...seen)).toBe(16);
    expect(seen[0]).toBeLessThan(14.5); // no jump on the first frame
    // One time constant covers 1 - 1/e of the distance.
    expect(stepZoom(14, 16, ZOOM_EASE_MS)).toBeCloseTo(14 + 2 * (1 - Math.exp(-1)), 5);
  });

  it('is frame-rate independent and never leaves the clamp', async () => {
    const { stepZoom } = await import('./geo.js');
    const once = stepZoom(13, 17, 40);
    const twice = stepZoom(stepZoom(13, 17, 20), 17, 20);
    expect(twice).toBeCloseTo(once, 6);
    let z = 17.5;
    for (let i = 0; i < 200; i++) z = stepZoom(z, 99, 14);
    expect(z).toBe(MAX_ZOOM);
    for (let i = 0; i < 300; i++) z = stepZoom(z, -5, 14);
    expect(z).toBe(MIN_ZOOM);
    expect(stepZoom(15, 16, 0)).toBe(15);
  });

  it('thumbstick: deadzone, direction and full-deflection speed', async () => {
    const { stickZoomRate, STICK_ZOOM_PER_S } = await import('./geo.js');
    expect(stickZoomRate(0.2)).toBe(0);
    expect(stickZoomRate(-0.25)).toBe(0);
    expect(stickZoomRate(Number.NaN)).toBe(0);
    expect(stickZoomRate(-1)).toBeCloseTo(STICK_ZOOM_PER_S); // push away = zoom in
    expect(stickZoomRate(1)).toBeCloseTo(-STICK_ZOOM_PER_S);
    expect(stickZoomRate(-0.26)).toBeGreaterThan(0);
    expect(stickZoomRate(-0.26)).toBeLessThan(0.05); // starts from zero at the deadzone edge
  });

  it('zoom rail maps its length onto the zoom range, both ways', async () => {
    const { railToZoom, zoomToRail } = await import('./geo.js');
    expect(railToZoom(0)).toBe(MIN_ZOOM);
    expect(railToZoom(1)).toBe(MAX_ZOOM);
    expect(railToZoom(0.5)).toBe((MIN_ZOOM + MAX_ZOOM) / 2);
    expect(railToZoom(-3)).toBe(MIN_ZOOM);
    expect(railToZoom(7)).toBe(MAX_ZOOM);
    expect(zoomToRail(railToZoom(0.3))).toBeCloseTo(0.3);
    expect(zoomToRail(99)).toBe(1);
  });
});
