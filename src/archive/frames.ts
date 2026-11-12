import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  SRGBColorSpace,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import type { ArchivePhoto } from '../contracts.js';
import { DragRig, placements } from '../drag.js';
import { readHead } from '../head.js';
import { currentTokens, onThemeChange, withAlpha } from '../theme.js';
import { ArchivePhotoTag, HoverFx } from '../track-components.js';
import type { PhotoRenderer } from './controller.js';

/** Layout constants. Distances are metres, angles degrees. */
export const LAYOUT = {
  distanceM: 2,
  frameWidthM: 0.8,
  spacingDeg: 26,
  /** Odd frame counts put one in the middle; lift it so the straight-ahead view stays clear. */
  centreLiftM: 0.35,
  fadeSeconds: 0.35,
} as const;

const CANVAS_W = 800;
const PAD = 24;
const CAPTION_H = 210;

/** Panel ids of the frames in `placements`: `archive-0`, `archive-1`, ... by position in the arc. */
export const ARCHIVE_ID_PREFIX = 'archive-';

interface Frame {
  entity: Entity;
  /** What the user grabs to move the frame; the photo mesh is its child. */
  rig: DragRig;
  photo: ArchivePhoto;
  canvas: HTMLCanvasElement;
  mesh: Mesh;
  material: MeshBasicMaterial;
  texture: CanvasTexture;
  /** Target opacity: 1 while visible, 0 while fading out. */
  target: number;
}

/** Frames currently alive. Module-level so the fade system can iterate without allocating. */
const live: Frame[] = [];

function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return `${t}…`;
}

/** Wrap into at most `maxLines` lines; the last line is ellipsized if the text still overflows. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxLines: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= maxW || !line) {
      line = next;
    } else if (lines.length < maxLines - 1) {
      lines.push(line);
      line = words[i];
    } else {
      line = `${line} ${words.slice(i).join(' ')}`;
      break;
    }
  }
  if (line) lines.push(ellipsize(ctx, line, maxW));
  return lines;
}

/** Size of the photo area on a frame canvas for an image of `iw` x `ih`. */
function photoBox(iw: number, ih: number): { w: number; h: number } {
  const w = CANVAS_W - PAD * 2;
  return { w, h: Math.round(Math.min(560, Math.max(300, (w * ih) / iw))) };
}

/**
 * Draw photo + caption (year, title, credit) onto one canvas, in the current theme's colours.
 * Pass `into` to redraw an existing frame canvas (theme change) instead of making a new one.
 */
export function drawFrame(
  photo: ArchivePhoto,
  image: CanvasImageSource,
  iw: number,
  ih: number,
  into?: HTMLCanvasElement,
): HTMLCanvasElement {
  const t = currentTokens();
  const { w: photoW, h: photoH } = photoBox(iw, ih);
  const canvas = into ?? document.createElement('canvas');
  canvas.width = CANVAS_W; // also clears it
  canvas.height = PAD + photoH + CAPTION_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = t.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = t.border;
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
  ctx.fillStyle = withAlpha(t.textPrimary, 0.12); // a faint mat around the photo
  ctx.fillRect(PAD - 6, PAD - 6, photoW + 12, photoH + 12);
  // cover-fit the image into the photo box
  const scale = Math.max(photoW / iw, photoH / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(PAD, PAD, photoW, photoH);
  ctx.clip();
  ctx.drawImage(image, PAD + (photoW - dw) / 2, PAD + (photoH - dh) / 2, dw, dh);
  ctx.restore();

  const top = PAD + photoH;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = t.warning; // the past
  ctx.font = '300 76px system-ui, sans-serif';
  ctx.fillText(String(photo.year), PAD, top + 76);
  ctx.fillStyle = t.textPrimary;
  ctx.font = '500 30px system-ui, sans-serif';
  ctx.fillText(ellipsize(ctx, photo.title, photoW - 230), PAD + 200, top + 62);
  ctx.font = '26px system-ui, sans-serif';
  ctx.fillStyle = t.textSecondary;
  const credit = `Photo: ${photo.creator} · ${photo.license} · Wikimedia Commons`;
  wrapLines(ctx, credit, photoW, 2).forEach((l, i) => ctx.fillText(l, PAD, top + 118 + i * 34));
  return canvas;
}

async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`image ${res.status}`);
  return createImageBitmap(await res.blob());
}

/** Fades frames in and out by opacity only, then frees faded-out frames. No per-frame allocation. */
export class ArchiveFadeSystem extends createSystem({}) {
  private head = new Vector3();

  update(delta: number): void {
    readHead(this.world, this.head);
    const step = delta / LAYOUT.fadeSeconds;
    for (let i = live.length - 1; i >= 0; i--) {
      const f = live[i];
      // Every frame always faces the viewer (the photo turns, not the user), staying upright.
      f.rig.root.lookAt(this.head.x, f.rig.root.position.y, this.head.z);
      const m = f.material;
      if (m.opacity < f.target) m.opacity = Math.min(f.target, m.opacity + step);
      else if (m.opacity > f.target) m.opacity = Math.max(f.target, m.opacity - step);
      if (f.target === 0 && m.opacity === 0) disposeFrame(f);
    }
  }
}

