/**
 * Phase 0 spikes. Dev only, gated by `?spike=<name>` in the URL. Results are read from
 * `window.__spike` through the emulator tools and recorded in `docs/spikes.md`.
 * Orchestrator-owned; delete once nothing needs re-running.
 */
import { CanvasTexture, DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, SRGBColorSpace } from '@iwsdk/core';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { config } from '../config.js';
import type { Pano, TrackContext } from '../contracts.js';
import { FIXTURE_PANOS } from '../mocks/mock-source.js';

type SpikeResult = Record<string, unknown>;
const out: SpikeResult = {};
(window as unknown as { __spike: SpikeResult }).__spike = out;

const TOKEN = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;

async function textureSpike({ services }: TrackContext): Promise<void> {
  const url = new URL('https://graph.mapillary.com/images');
  url.search = new URLSearchParams({
    access_token: TOKEN ?? '',
    lat: '40.758',
    lng: '-73.9855',
    radius: '50',
    limit: '100',
    fields:
      'id,captured_at,is_pano,computed_compass_angle,compass_angle,computed_geometry,sequence,thumb_original_url,thumb_2048_url,width,height,creator',
  }).toString();
  const t0 = performance.now();
  const meta = await (await fetch(url)).json();
  out.searchMs = Math.round(performance.now() - t0);
  const panos = (meta.data as Array<Record<string, any>>).filter((x) => x.is_pano);
  out.panoCount = panos.length;
  const pick = panos.sort((a, b) => b.captured_at - a.captured_at)[0];
  out.pickedYear = new Date(pick.captured_at).getUTCFullYear();
  out.pickedSize = `${pick.width}x${pick.height}`;

  const t1 = performance.now();
  const resp = await fetch(pick.thumb_original_url); // CORS-mode fetch: fails if no ACAO header
  const blob = await resp.blob();
  out.fetchOk = resp.ok;
  out.blobBytes = blob.size;
  out.fetchMs = Math.round(performance.now() - t1);

  const t2 = performance.now();
  const cap = config.texture.currentMaxWidthDesktop;
  const bmp = await createImageBitmap(blob, {
    resizeWidth: Math.min(cap, pick.width),
    resizeQuality: 'high',
  });
  out.bitmap = `${bmp.width}x${bmp.height}`;
  out.decodeMs = Math.round(performance.now() - t2);
  out.maxTextureSize = (document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext).getParameter(
    0x0d33,
  );
  bmp.close();

  const pano: Pano = {
    id: pick.id,
    lat: pick.computed_geometry.coordinates[1],
    lng: pick.computed_geometry.coordinates[0],
    capturedAt: pick.captured_at,
    heading: pick.computed_compass_angle ?? pick.compass_angle ?? 0,
    imageUrl: URL.createObjectURL(blob),
    width: pick.width,
    height: pick.height,
    creator: pick.creator.username,
    sequenceId: pick.sequence,
  };
  await services.stage.show(pano);
  services.stage.setVisible(true);
  out.shownAsTexture = services.stage.textureCount();
  out.done = true;
}

async function maplibreSpike({ world }: TrackContext): Promise<void> {
  const size = config.map.canvasPx;
  const holder = document.createElement('div');
  holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${size}px;height:${size}px;overflow:hidden;pointer-events:none`;
  document.body.appendChild(holder);
  // MapLibre sizes its canvas from container.clientWidth/Height. Layout is unreliable in the
  // managed browser's app tab (window reports 0x0), so pin the size instead of measuring.
  Object.defineProperty(holder, 'clientWidth', { get: () => size });
  Object.defineProperty(holder, 'clientHeight', { get: () => size });
  const map = new maplibregl.Map({
    container: holder,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [-73.9855, 40.758],
    zoom: config.map.defaultZoom,
    interactive: false,
    pixelRatio: 1,
    canvasContextAttributes: { preserveDrawingBuffer: true },
    attributionControl: false,
  });
  map.on('error', (e) => (out.mapError = String(e.error?.message ?? e)));
  map.on('load', () => {
    out.loadEvent = true;
    map.addSource('mly', {
      type: 'vector',
      tiles: [`https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=${TOKEN}`],
      minzoom: 6,
      maxzoom: 14,
    });
    map.addLayer({
      id: 'mly-seq',
      type: 'line',
      source: 'mly',
      'source-layer': 'sequence',
      filter: ['==', ['get', 'is_pano'], true],
      paint: { 'line-color': '#05cb63', 'line-width': 4 },
    });
  });

  const canvas = map.getCanvas();
  out.canvas = `${canvas.width}x${canvas.height}`;
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  const plane = new Mesh(
    new PlaneGeometry(config.map.tableSizeM, config.map.tableSizeM),
    new MeshBasicMaterial({ map: tex, side: DoubleSide }),
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.set(0, config.map.tableHeightM, -0.8);
  world.createTransformEntity(plane, { persistent: true });

  let redraws = 0;
  let xrFrames = 0;
  let rafFrames = 0;
  const probe = document.createElement('canvas');
  probe.width = probe.height = 32;
  const pctx = probe.getContext('2d', { willReadFrequently: true })!;
  const distinctColours = (): number => {
    pctx.drawImage(canvas, 0, 0, 32, 32);
    const d = pctx.getImageData(0, 0, 32, 32).data;
    const seen = new Set<number>();
    for (let i = 0; i < d.length; i += 4) seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    return seen.size;
  };
  const redraw = () => {
    map.redraw(); // synchronous render; does not need window.requestAnimationFrame
    tex.needsUpdate = true;
    redraws++;
  };
  const rafCounter = () => {
    rafFrames++;
    requestAnimationFrame(rafCounter);
  };
  requestAnimationFrame(rafCounter);
  // Drive it ourselves: XR frames inside a session, a timer outside one.
  world.onXRFrame(() => {
    xrFrames++;
    if (xrFrames % 6 === 0) redraw();
  });
  setInterval(() => {
    if (!world.session) redraw();
  }, 150);
  setInterval(() => {
    out.tick = {
      redraws,
      xrFrames,
      rafFrames,
      inXR: !!world.session,
      loaded: map.loaded(),
      styleLoaded: map.isStyleLoaded(),
      distinctColours: distinctColours(),
      centre: map.getCenter().toArray(),
      win: `${innerWidth}x${innerHeight}`,
      page: location.hash || 'app',
      err: out.mapError ?? null,
    };
    console.log('SPIKE maplibre-tick ' + JSON.stringify(out.tick));
  }, 3000);
  Object.assign(out, {
    pan: (dx: number, dy: number) => map.panBy([dx, dy], { animate: false }),
  });
  (window as unknown as { __pan: (dx: number, dy: number) => void }).__pan = (dx, dy) => {
    map.panBy([dx, dy], { animate: false });
  };
  out.done = true;
}

async function arSpike(ctx: TrackContext): Promise<void> {
  const pano = FIXTURE_PANOS[1];
  await ctx.services.stage.show(pano);
  ctx.services.stage.setVisible(true);
  out.done = true;
}

export function runSpike(name: string, ctx: TrackContext): void {
  const run = { texture: textureSpike, maplibre: maplibreSpike, ar: arSpike }[name];
  if (!run) return;
  const report = () => console.log('SPIKE ' + name + ' ' + JSON.stringify(out));
  run(ctx)
    .catch((err) => {
      out.error = String(err?.stack ?? err);
    })
    .finally(report);
  (window as unknown as { __report: () => void }).__report = report;
}
