/**
 * The tabletop map: MapLibre (OpenFreeMap "liberty" style + Mapillary panorama coverage) drawn
 * into an offscreen canvas, shown as a CanvasTexture on a plane at table height.
 *
 * Input goes through IWSDK's pointer events (RayInteractable), which cover the desktop mouse,
 * controller rays (trigger) and hand rays (pinch) with the same code:
 *  - one pointer pressed and moved: pan; pressed and released in place: pick a street.
 *  - two pointers pressed (two hands or two controllers): spread to zoom.
 *  - mouse wheel: zoom; right controller thumbstick up/down: zoom.
 */
import {
  BoxGeometry,
  CanvasTexture,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  RayInteractable,
  SRGBColorSpace,
  Vector3,
} from '@iwsdk/core';
import type { Entity, World } from '@iwsdk/core';
import maplibregl from 'maplibre-gl';
import type { GeoJSONSource, LayerSpecification, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { config } from '../config.js';
import type { CuratedSpot, EventBus, LatLng, MapTable, SpotInfo } from '../contracts.js';
import { MapTableTag } from '../track-components.js';
import {
  clampZoom,
  isTap,
  latLngToPixel,
  MAX_ZOOM,
  MIN_ZOOM,
  nearestOnPolylines,
  pinchZoom,
  planeLocalToPixel,
  type MapView,
  type Pixel,
  wheelZoom,
  zoomAround,
  panByPixels,
} from './geo.js';
import { RedrawScheduler } from './redraw.js';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
export const MAPILLARY_TILES = 'https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}';
export const MAP_CREDIT = '© OpenStreetMap contributors  ·  OpenFreeMap  ·  Coverage © Mapillary';
const COVERAGE_LAYER = 'mly-pano-sequences';
/** How far from a coverage line a tap still snaps to it, canvas pixels (about 2 cm on the table). */
const SNAP_PX = 48;
/** Distance of the table centre in front of the standing player, metres (north is -Z). */
const TABLE_Z = -0.62;

export interface TableStats {
  styleLoaded: boolean;
  tilesLoaded: boolean;
  redraws: number;
  uploads: number;
  inXR: boolean;
  view: MapView;
  canvas: string;
  error: string | null;
}

interface SpotsData {
  type: 'FeatureCollection';
  features: Array<{
    type: 'Feature';
    properties: { name: string };
    geometry: { type: 'Point'; coordinates: number[] };
  }>;
}

interface ActivePointer {
  x: number;
  y: number;
  travel: number;
  t0: number;
}

export class TableMap implements MapTable {
  readonly root = new Group();
  readonly view: MapView;
  private readonly size = config.map.tableSizeM;
  private readonly px = config.map.canvasPx;
  private readonly holder: HTMLDivElement;
  private map: maplibregl.Map | null = null;
  private texture: CanvasTexture | null = null;
  private readonly mapMaterial = new MeshBasicMaterial({ color: 0x2a2f36, toneMapped: false });
  private readonly mapMesh: Mesh;
  private readonly entities: Entity[] = [];
  private readonly scheduler = new RedrawScheduler();
  private readonly offs: Array<() => void> = [];
  private readonly pointers = new Map<number, ActivePointer>();
  private gesture = { active: false, startZoom: 0, startDist: 0, midX: 0, midY: 0 };
  private multiTouched = false;
  private selfRendered = false;
  private inRedraw = false;
  private uploads = 0;
  private error: string | null = null;
  private visible = true;
  private disposed = false;
  private readonly tmpLocal = new Vector3();
  private readonly tmpPixel: Pixel = { x: 0, y: 0 };
  /** Dev diagnostics hook. */
  onLog: ((msg: string, data?: unknown) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly bus: EventBus,
    start: LatLng,
    private readonly token: string | undefined,
  ) {
    this.view = { lat: start.lat, lng: start.lng, zoom: config.map.defaultZoom };

    // Offscreen holder. MapLibre sizes its canvas from clientWidth/Height, which are unreliable
    // in hidden or immersive pages (the spike saw 0 x 0), so pin them.
    const holder = document.createElement('div');
    holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${this.px}px;height:${this.px}px;overflow:hidden;pointer-events:none;visibility:hidden`;
    holder.setAttribute('aria-hidden', 'true');
    Object.defineProperty(holder, 'clientWidth', { get: () => this.px });
    Object.defineProperty(holder, 'clientHeight', { get: () => this.px });
    document.body.appendChild(holder);
    this.holder = holder;

    this.root.name = 'MapTable';
    this.root.position.set(0, config.map.tableHeightM, TABLE_Z);

    const slab = new Mesh(
      new BoxGeometry(this.size + 0.06, 0.04, this.size + 0.14),
      new MeshBasicMaterial({ color: 0x1b1f24 }),
    );
    slab.position.y = -0.0205;
    this.root.add(slab);

    this.mapMesh = new Mesh(new PlaneGeometry(this.size, this.size), this.mapMaterial);
    this.mapMesh.name = 'MapTableSurface';
    this.mapMesh.rotation.x = -Math.PI / 2;
    this.mapMesh.position.y = 0.001;
    this.mapMesh.onBeforeRender = () => this.tick();

    this.root.add(this.textStrip(MAP_CREDIT, this.size / 2 + 0.035, 'rgba(255,255,255,0.78)', 26));
    this.root.add(
      this.textStrip('Drag to pan  ·  two hands to zoom  ·  tap a green street', -(this.size / 2 + 0.035), '#9fe8bd', 28),
    );

    const rootEntity = world.createTransformEntity(this.root, { persistent: true });
    rootEntity.addComponent(MapTableTag, { slot: 'table' });
    const surface = world.createTransformEntity(this.mapMesh, { parent: rootEntity, persistent: true });
    surface.addComponent(MapTableTag, { slot: 'surface' });
    surface.addComponent(RayInteractable);
    this.entities.push(surface, rootEntity);

    this.bindPointers();
    this.bindThumbstick();
    void this.createMap();
  }

  // --- MapTable ------------------------------------------------------------------------------

  show(): void {
    this.visible = true;
    this.root.visible = true;
    this.scheduler.markDirty();
  }

  hide(): void {
    this.visible = false;
    this.root.visible = false;
    this.pointers.clear();
    this.gesture.active = false;
  }

  flyTo(lat: number, lng: number, zoom?: number): void {
    // A jump, not an animation: animating would fetch tiles for every intermediate view.
    this.view.lat = lat;
    this.view.lng = lng;
    if (zoom !== undefined) this.view.zoom = clampZoom(zoom);
    this.applyView();
  }

  // --- curated spots and pick marker -----------------------------------------------------------

  setSpots(spots: CuratedSpot[]): void {
    const src = this.map?.getSource('tm-spots') as GeoJSONSource | undefined;
    const data = {
      type: 'FeatureCollection' as const,
      features: spots.map((s) => ({
        type: 'Feature' as const,
        properties: { name: s.name },
        geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
      })),
    };
    this.pendingSpots = data;
    src?.setData(data);
    this.scheduler.markDirty();
  }
  private pendingSpots: SpotsData = { type: 'FeatureCollection', features: [] };

  private markPick(lat: number, lng: number): void {
    const src = this.map?.getSource('tm-pick') as GeoJSONSource | undefined;
    src?.setData({ type: 'Point', coordinates: [lng, lat] });
    this.scheduler.markDirty();
  }

  stats(): TableStats {
    const m = this.map;
    return {
      styleLoaded: !!m?.isStyleLoaded(),
      tilesLoaded: !!m?.loaded(),
      redraws: this.scheduler.count,
      uploads: this.uploads,
      inXR: !!this.world.session,
      view: { ...this.view },
      canvas: m ? `${m.getCanvas().width}x${m.getCanvas().height}` : 'none',
      error: this.error,
    };
  }

  /** Small fingerprint of what the map canvas shows (dev evidence that a pan changed it). */
  fingerprint(): string {
    const m = this.map;
    if (!m) return 'none';
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return 'no2d';
    g.drawImage(m.getCanvas(), 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data;
    let h = 2166136261;
    const colours = new Set<number>();
    for (let i = 0; i < d.length; i += 4) {
      const rgb = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
      colours.add(rgb);
      h = Math.imul(h ^ rgb, 16777619);
    }
    return `${(h >>> 0).toString(16)}/${colours.size}colours`;
  }

  /** Pick at a canvas pixel, exactly as a tap does. Exposed for the dev driver. */
  pickAtPixel(px: number, py: number): SpotInfo | null {
    const m = this.map;
    if (!m) return null;
    let x = px;
    let y = py;
    if (m.getLayer(COVERAGE_LAYER)) {
      const feats = m.queryRenderedFeatures(
        [
          [px - SNAP_PX, py - SNAP_PX],
          [px + SNAP_PX, py + SNAP_PX],
        ],
        { layers: [COVERAGE_LAYER] },
      );
      const lines: Pixel[][] = [];
      for (const f of feats) {
        const g = f.geometry;
        const parts: number[][][] =
          g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
        for (const part of parts) {
          lines.push(part.map((c) => latLngToPixel(this.view, c[1], c[0], this.px)));
        }
      }
      const snap = nearestOnPolylines(px, py, lines, SNAP_PX);
      if (!snap) {
        this.log('pick-miss', { px, py, features: feats.length });
        this.bus.emit('error', {
          source: 'map',
          message: 'No 360° imagery there. Tap a green street.',
          recoverable: true,
        });
        return null;
      }
      x = snap.x;
      y = snap.y;
    }
    const ll = m.unproject([x, y]);
    const spot: SpotInfo = { lat: ll.lat, lng: ll.lng };
    this.markPick(spot.lat, spot.lng);
    this.log('pick', { px, py, snappedPx: [Math.round(x), Math.round(y)], spot });
    this.bus.emit('spot:selected', spot);
    return spot;
  }

  /** Pan by canvas pixels, as a drag does. Exposed for the dev driver. */
  panPixels(dx: number, dy: number): void {
    panByPixels(this.view, dx, dy);
    this.applyView();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.offs.forEach((off) => off());
    this.offs.length = 0;
    this.mapMesh.onBeforeRender = () => {};
    this.map?.remove();
    this.map = null;
    this.texture?.dispose();
    this.holder.remove();
    for (const e of this.entities) e.dispose();
    this.entities.length = 0;
  }

  // --- MapLibre ----------------------------------------------------------------------------------

  private async createMap(): Promise<void> {
    let style: StyleSpecification;
    try {
      const resp = await fetch(STYLE_URL);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      style = (await resp.json()) as StyleSpecification;
    } catch (err) {
      this.fail(`Map style could not load (${String(err)}).`);
      return;
    }
    if (this.disposed) return;
    this.addOverlays(style);

    const map = new maplibregl.Map({
      container: this.holder,
      style,
      center: [this.view.lng, this.view.lat],
      zoom: this.view.zoom,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      interactive: false,
      trackResize: false,
      renderWorldCopies: false,
      fadeDuration: 0,
      pixelRatio: 1,
      attributionControl: false,
      canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
    });
    this.map = map;
    map.on('error', (e) => {
      const msg = String(e.error?.message ?? e);
      // Missing POI sprite icons in the OpenFreeMap style are harmless (see docs/spikes.md).
      if (/could not be loaded/i.test(msg)) return;
      this.error = msg;
      this.log('map-error', msg);
    });
    map.on('styleimagemissing', () => {});
    map.on('data', () => this.scheduler.markDirty());
    map.on('render', () => {
      if (!this.inRedraw) this.selfRendered = true;
    });
    map.once('load', () => this.log('map-load', this.stats()));

    const tex = new CanvasTexture(map.getCanvas());
    tex.colorSpace = SRGBColorSpace;
    tex.minFilter = LinearMipmapLinearFilter;
    tex.magFilter = LinearFilter;
    tex.anisotropy = 4;
    this.texture = tex;
    this.mapMaterial.map = tex;
    this.mapMaterial.color.set(0xffffff);
    this.mapMaterial.needsUpdate = true;
    this.scheduler.markDirty();
    this.log('map-created', { canvas: `${map.getCanvas().width}x${map.getCanvas().height}` });
  }

  /** Put the coverage layer below the first label layer, and add spot and pick markers. */
  private addOverlays(style: StyleSpecification): void {
    style.sources = { ...style.sources };
    const layers: LayerSpecification[] = [...style.layers];
    const firstSymbol = layers.findIndex((l) => l.type === 'symbol');
    const insertAt = firstSymbol < 0 ? layers.length : firstSymbol;
    if (this.token) {
      style.sources.mapillary = {
        type: 'vector',
        tiles: [`${MAPILLARY_TILES}?access_token=${this.token}`],
        minzoom: 6,
        maxzoom: 14,
        attribution: '© Mapillary',
      };
      layers.splice(insertAt, 0, {
        id: COVERAGE_LAYER,
        type: 'line',
        source: 'mapillary',
        'source-layer': 'sequence',
        filter: ['==', ['get', 'is_pano'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#05cb63',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2.5, 15, 5, 18, 9],
        },
      });
    } else {
      this.fail('No Mapillary token, so the map cannot show where street imagery exists.');
    }
    style.sources['tm-spots'] = { type: 'geojson', data: this.pendingSpots };
    style.sources['tm-pick'] = { type: 'geojson', data: { type: 'FeatureCollection', features: [] } };
    layers.push(
      {
        id: 'tm-spots',
        type: 'circle',
        source: 'tm-spots',
        paint: {
          'circle-radius': 14,
          'circle-color': '#ffb020',
          'circle-stroke-color': '#1b1f24',
          'circle-stroke-width': 4,
        },
      },
      {
        id: 'tm-spots-label',
        type: 'symbol',
        source: 'tm-spots',
        layout: {
          'text-field': ['get', 'name'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 30,
          'text-offset': [0, 1.2],
          'text-anchor': 'top',
        },
        paint: { 'text-color': '#1b1f24', 'text-halo-color': '#ffffff', 'text-halo-width': 3 },
      },
      {
        id: 'tm-pick',
        type: 'circle',
        source: 'tm-pick',
        paint: {
          'circle-radius': 18,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#ff3d7f',
          'circle-stroke-width': 6,
        },
      },
    );
    style.layers = layers;
  }

  private applyView(): void {
    this.map?.jumpTo({ center: [this.view.lng, this.view.lat], zoom: this.view.zoom });
    this.scheduler.markDirty();
  }

  /**
   * Runs from the surface mesh's onBeforeRender, so it is driven by the IWSDK render loop both
   * in and out of an immersive session (the page's requestAnimationFrame may stop in XR) and
   * only while the table is visible. No allocation.
   */
  private tick(): void {
    const m = this.map;
    const tex = this.texture;
    if (!m || !tex || !this.visible) return;
    this.scheduler.setPending(!m.loaded());
    if (this.scheduler.due(performance.now())) {
      this.inRedraw = true;
      try {
        m.redraw();
      } finally {
        this.inRedraw = false;
      }
      this.selfRendered = false;
      tex.needsUpdate = true;
      this.uploads++;
    } else if (this.selfRendered) {
      // MapLibre drew itself (its own animation frame, outside XR): upload that frame.
      this.selfRendered = false;
      tex.needsUpdate = true;
      this.uploads++;
    }
  }

  private fail(message: string): void {
    this.error = message;
    this.log('error', message);
    this.bus.emit('error', { source: 'map', message, recoverable: true });
  }

  private log(msg: string, data?: unknown): void {
    this.onLog?.(msg, data);
  }

  // --- input -----------------------------------------------------------------------------------

  /** World hit point to canvas pixel. Writes into tmpPixel. */
  private hitToPixel(point: Vector3): Pixel {
    const local = this.mapMesh.worldToLocal(this.tmpLocal.copy(point));
    return planeLocalToPixel(local.x, local.y, this.size, this.px, this.tmpPixel);
  }

  private bindPointers(): void {
    const mesh = this.mapMesh;

    const down = (e: { pointerId: number; point: Vector3; button?: number; pointerType?: string }): void => {
      this.log('pointerdown', { id: e.pointerId, button: e.button, type: e.pointerType });
      if (!this.visible || (e.button !== undefined && e.button !== 0)) return;
      const p = this.hitToPixel(e.point);
      this.pointers.set(e.pointerId, { x: p.x, y: p.y, travel: 0, t0: performance.now() });
      try {
        mesh.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      if (this.pointers.size === 2) this.startGesture();
      if (this.pointers.size > 1) this.multiTouched = true;
    };

    const move = (e: { pointerId: number; point: Vector3 }): void => {
      const ptr = this.pointers.get(e.pointerId);
      if (!ptr) return;
      const p = this.hitToPixel(e.point);
      const dx = p.x - ptr.x;
      const dy = p.y - ptr.y;
      if (dx === 0 && dy === 0) return;
      ptr.travel += Math.hypot(dx, dy);
      ptr.x = p.x;
      ptr.y = p.y;
      if (this.pointers.size === 1) {
        panByPixels(this.view, dx, dy);
        this.applyView();
      } else if (this.gesture.active) {
        this.updateGesture();
      }
    };

    const up = (e: { pointerId: number; point?: Vector3 }, cancelled: boolean): void => {
      const ptr = this.pointers.get(e.pointerId);
      if (!ptr) return;
      this.pointers.delete(e.pointerId);
      try {
        mesh.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const single = !this.multiTouched;
      if (this.pointers.size < 2) this.gesture.active = false;
      if (this.pointers.size === 0) this.multiTouched = false;
      if (!cancelled && single && isTap(ptr.travel, performance.now() - ptr.t0, this.px)) {
        this.pickAtPixel(ptr.x, ptr.y);
      } else {
        this.log('drag-end', { travelPx: Math.round(ptr.travel), view: this.view });
      }
    };

    const onDown = (e: Parameters<typeof down>[0]) => down(e);
    const onMove = (e: Parameters<typeof move>[0]) => move(e);
    const onUp = (e: Parameters<typeof up>[0]) => up(e, false);
    const onCancel = (e: Parameters<typeof up>[0]) => up(e, true);
    const onWheel = (e: { point: Vector3; deltaY: number }) => {
      if (!this.visible) return;
      const p = this.hitToPixel(e.point);
      zoomAround(this.view, p.x, p.y, wheelZoom(this.view.zoom, e.deltaY), this.px);
      this.applyView();
    };
    mesh.addEventListener('pointerdown', onDown);
    mesh.addEventListener('pointermove', onMove);
    mesh.addEventListener('pointerup', onUp);
    mesh.addEventListener('pointercancel', onCancel);
    mesh.addEventListener('wheel', onWheel);
    this.offs.push(() => {
      mesh.removeEventListener('pointerdown', onDown);
      mesh.removeEventListener('pointermove', onMove);
      mesh.removeEventListener('pointerup', onUp);
      mesh.removeEventListener('pointercancel', onCancel);
      mesh.removeEventListener('wheel', onWheel);
    });
  }

  private pointerPair(): [ActivePointer, ActivePointer] | null {
    let a: ActivePointer | null = null;
    let b: ActivePointer | null = null;
    for (const p of this.pointers.values()) {
      if (!a) a = p;
      else if (!b) b = p;
    }
    return a && b ? [a, b] : null;
  }

  private startGesture(): void {
    const pair = this.pointerPair();
    if (!pair) return;
    const [a, b] = pair;
    const g = this.gesture;
    g.active = true;
    g.startZoom = this.view.zoom;
    g.startDist = Math.hypot(a.x - b.x, a.y - b.y);
    g.midX = (a.x + b.x) / 2;
    g.midY = (a.y + b.y) / 2;
  }

  private updateGesture(): void {
    const pair = this.pointerPair();
    if (!pair) return;
    const [a, b] = pair;
    const g = this.gesture;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const z = pinchZoom(g.startZoom, g.startDist, Math.hypot(a.x - b.x, a.y - b.y));
    zoomAround(this.view, midX, midY, z, this.px);
    panByPixels(this.view, midX - g.midX, midY - g.midY);
    g.midX = midX;
    g.midY = midY;
    this.applyView();
  }

  /** Controller fallback: right thumbstick up zooms in, down zooms out. */
  private bindThumbstick(): void {
    const off = this.world.onXRFrame((_frame, delta) => {
      if (!this.visible || !this.map) return;
      const pad = this.world.input.xr.gamepads.right;
      const axes = pad?.getAxesValues('xr-standard-thumbstick');
      const y = axes?.y ?? 0;
      if (Math.abs(y) < 0.25) return;
      const z = clampZoom(this.view.zoom - y * delta * 1.5);
      if (z === this.view.zoom) return;
      zoomAround(this.view, this.px / 2, this.px / 2, z, this.px);
      this.applyView();
    });
    this.offs.push(off);
  }

  // --- static labels ---------------------------------------------------------------------------

  /** A strip of text lying on the table rim, readable from the near side. */
  private textStrip(text: string, z: number, colour: string, fontPx: number): Mesh {
    const w = 1024;
    const h = 64;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d');
    if (g) {
      g.clearRect(0, 0, w, h);
      g.fillStyle = colour;
      g.font = `600 ${fontPx}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, w / 2, h / 2, w - 24);
    }
    const tex = new CanvasTexture(canvas);
    tex.colorSpace = SRGBColorSpace;
    const mesh = new Mesh(
      new PlaneGeometry(this.size, (this.size * h) / w),
      new MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(0, 0.0015, z);
    return mesh;
  }
}
