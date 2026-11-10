/**
 * Pure HUD logic (no Three.js, no DOM). Everything here is unit tested in hud-logic.test.ts.
 * All copy is plain ASCII: the UI font is not known to carry typographic glyphs.
 */
import type { AppState, ArchivePhoto, LatLng, Mode, Pano } from '../contracts.js';
import { yearOf } from '../contracts.js';

// ---------------------------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------------------------

const BASE_CREDIT = 'Imagery (c) Mapillary contributors | Map data (c) OpenStreetMap contributors';

const clean = (s: string | undefined | null): string => (s ?? '').replace(/\s+/gu, ' ').trim();

/**
 * Credit line text. Always contains Mapillary and OpenStreetMap, never empty. Adds the street
 * imagery creator and, per archive photo, "creator (licence)"; duplicates are removed.
 */
export function composeCredits(
  pano: Pick<Pano, 'creator'> | null | undefined,
  photos: ReadonlyArray<Pick<ArchivePhoto, 'creator' | 'license'>> = [],
): string {
  const parts: string[] = [BASE_CREDIT];
  const creator = clean(pano?.creator);
  if (creator) parts.push(`Photo: ${creator}`);

  const seen = new Set<string>();
  const archive: string[] = [];
  for (const photo of photos) {
    const who = clean(photo.creator) || 'unknown';
    const licence = clean(photo.license);
    const entry = licence ? `${who} (${licence})` : who;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    archive.push(entry);
  }
  if (archive.length > 0) parts.push(`Archive: ${archive.join(', ')}`);
  return parts.join(' | ');
}

// ---------------------------------------------------------------------------------------------
// Derived HUD view
// ---------------------------------------------------------------------------------------------

export interface HudInputs {
  state: Pick<AppState, 'mode' | 'pano' | 'years' | 'timeOn' | 'year'>;
  /** True once `time:yearsKnown` arrived for the current spot. */
  yearsKnown: boolean;
}

export interface HudView {
  showTimeButton: boolean;
  timeButtonEnabled: boolean;
  timeButtonLabel: string;
  showYear: boolean;
  yearText: string;
  /** Lens is on: the year label gets the "past" tint. */
  yearIsPast: boolean;
  showPortalButton: boolean;
  portalButtonLabel: string;
  /** Mode the portal button asks for when pressed. */
  portalTarget: Mode;
  noEarlierImagery: boolean;
}

export function canUseTimeMachine(years: readonly number[], hasPano: boolean): boolean {
  return hasPano && years.length >= 2;
}

export function deriveHud({ state, yearsKnown }: HudInputs): HudView {
  const inScene = state.mode === 'street' || state.mode === 'portal';
  const enabled = inScene && canUseTimeMachine(state.years, state.pano !== null);
  const presentYear = state.pano ? yearOf(state.pano) : null;
  // A lens that is "on" at a spot with nothing earlier is stale state; show the present.
  const lensOn = state.timeOn && enabled;
  const shown = lensOn && state.year !== null ? state.year : presentYear;
  return {
    showTimeButton: inScene,
    timeButtonEnabled: enabled,
    timeButtonLabel: lensOn ? 'BACK TO NOW' : 'TIME MACHINE',
    showYear: inScene,
    yearText: shown === null ? '----' : String(shown),
    yearIsPast: lensOn && state.year !== null,
    showPortalButton: inScene,
    portalButtonLabel: state.mode === 'portal' ? 'BACK' : 'PORTAL',
    portalTarget: state.mode === 'portal' ? 'street' : 'portal',
    noEarlierImagery:
      inScene && yearsKnown && state.pano !== null && !canUseTimeMachine(state.years, true),
  };
}

// ---------------------------------------------------------------------------------------------
// Year list (the small panel under the TIME MACHINE button)
// ---------------------------------------------------------------------------------------------

export const MAX_YEAR_CHIPS = 8;

export interface YearChip {
  year: number;
  /** The year now on screen (the lens year when the lens is on, else the present). */
  selected: boolean;
  /** The year of the panorama the viewer stands in, i.e. "now". */
  isPresent: boolean;
}

/**
 * One chip per year the imagery source really has here, ascending, newest kept if there are
 * more than `MAX_YEAR_CHIPS`. Empty outside street/portal or before the years are known.
 */
export function yearChips({ state, yearsKnown }: HudInputs): YearChip[] {
  const inScene = state.mode === 'street' || state.mode === 'portal';
  if (!inScene || !yearsKnown || state.pano === null || state.years.length < 2) return [];
  const present = yearOf(state.pano);
  const shown = state.timeOn && state.year !== null ? state.year : present;
  return [...state.years]
    .sort((a, b) => a - b)
    .slice(-MAX_YEAR_CHIPS)
    .map((year) => ({ year, selected: year === shown, isPresent: year === present }));
}

