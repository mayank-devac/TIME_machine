/**
 * Pure map maths for the table. No DOM, no MapLibre, no Three.js, so vitest can run it.
 *
 * The table map is drawn north-up with no bearing or pitch, so a plain Web Mercator
 * projection with MapLibre's 512 px tile size maps canvas pixels to lat/lng exactly.
 * Pixel coordinates are canvas pixels, origin top-left, y down (the same as `map.unproject`).
 */

import type { LatLng } from '../contracts.js';

/** MapLibre's world tile size in CSS pixels. */
export const TILE_PX = 512;
const MAX_LAT = 85.0511287798;

/** Zoom range the table allows. Below 12 a 0.9 m table shows too many tiles (quota); above 18 nothing new appears. */
export const MIN_ZOOM = 12;
export const MAX_ZOOM = 18;

export interface MapView extends LatLng {
  zoom: number;
}

export interface Pixel {
  x: number;
  y: number;
}

export function worldSize(zoom: number): number {
  return TILE_PX * 2 ** zoom;
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function wrapLng(lng: number): number {
  const w = ((((lng + 180) % 360) + 360) % 360) - 180;
  return w === -180 && lng > 0 ? 180 : w;
}

/** Lat/lng to world pixels at `zoom`. Writes into `out` when given (no allocation). */
export function project(lat: number, lng: number, zoom: number, out: Pixel = { x: 0, y: 0 }): Pixel {
  const ws = worldSize(zoom);
  const phi = (Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180;
  out.x = ((lng + 180) / 360) * ws;
  out.y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * ws;
  return out;
}

/** World pixels at `zoom` to lat/lng. */
export function unproject(x: number, y: number, zoom: number, out: LatLng = { lat: 0, lng: 0 }): LatLng {
  const ws = worldSize(zoom);
  out.lng = wrapLng((x / ws) * 360 - 180);
  const n = Math.PI - (2 * Math.PI * y) / ws;
  out.lat = (180 / Math.PI) * Math.atan(Math.sinh(n));
  return out;
}

/**
 * A hit on the table plane, in the plane's local space (PlaneGeometry: x right, y toward the
 * far edge, centred), to canvas pixels. The far edge of the table is north (top of the canvas).
 */
export function planeLocalToPixel(
  localX: number,
  localY: number,
  sizeM: number,
  canvasPx: number,
  out: Pixel = { x: 0, y: 0 },
): Pixel {
  out.x = (localX / sizeM + 0.5) * canvasPx;
  out.y = (0.5 - localY / sizeM) * canvasPx;
  return out;
}

const scratch: Pixel = { x: 0, y: 0 };

/** Canvas pixel to lat/lng for a north-up view centred on `view`. */
export function pixelToLatLng(view: MapView, px: number, py: number, canvasPx: number, out: LatLng = { lat: 0, lng: 0 }): LatLng {
  const c = project(view.lat, view.lng, view.zoom, scratch);
  return unproject(c.x + (px - canvasPx / 2), c.y + (py - canvasPx / 2), view.zoom, out);
}

/** Lat/lng to canvas pixel for a north-up view centred on `view`. */
export function latLngToPixel(view: MapView, lat: number, lng: number, canvasPx: number, out: Pixel = { x: 0, y: 0 }): Pixel {
  const c = project(view.lat, view.lng, view.zoom, scratch);
  const cx = c.x;
  const cy = c.y;
  project(lat, lng, view.zoom, out);
  out.x = out.x - cx + canvasPx / 2;
  out.y = out.y - cy + canvasPx / 2;
  return out;
}

/**
 * Drag: the content follows the pointer. Moving the pointer by (dx, dy) canvas pixels moves
 * the centre the opposite way. Mutates and returns `view`.
 */
export function panByPixels(view: MapView, dx: number, dy: number): MapView {
  const c = project(view.lat, view.lng, view.zoom, scratch);
  const ws = worldSize(view.zoom);
  const y = Math.max(0, Math.min(ws, c.y - dy));
  unproject(c.x - dx, y, view.zoom, view);
  return view;
}

/**
 * Zoom so the lat/lng under canvas pixel (ax, ay) stays under it. Mutates and returns `view`.
 */
export function zoomAround(view: MapView, ax: number, ay: number, newZoom: number, canvasPx: number): MapView {
  const z = clampZoom(newZoom);
  const anchorLat = pixelToLatLng(view, ax, ay, canvasPx, anchorScratch).lat;
  const anchorLng = anchorScratch.lng;
  const a = project(anchorLat, anchorLng, z, scratch);
  unproject(a.x - (ax - canvasPx / 2), a.y - (ay - canvasPx / 2), z, view);
  view.zoom = z;
  return view;
}
const anchorScratch: LatLng = { lat: 0, lng: 0 };

/** Two-hand spread: zoom changes by log2 of the distance ratio (double the spread, +1 zoom). */
export function pinchZoom(startZoom: number, startDistance: number, currentDistance: number): number {
  if (startDistance <= 1e-6 || currentDistance <= 1e-6) return clampZoom(startZoom);
  return clampZoom(startZoom + Math.log2(currentDistance / startDistance));
}

/** Mouse wheel: one notch (deltaY 100) is a quarter of a zoom level. */
export function wheelZoom(zoom: number, deltaY: number): number {
  return clampZoom(zoom - deltaY / 400);
}

export interface Snap extends Pixel {
  /** Distance from the query point, in canvas pixels. */
  distance: number;
}

/**
 * Nearest point to (px, py) on a set of polylines given in canvas pixels. Null when there are
 * no segments or nothing lies within `maxDistance`. Used to snap a pick onto a coverage line.
 */
export function nearestOnPolylines(px: number, py: number, lines: Pixel[][], maxDistance = Infinity): Snap | null {
  let best: Snap | null = null;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      const a = line[i];
      const b = line[i + 1] ?? a;
      const abx = b.x - a.x;
      const aby = b.y - a.y;
      const len2 = abx * abx + aby * aby;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * abx + (py - a.y) * aby) / len2)) : 0;
      const x = a.x + t * abx;
      const y = a.y + t * aby;
      const d = Math.hypot(px - x, py - y);
      if (d <= maxDistance && (!best || d < best.distance)) best = { x, y, distance: d };
      if (line.length > 1 && i === line.length - 2) break;
    }
  }
  return best;
}

/**
 * Tells a click (a pick) from a drag. `travelPx` is the total pointer travel in canvas
 * pixels since the press.
 */
export function isTap(travelPx: number, durationMs: number, canvasPx: number): boolean {
  // 1 % of the canvas is about 9 mm on a 0.9 m table: generous for a noisy hand ray.
  return travelPx <= canvasPx * 0.01 && durationMs <= 700;
}