function disposeFrame(f: Frame): void {
  const i = live.indexOf(f);
  if (i >= 0) live.splice(i, 1);
  f.texture.dispose();
  f.entity.dispose(); // also frees geometry and material; never destroy()
  f.rig.dispose();
}

/**
 * Redraw a frame's card in the current theme. The photo itself is copied out of the frame's
 * own canvas first (the decoded bitmap was closed long ago), so nothing is fetched again.
 */
function repaintFrame(f: Frame): void {
  const { w, h } = photoBox(f.canvas.width - PAD * 2, f.canvas.height - PAD - CAPTION_H);
  const copy = document.createElement('canvas');
  copy.width = w;
  copy.height = h;
  copy.getContext('2d')?.drawImage(f.canvas, PAD, PAD, w, h, 0, 0, w, h);
  drawFrame(f.photo, copy, w, h, f.canvas);
  f.texture.needsUpdate = true;
}

/** Repaint every live frame when the theme changes. Returns the unsubscribe function. */
export function followTheme(): () => void {
  return onThemeChange(() => {
    for (const f of live) repaintFrame(f);
  });
}

/** Forget where the user dragged the frames (the world origin moved with an XR session). */
export function forgetFramePlacements(): void {
  placements.deletePrefix(ARCHIVE_ID_PREFIX);
}

export function liveFrameCount(): number {
  return live.length;
}

/** Frame placement angles (degrees from straight ahead) for `n` frames. */
export function arcAngles(n: number): number[] {
  return Array.from({ length: n }, (_v, i) => (i - (n - 1) / 2) * LAYOUT.spacingDeg);
}

export function createFrameRenderer(world: World): PhotoRenderer {
  let epoch = 0;
  const forward = new Vector3();
  const head = new Vector3();

  const clearNow = (): void => {
    for (const f of [...live]) disposeFrame(f);
  };

  return {
    async show(photos) {
      const mine = ++epoch;
      clearNow();
      const loaded = await Promise.all(
        photos.map(async (photo) => {
          try {
            return { photo, bitmap: await loadBitmap(photo.imageUrl) };
          } catch (err) {
            console.warn('[archive] image failed', photo.pageUrl, err);
            return null;
          }
        }),
      );
      const ok = loaded.filter((x): x is { photo: ArchivePhoto; bitmap: ImageBitmap } => x !== null);
      if (mine !== epoch) {
        ok.forEach((x) => x.bitmap.close());
        return [];
      }
      // Place around where the viewer is looking now. The camera itself is never touched.
      world.camera.getWorldPosition(head);
      world.camera.getWorldDirection(forward);
      const yaw = Math.atan2(forward.x, -forward.z);
      const angles = arcAngles(ok.length);
      ok.forEach(({ photo, bitmap }, i) => {
        const canvas = drawFrame(photo, bitmap, bitmap.width, bitmap.height);
        bitmap.close();
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        const material = new MeshBasicMaterial({ map: texture, transparent: true, opacity: 0, toneMapped: false });
        const mesh = new Mesh(new PlaneGeometry(1, 1), material);
        mesh.scale.set(LAYOUT.frameWidthM, (LAYOUT.frameWidthM * canvas.height) / canvas.width, 1);
        // The frame is grabbed by its own body (no grip bar) and remembers where it was left:
        // the same slot in the arc opens there again for the rest of the session.
        const rig = new DragRig(world, { id: `${ARCHIVE_ID_PREFIX}${i}`, grip: false });
        const left = placements.get(rig.id);
        if (left) {
          rig.root.position.set(left.x, left.y, left.z);
          rig.root.lookAt(head);
        } else {
          const a = yaw + (angles[i] * Math.PI) / 180;
          const lift = ok.length % 2 === 1 && angles[i] === 0 ? LAYOUT.centreLiftM : 0;
          rig.root.position.set(
            head.x + Math.sin(a) * LAYOUT.distanceM,
            head.y + lift,
            head.z - Math.cos(a) * LAYOUT.distanceM,
          );
          // Face the viewer (the photo turns, not the user), staying upright.
          rig.root.lookAt(head.x, rig.root.position.y, head.z);
        }
        const entity = world.createTransformEntity(mesh, { parent: rig.entity, persistent: true });
        entity.addComponent(ArchivePhotoTag, { slot: photo.pageUrl, value: photo.year });
        entity.addComponent(RayInteractable);
        entity.addComponent(HoverFx, { slot: 'default' });
        rig.arm(); // now that the photo mesh is under the rig
        live.push({ entity, rig, photo, canvas, mesh, material, texture, target: 1 });
      });
      return ok.map((x) => x.photo);
    },
    hide() {
      epoch++;
      for (const f of live) f.target = 0;
    },
  };
}