/** What a click on a chip should do. */
export type YearChipAction = { kind: 'toggleOff' } | { kind: 'goto'; year: number; openLens: boolean };

export function yearChipAction(chip: YearChip, timeOn: boolean): YearChipAction {
  if (chip.isPresent) return { kind: 'toggleOff' };
  return { kind: 'goto', year: chip.year, openLens: !timeOn };
}

// ---------------------------------------------------------------------------------------------
// Places list (room only): curated spots that have past imagery
// ---------------------------------------------------------------------------------------------

export const PLACES_PER_PAGE = 5;
/** Below this map zoom the view is too wide for a "nearby" list. */
export const PLACES_MIN_ZOOM = 13;

export interface PlaceRow {
  /** "120m NE": distance and direction from the map centre. Mapillary gives no place names. */
  name: string;
  /** "2016-2025" or "2016" when there is a single year. Plain ASCII. */
  yearsText: string;
  /** Index into the places array that was passed in. */
  index: number;
}

export interface PlacesPage {
  rows: PlaceRow[];
  page: number;
  pageCount: number;
  pageText: string;
}

/** The room list shows when there is a place to list, or while a lookup is running. */
export const showPlacesPanel = (mode: Mode, placeCount: number, loading = false): boolean =>
  mode === 'table' && (placeCount > 0 || loading);

/** Drops places with a non-finite position or no finite year, so no row can read "NaN". */
export function usablePlaces<T extends LatLng & { years: readonly number[] }>(places: readonly T[]): T[] {
  return places.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.years.some((y) => Number.isFinite(y)),
  );
}
export const showMapButton = (mode: Mode): boolean => mode === 'street' || mode === 'portal';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Distance and compass direction from `from` to `to`, e.g. "120m NE" or "1.2km S". */
export function describeOffset(from: LatLng, to: LatLng): string {
  if (![from.lat, from.lng, to.lat, to.lng].every(Number.isFinite)) return 'Nearby';
  const rad = Math.PI / 180;
  const dy = (to.lat - from.lat) * 111_320;
  const dx = (to.lng - from.lng) * 111_320 * Math.cos(from.lat * rad);
  const d = Math.hypot(dx, dy);
  if (d < 15) return 'Here';
  const bearing = (Math.atan2(dx, dy) / rad + 360) % 360;
  const dir = COMPASS[Math.round(bearing / 45) % 8]!;
  const dist = d < 1000 ? `${Math.round(d / 10) * 10}m` : `${(d / 1000).toFixed(1)}km`;
  return `${dist} ${dir}`;
}

/** The title line: tells the user why the list is empty when it is. */
export function placesTitle(zoom: number | null, loading: boolean, count: number, dotFrame = 3): string {
  if (zoom !== null && zoom < PLACES_MIN_ZOOM) return 'ZOOM IN TO FIND PLACES';
  // While loading, the three dots cycle 1 → 2 → 3 (frame is taken modulo 3, 0 counts as 3).
  if (loading) return `LOOKING NEARBY${'.'.repeat(((dotFrame + 2) % 3) + 1)}`;
  return count === 0 ? 'NO PAST IMAGERY NEARBY' : 'NEARBY, WITH PAST IMAGERY';
}

/** Pages `places` (already nearest first) five at a time. */
export function placesPage(
  places: ReadonlyArray<LatLng & { years: readonly number[] }>,
  centre: LatLng | null,
  requestedPage: number,
): PlacesPage {
  const pageCount = Math.max(1, Math.ceil(places.length / PLACES_PER_PAGE));
  const page = Math.min(Math.max(0, Math.floor(requestedPage)), pageCount - 1);
  const rows = places.slice(page * PLACES_PER_PAGE, (page + 1) * PLACES_PER_PAGE).map((p, i) => {
    const ys = p.years.filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
    const yearsText = ys.length === 0 ? '' : ys.length === 1 ? String(ys[0]) : `${ys[0]}-${ys[ys.length - 1]}`;
    return { name: centre ? describeOffset(centre, p) : 'Nearby', yearsText, index: page * PLACES_PER_PAGE + i };
  });
  return { rows, page, pageCount, pageText: `${page + 1} / ${pageCount}` };
}

// ---------------------------------------------------------------------------------------------
// Busy scopes (spinner)
// ---------------------------------------------------------------------------------------------

/** Counts scopes that are busy. A scope that reports busy twice still needs only one `false`. */
export class BusyScopes {
  private readonly scopes = new Set<string>();

  set(scope: string, busy: boolean): void {
    if (busy) this.scopes.add(scope);
    else this.scopes.delete(scope);
  }

