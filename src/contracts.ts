/**
 * Street View Time Machine — contracts. FROZEN after Phase 0.
 *
 * Tracks talk to each other only through the types, interfaces and event bus in this file.
 * Only the orchestrator edits it. A track that needs a change reports it instead of working
 * around it.
 *
 * Conventions
 *  - Headings and compass angles are degrees clockwise from north.
 *  - World space: north is -Z, east is +X, up is +Y. (A panorama's centre column looks
 *    toward its heading.)
 *  - `capturedAt` is milliseconds since the epoch, exactly as Mapillary reports it.
 *  - Image URLs expire (about 30 days). Never persist one; persist ids and call
 *    `PanoSource.resolve` for a fresh URL.
 */

import type { Object3D, Texture, Vector3, World } from '@iwsdk/core';

// ---------------------------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Pano extends LatLng {
  /** Mapillary image id (string; ids exceed 2^53 safe-integer comfort in some APIs). */
  id: string;
  capturedAt: number;
  /** Compass heading of the image's centre column. Prefer Mapillary `computed_compass_angle`. */
  heading: number;
  /** Full-size equirectangular image (`thumb_original_url`). Expires. */
  imageUrl: string;
  /** Fast 2048 px image (`thumb_2048_url`) for first paint and lens previews. Optional. */
  previewUrl?: string;
  width: number;
  height: number;
  /** Mapillary username, shown in the credit line. */
  creator: string;
  sequenceId: string;
}

export interface ArchivePhoto extends LatLng {
  title: string;
  /** Best-effort year the photo was taken. */
  year: number;
  imageUrl: string;
  /** Page on Wikimedia Commons, for the credit. */
  pageUrl: string;
  creator: string;
  license: string;
  width: number;
  height: number;
}

export interface SpotInfo extends LatLng {
  label?: string;
}

/** A curated place in `src/data/spots.json`. Stores a pano id, never a URL. */
export interface CuratedSpot extends LatLng {
  name: string;
  panoId: string;
  /** Years verified to have a panorama within `config.maxYearOffsetMetres`. */
  years: number[];
}

/** A place near the map view that has panoramas from at least two different years. */
export interface NearbyPlace extends LatLng {
  /** Newest panorama at the place. */
  panoId: string;
  /** Capture years found within `config.maxYearOffsetMetres` of the place, ascending. */
  years: number[];
}

export function yearOf(pano: Pick<Pano, 'capturedAt'>): number {
  return new Date(pano.capturedAt).getUTCFullYear();
}

// ---------------------------------------------------------------------------------------------
// App state and mode
// ---------------------------------------------------------------------------------------------

export type Mode = 'table' | 'street' | 'portal';

/** Derived from events by `createAppState`. Read-only to tracks: emit events to change it. */
export interface AppState {
  mode: Mode;
  spot: SpotInfo | null;
  pano: Pano | null;
  /** Years that have a panorama near `pano`, ascending. Empty until `time:yearsKnown`. */
  years: number[];
  timeOn: boolean;
  /** Year currently dialled, or null when the lens is off. */
  year: number | null;
}

/** The three switches on the settings panel. Owned by `PrefsStore` (`src/prefs.ts`). */
export interface Prefs {
  /** Satellite imagery on the table map. Off shows the map that matches `theme`. */
  satellite: boolean;
  /** Colours of every UI surface, and the non-satellite base map. */
  theme: 'dark' | 'light';
  /** Tilted table map with extruded buildings. */
  buildings3d: boolean;
}

/** Read and change the settings. Changing one emits `prefs:changed`. */
export interface PrefsAccess {
  get(): Readonly<Prefs>;
  set(patch: Partial<Prefs>): void;
}

export function initialAppState(): AppState {
  return { mode: 'table', spot: null, pano: null, years: [], timeOn: false, year: null };
}

// ---------------------------------------------------------------------------------------------
// Typed event bus
// ---------------------------------------------------------------------------------------------

