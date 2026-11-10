/**
 * Pure maths for the pano stage. No Three.js, no DOM: unit-tested in node.
 *
 * Conventions (from `src/contracts.ts`): headings are degrees clockwise from north; world
 * north is -Z, east is +X, up is +Y. A panorama's centre column (u = 0.5) looks toward its
 * heading, and u grows clockwise (to the right when seen from inside the sphere).
 */
import { config } from '../config.js';
import type { LatLng } from '../contracts.js';

const DEG = Math.PI / 180;

/** Normalise an angle in degrees to [0, 360). */
export function wrapDeg(deg: number): number {
  const w = deg % 360;
  return w < 0 ? w + 360 : w;
}

/** Compass azimuth (degrees clockwise from north) of a world-space direction. */
export function azimuthOfDir(x: number, z: number): number {
  return wrapDeg(Math.atan2(x, -z) / DEG);
}

/** World-space horizontal unit direction for a compass bearing. */
export function dirOfBearing(bearingDeg: number): { x: number; z: number } {
  return { x: Math.sin(bearingDeg * DEG), z: -Math.cos(bearingDeg * DEG) };
}

/**
 * Horizontal texture coordinate that the stage shader samples for a world azimuth.
 * Mirrors `dirToUv` in `stage-shader.ts`: u = fract(0.5 + (azimuth - heading) / 360).
 */
export function uOfAzimuth(azimuthDeg: number, headingDeg: number): number {
  const u = 0.5 + (azimuthDeg - headingDeg) / 360;
  return u - Math.floor(u);
}

/** Inverse of `uOfAzimuth`: the world azimuth at which column `u` of a panorama appears. */
export function azimuthOfU(u: number, headingDeg: number): number {
  return wrapDeg(headingDeg + (u - 0.5) * 360);
}

/** Vertical texture coordinate (0 = top row, flipY off) for a direction's elevation. */
export function vOfElevation(dirY: number): number {
  return 0.5 - Math.asin(Math.max(-1, Math.min(1, dirY))) / Math.PI;
}

/** Initial great-circle bearing from `a` to `b`, degrees clockwise from north. */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const p1 = a.lat * DEG;
  const p2 = b.lat * DEG;
  const dl = (b.lng - a.lng) * DEG;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrapDeg(Math.atan2(y, x) / DEG);
}

/** Smallest absolute difference between two bearings, degrees (0..180). */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(wrapDeg(a) - wrapDeg(b));
  return d > 180 ? 360 - d : d;
}

export type TextureKind = 'current' | 'past' | 'preview';

/** Mapillary's `thumb_2048_url` is 2048 px across. */
export const PREVIEW_WIDTH = 2048;

/** Width cap for a texture kind, from `config.texture`. Headset = an XR session or Quest Browser. */
export function widthCap(kind: TextureKind, headset: boolean): number {
  const t = config.texture;
  const current = headset ? t.currentMaxWidthHeadset : t.currentMaxWidthDesktop;
  if (kind === 'current') return current;
  if (kind === 'past') return t.pastMaxWidth;
  return Math.min(PREVIEW_WIDTH, current);
}

export interface TextureSize {
  width: number;
  height: number;
  /** True when the decode must downscale (source is larger than the cap). */
  resized: boolean;
}

/**
 * Decode size for a panorama: never wider than `cap`, never larger than the GPU's
 * `maxTextureSize` in either dimension, aspect kept, never upscaled. Unknown source sizes
 * (0 or negative) assume an equirectangular 2:1 image at the cap.
 */
export function textureSizeFor(
  srcWidth: number,
  srcHeight: number,
  cap: number,
  maxTextureSize: number,
): TextureSize {
  const known = srcWidth > 0 && srcHeight > 0;
  const sw = known ? srcWidth : cap;
  const sh = known ? srcHeight : cap / 2;
  let width = Math.min(sw, cap, maxTextureSize);
  let height = Math.round((width * sh) / sw);
  if (height > maxTextureSize) {
    height = maxTextureSize;
    width = Math.round((height * sw) / sh);
  }
  width = Math.max(1, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  return { width, height, resized: !known || width < sw };
}

/** Rough GPU bytes for an RGBA8 texture without mipmaps. */
export function textureBytes(width: number, height: number): number {
  return width * height * 4;
}

/**
 * Choose hop-arrow targets: nearest first (the source's order), at most `max`, skipping any
 * whose bearing is within `minSeparationDeg` of one already kept, and any at the same spot.
 */
export function pickArrowTargets<T extends LatLng>(
  from: LatLng,
  candidates: readonly T[],
  max: number,
  minSeparationDeg: number,
): Array<{ target: T; bearing: number }> {
  const kept: Array<{ target: T; bearing: number }> = [];
  for (const target of candidates) {
    if (kept.length >= max) break;
    if (Math.abs(target.lat - from.lat) < 1e-9 && Math.abs(target.lng - from.lng) < 1e-9) continue;
    const bearing = bearingBetween(from, target);
    if (kept.some((k) => angleDiff(k.bearing, bearing) < minSeparationDeg)) continue;
    kept.push({ target, bearing });
  }
  return kept;
}