  get count(): number {
    return this.scopes.size;
  }

  get busy(): boolean {
    return this.scopes.size > 0;
  }

  clear(): void {
    this.scopes.clear();
  }
}

// ---------------------------------------------------------------------------------------------
// Toast queue
// ---------------------------------------------------------------------------------------------

export interface Toast {
  message: string;
  /** Sticky toasts (recoverable false) stay until `clear()`. */
  sticky: boolean;
  source: string;
}

export interface ToastQueueOptions {
  durationMs?: number;
  maxQueued?: number;
  onChange: (current: Toast | null) => void;
}

/** One toast at a time. Recoverable errors auto-dismiss; hard stops stay until cleared. */
export class ToastQueue {
  static readonly DEFAULT_DURATION_MS = 4000;
  private readonly durationMs: number;
  private readonly maxQueued: number;
  private readonly onChange: (current: Toast | null) => void;
  private queue: Toast[] = [];
  private currentToast: Toast | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: ToastQueueOptions) {
    this.durationMs = options.durationMs ?? ToastQueue.DEFAULT_DURATION_MS;
    this.maxQueued = options.maxQueued ?? 5;
    this.onChange = options.onChange;
  }

  get current(): Toast | null {
    return this.currentToast;
  }

  get pending(): number {
    return this.queue.length;
  }

  push(source: string, message: string, recoverable: boolean): void {
    const toast: Toast = { source, message, sticky: !recoverable };
    const last = this.queue[this.queue.length - 1] ?? this.currentToast;
    if (last && last.message === toast.message && last.sticky === toast.sticky) return;
    if (this.currentToast === null) {
      this.show(toast);
      return;
    }
    if (this.queue.length >= this.maxQueued) this.queue.shift();
    this.queue.push(toast);
  }

  /** Drop everything, including a sticky toast. */
  clear(): void {
    this.queue = [];
    this.stopTimer();
    if (this.currentToast !== null) {
      this.currentToast = null;
      this.onChange(null);
    }
  }

  dispose(): void {
    this.queue = [];
    this.stopTimer();
    this.currentToast = null;
  }

  private show(toast: Toast): void {
    this.currentToast = toast;
    this.onChange(toast);
    if (!toast.sticky) this.timer = setTimeout(() => this.advance(), this.durationMs);
  }

  private advance(): void {
    this.timer = null;
    const next = this.queue.shift() ?? null;
    if (next) {
      this.show(next);
    } else {
      this.currentToast = null;
      this.onChange(null);
    }
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Placement (pure maths; entry.ts applies it to the panels)
// ---------------------------------------------------------------------------------------------

export type HudSlot =
  | 'time'
  | 'year'
  | 'credits'
  | 'status'
  | 'portal'
  | 'info'
  | 'places'
  | 'search'
  | 'map';

export interface SlotSpec {
  /** Degrees to the left of the user's forward direction (negative is right). */
  leftDeg: number;
  /** Horizontal distance from the head, metres. */
  distance: number;
  /** Height relative to the head, metres (negative is below the eye line). */
  dy: number;
}

export const SLOTS: Readonly<Record<HudSlot, SlotSpec>> = {
  credits: { leftDeg: 0, distance: 1.5, dy: -0.66 },
  info: { leftDeg: 0, distance: 1.5, dy: -0.78 },
  status: { leftDeg: 0, distance: 1.5, dy: -0.5 },
  time: { leftDeg: 32, distance: 1.4, dy: -0.2 },
  year: { leftDeg: -32, distance: 1.4, dy: -0.05 },
  portal: { leftDeg: -32, distance: 1.4, dy: -0.4 },
  // Room (table mode) list of places, beside the map table. Street mode never shows it.
  places: { leftDeg: 42, distance: 1.3, dy: -0.1 },
  // Search (type or speak a place), beside the table on the right. Table mode only.
  search: { leftDeg: -30, distance: 1.5, dy: -0.12 },
  // Same spot as the PORTAL button's neighbour: just below it.
  map: { leftDeg: -32, distance: 1.4, dy: -0.55 },
};

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Yaw (radians, 0 = looking down -Z, positive = turning left) from a forward vector. */
export function yawFromForward(fx: number, fz: number): number {
  return Math.atan2(-fx, -fz);
}

/** World position of a slot for a head at `head` facing `yaw`. Writes into `out`. */
export function slotPosition(head: Vec3Like, yaw: number, slot: SlotSpec, out: Vec3Like): Vec3Like {
  const a = yaw + (slot.leftDeg * Math.PI) / 180;
  out.x = head.x - Math.sin(a) * slot.distance;
  out.y = head.y + slot.dy;
  out.z = head.z - Math.cos(a) * slot.distance;
  return out;
}
