/**
 * DEV-ONLY keyboard harness for the pano stage. Loaded only when `PANO_DEV_HARNESS` is true
 * and Vite runs in dev. Every result is logged as a line starting with `PANO `.
 *
 *  1 / 2  show the 2023 / 2025 fixture (with a distinct preview URL, so the preview→full
 *         swap runs)              h  20 alternating hops, texture counts before/after
 *  b      one hop that holds black for 4 s (to capture the black frame)
 *  l      toggle the lens with the other year, centred where the camera looks
 *  c      commitPast              t / s  request table / street mode
 *  p      toggle stencilRef (portal stencil test)     r  report
 */
import { Vector3 } from '@iwsdk/core';
import type { World } from '@iwsdk/core';
import { config } from '../config.js';
import type { EventBus, Pano } from '../contracts.js';
import { FIXTURE_PANOS, FIXTURE_SPOT } from '../mocks/mock-source.js';
import { sleep } from './lifecycle.js';
import type { ProductionPanoStage } from './stage.js';

const withPreview = (p: Pano): Pano => ({ ...p, previewUrl: `${p.imageUrl}?preview` });

/** Fixture neighbours: the other year plus a fake pano 25 m east (re-using the 2023 image). */
export function devNeighbours(pano: Pano): Pano[] {
  const east: Pano = {
    ...FIXTURE_PANOS[0],
    id: 'dev-east',
    lng: pano.lng + 0.0003,
    lat: pano.lat,
  };
  return [...FIXTURE_PANOS.filter((p) => p.id !== pano.id), east].filter((p) => p.id !== pano.id);
}

export function installPanoHarness(world: World, bus: EventBus, stage: ProductionPanoStage): void {
  const log = (tag: string, extra: Record<string, unknown> = {}) =>
    console.log(`PANO ${tag} ${JSON.stringify({ ...stage.describe(), ...extra, session: !!world.session })}`);
  const other = (): Pano => {
    const curId = stage.currentPano?.id;
    return withPreview(FIXTURE_PANOS.find((p) => p.id !== curId) ?? FIXTURE_PANOS[0]);
  };
  let busy = false;
  const run = (name: string, job: () => Promise<void>) => {
    if (busy) return log('busy');
    busy = true;
    job()
      .then(() => log(`${name}:done`))
      .catch((err) => log(`${name}:error`, { error: String(err) }))
      .finally(() => (busy = false));
  };

  bus.on('pano:shown', ({ pano }) => log('shown', { shown: pano.id, year: new Date(pano.capturedAt).getUTCFullYear() }));
  bus.on('error', (e) => log('error-event', { e }));

  window.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case '1':
      case '2':
        return run(`show${ev.key}`, async () => {
          stage.setVisible(true);
          await stage.show(withPreview(FIXTURE_PANOS[Number(ev.key) - 1]));
          await sleep(600);
        });
      case 'h':
        return run('hops', async () => {
          await sleep(500);
          const before = stage.describe();
          const counts: number[] = [];
          const gpu: number[] = [];
          for (let i = 0; i < 20; i++) {
            await stage.show(other());
            await sleep(450);
            counts.push(stage.textureCount());
            gpu.push(world.renderer.info.memory.textures);
          }
          const after = stage.describe();
          log('hops-result', {
            beforeTextureCount: before.textureCount,
            beforeRendererTextures: before.rendererTextures,
            afterTextureCount: after.textureCount,
            afterRendererTextures: after.rendererTextures,
            perHopTextureCount: counts,
            perHopRendererTextures: gpu,
          });
        });
      case 'b':
        return run('black', async () => {
          stage.debugHoldBlackMs = 4000;
          try {
            await stage.show(other());
          } finally {
            stage.debugHoldBlackMs = 0;
          }
        });
      case 'l':
        return run('lens', async () => {
          if (stage.lens.enabled) {
            stage.clearPast();
            return;
          }
          await stage.loadPast(other());
          world.camera.getWorldDirection(stage.lens.direction as Vector3);
          stage.lens.radius = 0.45;
          stage.lens.enabled = true;
        });
      case 'c':
        return run('commit', async () => stage.commitPast());
      case 't':
        bus.emit('mode:requested', { mode: 'table' });
        return log('table');
      case 's':
        bus.emit('mode:requested', { mode: 'street' });
        return log('street');
      case 'p':
        // No portal mask here, so the stencil buffer is all 0: with the test on, the sphere vanishes.
        stage.stencilRef = stage.stencilRef === null ? config.portal.stencilRef : null;
        return log('stencil');
      case 'r':
        return log('report');
    }
  });

  // Enter the street once the flow is wired: exactly what a map pick does.
  setTimeout(() => bus.emit('spot:selected', { lat: FIXTURE_SPOT.lat, lng: FIXTURE_SPOT.lng }), 1500);
  log('harness-installed');
}