/**
 * Who emits what (emit only your own; listen to anything):
 *  spot:selected      Track D (map pick) or the landing page, or the curated list.
 *  map:flyRequested   Track G (search panel). Track D moves the table map there; no street view yet.
 *  pano:shown         Track B after `show` or `commitPast` has put a panorama on screen.
 *  map:viewChanged    Track D, about 0.7 s after the table map stopped panning or zooming.
 *  time:yearsKnown    Track C, after `pano:shown`, from `PanoSource.yearsAt`.
 *  time:toggled       Track G (TIME MACHINE button). Track C listens.
 *  time:yearChanged   Track C (wrist dial or mouse wheel). `year` may be below the earliest
 *                     Mapillary year, which is Track F's cue to show archive photos.
 *  time:yearRequested Track G (year panel click). Track C jumps the dial to that year.
 *  time:committed     Track C when push-through completes (after `stage.commitPast`).
 *  archive:visible    Track F with the photos now on screen (empty array when hidden).
 *  mode:requested     Anyone (Track G buttons, Track E frame). The orchestrator's flow decides.
 *  mode:changed       Orchestrator flow only.
 *  prefs:changed      `PrefsStore` only, after a settings switch changed (already saved, theme
 *                     already applied). Track D follows it for the base map and 3D buildings.
 *  loading            Anyone doing slow work; Track G shows a spinner while any scope is busy.
 *  error              Anyone; Track G shows a toast. `recoverable` false means a hard stop.
 */
export interface EventMap {
  'spot:selected': SpotInfo;
  'map:viewChanged': { lat: number; lng: number; zoom: number };
  'map:flyRequested': { lat: number; lng: number; zoom?: number; label?: string };
  'pano:shown': { pano: Pano };
  'time:yearsKnown': { years: number[]; earliest: number | null };
  'time:toggled': { on: boolean };
  'time:yearChanged': { year: number };
  'time:yearRequested': { year: number };
  'time:committed': { year: number; pano: Pano };
  'archive:visible': { photos: ArchivePhoto[] };
  'mode:requested': { mode: Mode };
  'mode:changed': { mode: Mode; previous: Mode };
  'prefs:changed': Prefs;
  loading: { scope: string; busy: boolean };
  error: { source: string; message: string; recoverable: boolean };
}

export type EventName = keyof EventMap;
export type Unsubscribe = () => void;

export class EventBus {
  private handlers = new Map<EventName, Set<(payload: never) => void>>();

  on<K extends EventName>(type: K, handler: (payload: EventMap[K]) => void): Unsubscribe {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as (payload: never) => void);
    return () => set!.delete(handler as (payload: never) => void);
  }

  once<K extends EventName>(type: K, handler: (payload: EventMap[K]) => void): Unsubscribe {
    const off = this.on(type, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  /** Handlers run synchronously in subscription order. One throwing never blocks the rest. */
  emit<K extends EventName>(type: K, payload: EventMap[K]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        (handler as (p: EventMap[K]) => void)(payload);
      } catch (err) {
        console.error(`[bus] handler for "${type}" threw`, err);
      }
    }
  }
}

export interface AppStateStore {
  get(): Readonly<AppState>;
  dispose(): void;
}

/** Folds events into a state snapshot. Created once, by the orchestrator, in `index.ts`. */
export function createAppState(bus: EventBus): AppStateStore {
  let state = initialAppState();
  const offs: Unsubscribe[] = [
    bus.on('spot:selected', (spot) => {
      state = { ...state, spot };
    }),
    bus.on('pano:shown', ({ pano }) => {
      state = { ...state, pano };
    }),
    bus.on('time:yearsKnown', ({ years }) => {
      state = { ...state, years };
    }),
    bus.on('time:toggled', ({ on }) => {
      state = { ...state, timeOn: on, year: on ? state.year : null };
    }),
    bus.on('time:yearChanged', ({ year }) => {
      state = { ...state, year };
    }),
    bus.on('time:committed', ({ pano }) => {
      state = { ...state, timeOn: false, year: null, pano };
    }),
    bus.on('mode:changed', ({ mode }) => {
      state = { ...state, mode };
    }),
  ];
  return {
    get: () => state,
    dispose: () => offs.forEach((off) => off()),
  };
}

// ---------------------------------------------------------------------------------------------
// Services (each is provided by exactly one track)
// ---------------------------------------------------------------------------------------------

