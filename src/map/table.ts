/**
 * The tabletop map: MapLibre (raster base map + Mapillary panorama coverage) drawn into an
 * offscreen canvas, shown as a CanvasTexture on a plane at table height.
 *
 * Input goes through IWSDK's pointer events (RayInteractable), which cover the desktop mouse,
 * controller rays (trigger) and hand rays (pinch) with the same code:
 *  - one pointer pressed and moved: pan; pressed and released in place: pick a street.
 *  - two pointers pressed (two hands pinching, or two controllers): spread or close to zoom.
 *  - zoom rail on the right rim: press and drag along it (one hand or one controller).
 *  - either controller thumbstick up/down: zoom; mouse wheel: zoom.
 * Every zoom input sets a clamped target; the map eases to it (see `stepZoom` in `geo.ts`).
 * The whole table can be moved by the grip bar on its near edge (`DragRig`).
 */
import {
  BoxGeometry,
  CanvasTexture,
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
import type { GeoJSONSource, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { config } from '../config.js';
import type { CuratedSpot, EventBus, LatLng, MapTable, Prefs, SpotInfo, Vec3Like } from '../contracts.js';
import { DragRig, placements, stopBubbling } from '../drag.js';
import { TableGestures, tapSlopPx } from './gestures.js';
import { setHoverTint } from '../hover.js';
import { baseMapFor } from '../prefs.js';
import type { BaseMapKind } from '../prefs.js';
import { currentTokens, hexAlpha, hexNumber } from '../theme.js';
import { HoverFx, MapTableTag } from '../track-components.js';
import {
  clampZoom,
  latLngToPixel,
  MAX_ZOOM,
  MIN_ZOOM,
  nearestOnPolylines,
  planeLocalToPixel,
  railToZoom,
  stepZoom,
  stickZoomRate,
  type MapView,
  type Pixel,
  wheelZoom,
  zoomAround,
  zoomToRail,
  panByPixels,
} from './geo.js';
import { DEFAULT_TABLE_POSE, tablePoseFor } from './placement.js';
import type { TablePose } from './placement.js';
import { RedrawScheduler } from './redraw.js';
import {
  BUILDINGS_LAYER,
  buildMapStyle,
  COVERAGE_LAYER,
  mapCredit,
  PICK_SOURCE,
  SPOTS_SOURCE,
  type SpotsData,
} from './style.js';

/** Camera tilt used by the 3D buildings view, degrees. Kept under ~70 so no horizon or sky shows on the table. */
export const PITCH_3D = 55;

/** How far from a coverage line a tap still snaps to it, canvas pixels (about 2 cm on the table). */
const SNAP_PX = 48;
/** Stop pending-tile redraws when MapLibre has reported no new data for this long, ms. */
const PENDING_QUIET_MS = 3000;
/** Margin of slab around the map: the rim strips sit on it front and back, the zoom rail on the right. */
const RIM_M = 0.13;
/** Zoom rail: a strip on the right rim. Dragging toward the far end zooms in. */
const RAIL_LENGTH_M = 0.5;
const RAIL_WIDTH_M = 0.05;
const RAIL_KNOB_M = 0.035;
/** Longest gap between two easing steps, ms, so a stalled frame cannot make the zoom jump. */
const MAX_EASE_STEP_MS = 100;
/** Panel id of the table in `placements`. */
const TABLE_ID = 'map-table';

export interface TableStats {
  styleLoaded: boolean;
  tilesLoaded: boolean;
  redraws: number;
  uploads: number;
  /** Uploads of frames MapLibre drew on its own (window requestAnimationFrame). */
  selfUploads: number;
  inXR: boolean;
  view: MapView;
  canvas: string;
  error: string | null;
  /** Per-source load state, e.g. "openmaptiles:ok,mapillary:loading". */
  sources: string;
}

export class TableMap implements MapTable {
  /** The grabbable rig; its `root` is the table's root object. */
  private readonly rig: DragRig;
  readonly view: MapView;
  private readonly size = config.map.tableSizeM;
  private readonly px = config.map.canvasPx;
  private readonly holder: HTMLDivElement;
  private map: maplibregl.Map | null = null;
  private texture: CanvasTexture | null = null;
  /** Shows the `surface` token until the map canvas is ready, then white (texture only). */
  private readonly mapMaterial = new MeshBasicMaterial({ toneMapped: false });
  private readonly mapMesh: Mesh;
  private readonly slabMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false });
  private readonly railMaterial = new MeshBasicMaterial({ toneMapped: false });
  private readonly knobMaterial = new MeshBasicMaterial({ toneMapped: false });
  private readonly railMesh: Mesh;
  private readonly knobMesh: Mesh;
  private readonly surfaceEntity: Entity;
  private readonly entities: Entity[] = [];
  private baseKind: BaseMapKind;
  private themeName: Prefs['theme'];
  private buildings3d: boolean;
  private creditMesh: Mesh | null = null;
  private hintMesh: Mesh | null = null;
  /** Where the eased zoom is heading, and the canvas pixel that stays put while it gets there. */
  private zoomTarget: number;
  private zoomAnchor: Pixel = { x: 0, y: 0 };
  private lastEaseAt = 0;
  /** Canvas pixel under the last pointer that moved over the map, or null: the thumbstick's anchor. */
  private hoverPixel: Pixel | null = null;
  private readonly hoverScratch: Pixel = { x: 0, y: 0 };
  private railPointer: number | null = null;
  private lastPick: { lat: number; lng: number } | null = null;
  private readonly scheduler = new RedrawScheduler();
  private readonly offs: Array<() => void> = [];
  private readonly gestures: TableGestures;
  private selfRendered = false;
  private inRedraw = false;
  private uploads = 0;
  private lastDataAt = 0;
  private selfUploads = 0;
  private error: string | null = null;
  private visible = true;
  private disposed = false;
  private viewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly tmpLocal = new Vector3();
  private readonly tmpPixel: Pixel = { x: 0, y: 0 };
  /** Dev diagnostics hook. */
  onLog: ((msg: string, data?: unknown) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly bus: EventBus,
    start: LatLng,
    private readonly token: string | undefined,
    prefs: Readonly<Prefs>,
  ) {
    this.view = { lat: start.lat, lng: start.lng, zoom: config.map.defaultZoom };
    this.zoomTarget = this.view.zoom;
    this.gestures = new TableGestures(
      {
        pan: (end, dx, dy) => this.panBy(end, dx, dy),
        zoomTo: (z, ax, ay) => this.zoomTo(z, ax, ay),
        tap: (x, y) => this.pickAtPixel(x, y),
        dropped: (id) => {
          this.release(this.mapMesh, id);
          this.log('pointer-dropped', { id });
        },
        zoomTarget: () => this.zoomTarget,
      },
      tapSlopPx(this.px, this.size),
    );
    this.baseKind = baseMapFor(prefs);
    this.themeName = prefs.theme;
    this.buildings3d = prefs.buildings3d;

    // Offscreen holder. MapLibre sizes its canvas from clientWidth/Height, which are unreliable
    // in hidden or immersive pages (the spike saw 0 x 0), so pin them.
    const holder = document.createElement('div');
    holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${this.px}px;height:${this.px}px;overflow:hidden;pointer-events:none;visibility:hidden`;
    holder.setAttribute('aria-hidden', 'true');
    Object.defineProperty(holder, 'clientWidth', { get: () => this.px });
    Object.defineProperty(holder, 'clientHeight', { get: () => this.px });
    document.body.appendChild(holder);
    this.holder = holder;

    // The table can be dragged by the grip on its near edge. It keeps its heading (north stays
    // the far edge) and stays at a usable table height.
    this.rig = new DragRig(world, {
      id: TABLE_ID,
      gripWidthM: 0.5,
      gripHeightM: 0.045,
      faceHead: false,
      limits: { minDist: 0, maxDist: 3, minY: 0.5, maxY: 1.3 },
    });
    this.rig.entity.addComponent(MapTableTag, { slot: 'table' });
    this.rig.grip.rotation.x = -Math.PI / 2; // lie flat so it is seen from above
    this.rig.placeGrip(0, -0.01, this.size / 2 + RIM_M + 0.05);
    this.root.name = 'MapTable';
    this.resetPlacement();

    const slab = new Mesh(new BoxGeometry(this.size + RIM_M * 2, 0.04, this.size + RIM_M * 2), this.slabMaterial);
    slab.position.y = -0.0205;
    this.root.add(slab);

    this.mapMesh = new Mesh(new PlaneGeometry(this.size, this.size), this.mapMaterial);
    this.mapMesh.name = 'MapTableSurface';
    this.mapMesh.rotation.x = -Math.PI / 2;
    this.mapMesh.position.y = 0.001;
    this.mapMesh.onBeforeRender = () => this.tick();

    // Zoom rail: a strip on the right rim with a knob that shows the zoom level.
    this.railMesh = new Mesh(new PlaneGeometry(RAIL_WIDTH_M, RAIL_LENGTH_M), this.railMaterial);
    this.railMesh.name = 'MapZoomRail';
    this.railMesh.rotation.x = -Math.PI / 2;
    this.railMesh.position.set(this.size / 2 + RIM_M / 2, 0.002, 0);
    this.knobMesh = new Mesh(new PlaneGeometry(RAIL_WIDTH_M + 0.02, RAIL_KNOB_M), this.knobMaterial);
    this.knobMesh.name = 'MapZoomKnob';
    this.knobMesh.position.z = 0.002;
    this.railMesh.add(this.knobMesh);
    setHoverTint(this.railMesh, [this.knobMaterial], 'textSecondary');

    this.applyColours();

    this.surfaceEntity = world.createTransformEntity(this.mapMesh, { parent: this.rig.entity, persistent: true });
    this.surfaceEntity.addComponent(MapTableTag, { slot: 'surface', value: this.view.zoom });
    this.surfaceEntity.addComponent(RayInteractable);
    const rail = world.createTransformEntity(this.railMesh, { parent: this.rig.entity, persistent: true });
    rail.addComponent(MapTableTag, { slot: 'zoom-rail' });
    rail.addComponent(RayInteractable);
    rail.addComponent(HoverFx, { slot: 'grip' });
    // Presses on the map and the rail are pan, pick and zoom; they must not drag the table.
    stopBubbling(this.mapMesh);
    stopBubbling(this.railMesh);
    this.entities.push(this.surfaceEntity, rail);

    this.bindPointers();
    this.bindRail();
    this.bindThumbstick();
    this.syncKnob();
    void this.createMap();
  }

  get root(): DragRig['root'] {
    return this.rig.root;
  }

  /** Put the table back at its default spot in front of the origin and forget any drag. */
  resetPlacement(): void {
    this.applyPose(DEFAULT_TABLE_POSE);
  }

  /**
   * Put the table straight ahead of a viewer at `head` looking along `forward`, at a height
   * that suits their eye level (seated or standing). Forgets any drag. A hard snap.
   */
  placeForViewer(head: Vec3Like, forward: Vec3Like): void {
    this.applyPose(tablePoseFor(head, forward));
  }

  private applyPose({ position, yaw }: Readonly<TablePose>): void {
    placements.delete(TABLE_ID);
    this.root.position.set(position.x, position.y, position.z);
    this.root.rotation.set(0, yaw, 0);
  }

  /** Settings changed: base map, theme colours, 3D buildings. */
  applyPrefs(prefs: Readonly<Prefs>): void {
    const kind = baseMapFor(prefs);
    if (kind !== this.baseKind || prefs.theme !== this.themeName) {
      this.baseKind = kind;
      this.themeName = prefs.theme;
      this.applyColours();
      this.restyleMap();
    }
    this.set3D(prefs.buildings3d);
  }

  /** Everything on the table that is not the map picture, from the current theme. */
  private applyColours(): void {
    const t = currentTokens();
    this.slabMaterial.color.setHex(hexNumber(t.background));
    this.slabMaterial.opacity = hexAlpha(t.background);
    if (!this.texture) this.mapMaterial.color.setHex(hexNumber(t.surface));
    this.railMaterial.color.setHex(hexNumber(t.surface));
    setHoverTint(this.railMesh, [this.knobMaterial], 'textSecondary');
    this.rebuildStrips();
  }

  // --- MapTable ------------------------------------------------------------------------------

  show(): void {
    this.visible = true;
    this.root.visible = true;
    this.scheduler.markDirty();
    this.scheduleViewEvent(); // lets the places list fill in on first show and on return from a street
  }

  hide(): void {
    this.visible = false;
    this.root.visible = false;
    // Let go of any pointer held on the map or the rail, or its capture would outlive the table.
    this.gestures.reset();
    if (this.railPointer !== null) this.release(this.railMesh, this.railPointer);
    this.railPointer = null;
    this.hoverPixel = null;
    this.zoomTarget = this.view.zoom; // drop an ease in progress
  }

  private release(mesh: Mesh, pointerId: number): void {
    try {
      mesh.releasePointerCapture(pointerId);
    } catch {
      /* capture is best-effort */
    }
  }

  flyTo(lat: number, lng: number, zoom?: number): void {
    // A jump, not an animation: animating would fetch tiles for every intermediate view.
    this.view.lat = lat;
    this.view.lng = lng;
    if (zoom !== undefined) this.view.zoom = clampZoom(zoom);
    this.zoomTarget = this.view.zoom;
    this.applyView();
  }

  /**
   * Ask for a zoom level. Every zoom input ends here: the level is clamped to the table's
   * range, and the map eases to it in `tick()` keeping canvas pixel (ax, ay) fixed.
   */
  zoomTo(z: number, ax = this.px / 2, ay = this.px / 2): void {
    this.zoomTarget = clampZoom(z);
    this.zoomAnchor.x = ax;
    this.zoomAnchor.y = ay;
    if (this.zoomTarget !== this.view.zoom) this.scheduler.markDirty();
  }

  /** The zoom level the map is easing toward. */
  get targetZoom(): number {
    return this.zoomTarget;
  }

  // --- curated spots and pick marker -----------------------------------------------------------

  setSpots(spots: CuratedSpot[]): void {
    const src = this.map?.getSource(SPOTS_SOURCE) as GeoJSONSource | undefined;
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
    this.lastPick = { lat, lng };
    const src = this.map?.getSource(PICK_SOURCE) as GeoJSONSource | undefined;
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
      selfUploads: this.selfUploads,
      inXR: !!this.world.session,
      view: { ...this.view },
      canvas: m ? `${m.getCanvas().width}x${m.getCanvas().height}` : 'none',
      error: this.error,
      sources: m?.style
        ? Object.keys(m.getStyle()?.sources ?? {})
            .map((id) => `${id}:${m.isSourceLoaded(id) ? 'ok' : 'loading'}`)
            .join(',')
        : '',
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
          lines.push(
            part.map((c) => {
              if (this.buildings3d) {
                const p = m.project([c[0], c[1]]);
                return { x: p.x, y: p.y };
              }
              return latLngToPixel(this.view, c[1], c[0], this.px);
            }),
          );
        }
      }
      const snap = nearestOnPolylines(px, py, lines, SNAP_PX);
      if (!snap) {
        this.log('pick-miss', { px, py, features: feats.length });
        this.bus.emit('error', {
          source: 'map',
          message: 'No 360° imagery there. Tap a glowing street.',
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
    // A clean tap on a coverage line goes straight into street view at the snapped point. The
    // table stays put while it loads (the map entry recentres it on pano:shown).
    this.bus.emit('spot:selected', spot);
    return spot;
  }

  /** Pan by canvas pixels, as a drag does. Exposed for the dev driver. */
  panPixels(dx: number, dy: number): void {
    this.panBy(null, dx, dy);
  }

  /**
   * Drag by (dx, dy) canvas pixels ending at (x, y). Flat view: plain Mercator maths. Tilted view
   * (3D): ask MapLibre which ground point was under the old and the new pixel, so the ground
   * follows the pointer despite the perspective.
   */
  private panBy(end: Pixel | null, dx: number, dy: number): void {
    const m = this.map;
    if (this.buildings3d && m) {
      const ex = end ? end.x : this.px / 2 + dx;
      const ey = end ? end.y : this.px / 2 + dy;
      const from = m.unproject([ex - dx, ey - dy]);
      const to = m.unproject([ex, ey]);
      this.view.lat = Math.max(-85, Math.min(85, this.view.lat + (from.lat - to.lat)));
      this.view.lng += from.lng - to.lng;
    } else {
      panByPixels(this.view, dx, dy);
    }
    this.applyView();
  }

  /** Set the zoom to `z` now, keeping the ground under canvas pixel (ax, ay) fixed, flat or tilted. */
  private zoomAt(ax: number, ay: number, z: number): void {
    const m = this.map;
    if (this.buildings3d && m) {
      const before = m.unproject([ax, ay]);
      this.view.zoom = clampZoom(z);
      m.jumpTo({ zoom: this.view.zoom });
      const after = m.unproject([ax, ay]);
      this.view.lat = Math.max(-85, Math.min(85, this.view.lat + (before.lat - after.lat)));
      this.view.lng += before.lng - after.lng;
      this.applyView();
    } else {
      zoomAround(this.view, ax, ay, z, this.px);
      this.applyView();
    }
  }

  /** 3D buildings and a tilted camera. Off by default; the choice is saved by `PrefsStore`. */
  set3D(on: boolean): void {
    if (on === this.buildings3d) return;
    this.buildings3d = on;
    this.rebuildStrips();
    const map = this.map;
    if (map) {
      if (map.getLayer(BUILDINGS_LAYER)) map.setLayoutProperty(BUILDINGS_LAYER, 'visibility', on ? 'visible' : 'none');
      // A jump, never an animated tilt: moving the picture smoothly is a comfort risk.
      map.jumpTo({ pitch: on ? PITCH_3D : 0, bearing: 0 });
    }
    this.scheduler.markDirty();
  }

  get3D(): boolean {
    return this.buildings3d;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    this.offs.forEach((off) => off());
    this.offs.length = 0;
    this.mapMesh.onBeforeRender = () => {};
    this.map?.remove();
    this.map = null;
    this.texture?.dispose();
    this.holder.remove();
    for (const strip of [this.creditMesh, this.hintMesh]) if (strip) this.disposeStrip(strip);
    for (const e of this.entities) e.dispose();
    this.entities.length = 0;
    this.rig.dispose();
    this.slabMaterial.dispose();
  }

  // --- MapLibre ----------------------------------------------------------------------------------

  private async createMap(): Promise<void> {
    if (this.disposed) return;
    if (!this.token) this.fail('No Mapillary token, so the map cannot show where street imagery exists.');
    const style = this.mapStyle();

    const map = new maplibregl.Map({
      container: this.holder,
      style,
      center: [this.view.lng, this.view.lat],
      zoom: this.view.zoom,
      pitch: this.buildings3d ? PITCH_3D : 0,
      bearing: 0,
      maxPitch: 60,
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
      const ev = e as unknown as { sourceId?: string; tile?: { tileID?: { canonical?: unknown } } };
      this.log('map-error', { msg, source: ev.sourceId, tile: ev.tile?.tileID?.canonical });
    });
    map.on('styleimagemissing', () => {});
    map.on('data', () => {
      this.lastDataAt = performance.now();
      this.scheduler.markDirty();
    });
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
    this.mapMaterial.color.setScalar(1); // no tint: show the map texture as drawn
    this.mapMaterial.needsUpdate = true;
    this.scheduler.markDirty();
    this.log('map-created', { canvas: `${map.getCanvas().width}x${map.getCanvas().height}` });
  }

  private mapStyle(): StyleSpecification {
    return buildMapStyle(this.baseKind, { token: this.token, buildings3d: this.buildings3d, spots: this.pendingSpots });
  }

  /**
   * Rebuild the MapLibre style for the current base map and theme (satellite, dark or light,
   * plus the overlay colours). Keeps the view, spots and pick marker.
   */
  private restyleMap(): void {
    const map = this.map;
    if (!map) return;
    const style = this.mapStyle();
    map.once('style.load', () => {
      if (this.lastPick) this.markPick(this.lastPick.lat, this.lastPick.lng);
      this.scheduler.markDirty();
    });
    map.setStyle(style);
    this.scheduler.markDirty();
  }

  getBaseMap(): BaseMapKind {
    return this.baseKind;
  }

  private disposeStrip(strip: Mesh): void {
    this.root.remove(strip);
    strip.geometry.dispose();
    const m = strip.material as MeshBasicMaterial;
    m.map?.dispose();
    m.dispose();
  }

  /** The two text strips on the rim: how to use the table (far edge), map credit (near edge). */
  private rebuildStrips(): void {
    const t = currentTokens();
    if (this.creditMesh) this.disposeStrip(this.creditMesh);
    if (this.hintMesh) this.disposeStrip(this.hintMesh);
    const z = this.size / 2 + RIM_M / 2;
    this.hintMesh = this.textStrip(
      'Drag to pan  ·  thumbstick up/down, spread two hands or slide the rail to zoom  ·  tap a glowing street',
      -z,
      t.textPrimary,
      26,
    );
    this.creditMesh = this.textStrip(mapCredit(this.baseKind, this.buildings3d), z, t.textSecondary, 26);
    this.root.add(this.hintMesh, this.creditMesh);
  }

  private applyView(): void {
    this.map?.jumpTo({
      center: [this.view.lng, this.view.lat],
      zoom: this.view.zoom,
      pitch: this.buildings3d ? PITCH_3D : 0,
      bearing: 0,
    });
    this.scheduler.markDirty();
    this.scheduleViewEvent();
    if (this.view.zoom !== this.shownZoom) {
      this.shownZoom = this.view.zoom;
      // The live zoom is readable from outside as `MapTableTag.value` on the surface entity.
      this.surfaceEntity.setValue(MapTableTag, 'value', this.view.zoom);
      this.syncKnob();
    }
  }
  private shownZoom = Number.NaN;

  /** Move the rail's knob to the current zoom level. */
  private syncKnob(): void {
    this.knobMesh.position.y = (zoomToRail(this.view.zoom) - 0.5) * (RAIL_LENGTH_M - RAIL_KNOB_M);
  }

  /** Tell the rest of the app where the map is looking, once the user stops moving it. */
  private scheduleViewEvent(): void {
    if (this.viewTimer !== null) clearTimeout(this.viewTimer);
    this.viewTimer = setTimeout(() => {
      this.viewTimer = null;
      if (this.disposed) return;
      this.bus.emit('map:viewChanged', { lat: this.view.lat, lng: this.view.lng, zoom: this.view.zoom });
    }, 700);
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
    const now = performance.now();
    // Ease the zoom toward its target, one step per rendered frame.
    if (this.view.zoom !== this.zoomTarget) {
      const dt = Math.min(MAX_EASE_STEP_MS, now - this.lastEaseAt);
      this.zoomAt(this.zoomAnchor.x, this.zoomAnchor.y, stepZoom(this.view.zoom, this.zoomTarget, dt));
    }
    this.lastEaseAt = now;
    // Keep polling while tiles arrive, but stop after a quiet spell so a stalled tile request
    // does not keep re-uploading a 2048 px texture several times a second forever.
    this.scheduler.setPending(!m.loaded() && now - this.lastDataAt < PENDING_QUIET_MS);
    if (this.scheduler.due(now)) {
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
      this.selfUploads++;
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

  /** Map presses go through `TableGestures`; this only converts hits to canvas pixels. */
  private bindPointers(): void {
    const mesh = this.mapMesh;
    const now = (): number => performance.now();
    const onDown = (e: { pointerId: number; point: Vector3; button?: number; pointerType?: string }): void => {
      this.log('pointerdown', { id: e.pointerId, button: e.button, type: e.pointerType });
      if (!this.visible || (e.button !== undefined && e.button !== 0)) return;
      this.gestures.down(e.pointerId, this.hitToPixel(e.point), now());
      try {
        mesh.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
    };
    const onMove = (e: { pointerId: number; point: Vector3 }): void => {
      const p = this.hitToPixel(e.point);
      // Remember where a ray rests on the map, pressed or not: the thumbstick zooms around it.
      this.hoverScratch.x = p.x;
      this.hoverScratch.y = p.y;
      this.hoverPixel = this.hoverScratch;
      this.gestures.move(e.pointerId, p, now());
    };
    const up = (e: { pointerId: number }, cancelled: boolean): void => {
      this.release(mesh, e.pointerId);
      this.gestures.up(e.pointerId, now(), cancelled);
    };
    const onUp = (e: { pointerId: number }) => up(e, false);
    const onCancel = (e: { pointerId: number }) => up(e, true);
    const onWheel = (e: { point: Vector3; deltaY: number }) => {
      if (!this.visible) return;
      const p = this.hitToPixel(e.point);
      this.zoomTo(wheelZoom(this.zoomTarget, e.deltaY), p.x, p.y);
    };
    const onLeave = (): void => {
      this.hoverPixel = null;
    };
    mesh.addEventListener('pointerdown', onDown);
    mesh.addEventListener('pointermove', onMove);
    mesh.addEventListener('pointerup', onUp);
    mesh.addEventListener('pointercancel', onCancel);
    mesh.addEventListener('pointerleave', onLeave);
    mesh.addEventListener('wheel', onWheel);
    this.offs.push(() => {
      mesh.removeEventListener('pointerdown', onDown);
      mesh.removeEventListener('pointermove', onMove);
      mesh.removeEventListener('pointerup', onUp);
      mesh.removeEventListener('pointercancel', onCancel);
      mesh.removeEventListener('pointerleave', onLeave);
      mesh.removeEventListener('wheel', onWheel);
    });
  }

  /**
   * Zoom rail: press anywhere on it and drag along it. The position along the rail maps
   * straight onto the zoom range (near end = widest view, far end = closest), so one hand or
   * one controller can zoom, and the knob doubles as a zoom-level readout.
   */
  private bindRail(): void {
    const rail = this.railMesh;
    const zoomFromHit = (point: Vector3): void => {
      // PlaneGeometry local y runs along the rail; after the flat rotation +y is the far end.
      const local = rail.worldToLocal(this.tmpLocal.copy(point));
      this.zoomTo(railToZoom(local.y / RAIL_LENGTH_M + 0.5));
    };
    const onDown = (e: { pointerId: number; point: Vector3; button?: number }): void => {
      if (!this.visible || (e.button !== undefined && e.button !== 0)) return;
      this.railPointer = e.pointerId;
      try {
        rail.setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      zoomFromHit(e.point);
    };
    const onMove = (e: { pointerId: number; point: Vector3 }): void => {
      if (e.pointerId === this.railPointer) zoomFromHit(e.point);
    };
    const onUp = (e: { pointerId: number }): void => {
      if (e.pointerId !== this.railPointer) return;
      this.railPointer = null;
      this.release(rail, e.pointerId);
    };
    rail.addEventListener('pointerdown', onDown);
    rail.addEventListener('pointermove', onMove);
    rail.addEventListener('pointerup', onUp);
    rail.addEventListener('pointercancel', onUp);
    this.offs.push(() => {
      rail.removeEventListener('pointerdown', onDown);
      rail.removeEventListener('pointermove', onMove);
      rail.removeEventListener('pointerup', onUp);
      rail.removeEventListener('pointercancel', onUp);
    });
  }

  /**
   * Controllers: either thumbstick, pushed away to zoom in, pulled back to zoom out. Zooms
   * around the spot a ray rests on the map, or the centre when no ray is on it.
   */
  private bindThumbstick(): void {
    const off = this.world.onXRFrame((_frame, delta) => {
      if (!this.visible || !this.map) return;
      const pads = this.world.input.xr.gamepads;
      const left = pads.left?.getAxesValues('xr-standard-thumbstick')?.y ?? 0;
      const right = pads.right?.getAxesValues('xr-standard-thumbstick')?.y ?? 0;
      // Whichever stick is pushed further wins, so both hands work and they never add up.
      const rate = stickZoomRate(Math.abs(left) > Math.abs(right) ? left : right);
      if (rate === 0) return;
      const anchor = this.hoverPixel;
      this.zoomTo(this.zoomTarget + rate * delta, anchor ? anchor.x : this.px / 2, anchor ? anchor.y : this.px / 2);
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
