import {
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Vector3,
  createSystem,
} from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import type { ArchivePhoto } from '../contracts.js';
import { ArchivePhotoTag } from '../track-components.js';
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

interface Frame {
  entity: Entity;
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

/** Draw photo + caption (year, title, credit) onto one canvas. */
export function drawFrame(photo: ArchivePhoto, image: CanvasImageSource, iw: number, ih: number): HTMLCanvasElement {
  const photoW = CANVAS_W - PAD * 2;
  const photoH = Math.round(Math.min(560, Math.max(300, (photoW * ih) / iw)));
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = PAD + photoH + CAPTION_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f4ecd8'; // warm paper mat
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1a1510';
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
  ctx.fillStyle = '#7a1f12';
  ctx.font = 'bold 76px Georgia, serif';
  ctx.fillText(String(photo.year), PAD, top + 76);
  ctx.fillStyle = '#1a1510';
  ctx.font = '30px Georgia, serif';
  ctx.fillText(ellipsize(ctx, photo.title, photoW - 230), PAD + 200, top + 62);
  ctx.font = '26px Arial, sans-serif';
  ctx.fillStyle = '#3a342b';
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
  update(delta: number): void {
    const step = delta / LAYOUT.fadeSeconds;
    for (let i = live.length - 1; i >= 0; i--) {
      const f = live[i];
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
        const a = yaw + (angles[i] * Math.PI) / 180;
        const lift = ok.length % 2 === 1 && angles[i] === 0 ? LAYOUT.centreLiftM : 0;
        mesh.position.set(
          head.x + Math.sin(a) * LAYOUT.distanceM,
          head.y + lift,
          head.z - Math.cos(a) * LAYOUT.distanceM,
        );
        mesh.lookAt(head.x, mesh.position.y, head.z); // face the viewer (the photo turns, not the user)
        const entity = world.createTransformEntity(mesh, { persistent: true });
        entity.addComponent(ArchivePhotoTag, { slot: photo.pageUrl, value: photo.year });
        live.push({ entity, mesh, material, texture, target: 1 });
      });
      return ok.map((x) => x.photo);
    },
    hide() {
      epoch++;
      for (const f of live) f.target = 0;
    },
  };
}