/** Track A. */
export interface PanoSource {
  /** Panoramas within `radiusM` (default and max 50) of a point, nearest first. */
  panosNear(lat: number, lng: number, radiusM?: number): Promise<Pano[]>;
  /**
   * One panorama per capture year around a point: the nearest to the point within
   * `config.maxYearOffsetMetres`. Cached per spot.
   */
  yearsAt(lat: number, lng: number): Promise<Map<number, Pano>>;
  /** Panoramas along the same street, for hop arrows. Same year as `pano`, nearest first. */
  neighbours(pano: Pano): Promise<Pano[]>;
  /** Fetch a panorama by id with fresh, unexpired image URLs. */
  resolve(id: string): Promise<Pano>;
  /**
   * Places with panoramas from 2+ years in a box of about 1 km around the point (the point is
   * snapped to a 0.003 degree grid, so small pans reuse the cache). Nearest to the point first.
   * `onPartial`, when given, receives the places found so far as each tile arrives (a fresh
   * lookup only; a cached one just resolves), so a list can fill in before the search ends.
   */
  placesNear(lat: number, lng: number, onPartial?: (places: NearbyPlace[]) => void): Promise<NearbyPlace[]>;
  /** The curated launch spots. */
  spots(): CuratedSpot[];
}

/**
 * The lens parameters Track C writes every frame and Track B's shader reads. Plain fields,
 * no allocation: mutate `direction` in place.
 */
export interface PanoLens {
  /** Draw `pastTexture` inside the lens. When false the sphere shows only the present. */
  enabled: boolean;
  pastTexture: Texture | null;
  /** Heading of the past panorama (degrees), so north lines up with the present one. */
  pastHeading: number;
  /** Unit vector in world space from the head toward the lens centre. */
  direction: Vector3;
  /** Angular radius in radians, 0 to PI. PI covers the whole view (push-through). */
  radius: number;
  /** Soft edge width in radians. */
  feather: number;
  /** Seconds, drives the shimmer. */
  time: number;
}

/** Track B. */
export interface PanoStage {
  /** Root of the stage's scene content (sphere, fade quad). */
  readonly root: Object3D;
  readonly currentPano: Pano | null;
  readonly currentTexture: Texture | null;
  readonly lens: PanoLens;
  /**
   * When non-null the sphere draws only where the stencil buffer equals this value
   * (Track E's portal window writes it). Null means draw everywhere.
   */
  stencilRef: number | null;
  /** Fade to black, switch, fade in. Never moves the camera. Emits `pano:shown`. */
  show(pano: Pano): Promise<void>;
  /** Load a past panorama into `lens.pastTexture` and `lens.pastHeading`. */
  loadPast(pano: Pano): Promise<Texture>;
  /** Make the past panorama the current one and free the old texture. Emits `pano:shown`. */
  commitPast(): void;
  /** Free the past texture and disable the lens. */
  clearPast(): void;
  /** Show or hide the whole sphere (hidden on the table). */
  setVisible(visible: boolean): void;
  /** Live panorama textures right now. Must never exceed 2. */
  textureCount(): number;
}

/** Track D. */
export interface MapTable {
  show(): void;
  hide(): void;
  flyTo(lat: number, lng: number, zoom?: number): void;
}

/** Track E. */
export interface Portal {
  open(): void;
  close(): void;
}

/** Track F. */
export interface ArchiveService {
  photosNear(lat: number, lng: number, beforeYear?: number): Promise<ArchivePhoto[]>;
}

// ---------------------------------------------------------------------------------------------
// Track entry points
// ---------------------------------------------------------------------------------------------

export interface Services {
  source: PanoSource;
  stage: PanoStage;
}

export interface TrackContext {
  world: World;
  bus: EventBus;
  state: AppStateStore;
  /** User settings (satellite, theme, 3D buildings). */
  prefs: PrefsAccess;
  /** Real or mock, depending on what `index.ts` wired. Code against the interface only. */
  services: Services;
}

export interface Track {
  readonly name: string;
  dispose(): void;
}

/**
 * Each track exports its entry point from `src/<folder>/entry.ts`:
 *  - Track A: `createPanoSource(): PanoSource`
 *  - Track B: `createPanoStage(world: World, bus: EventBus): PanoStage`
 *  - Tracks C, D, E, F, G: `createTrack: TrackFactory` (D, E, F may return an object that also
 *    implements `MapTable`, `Portal`, `ArchiveService`).
 * `index.ts` wires them once; tracks never edit it.
 */
export type TrackFactory = (ctx: TrackContext) => Track | Promise<Track>;
