/**
 * Pure HUD logic (no Three.js, no DOM). Everything here is unit tested in hud-logic.test.ts.
 * All copy is plain ASCII: the UI font is not known to carry typographic glyphs.
 */
import type { AppState, ArchivePhoto, LatLng, Mode, Pano, SavedSession } from '../contracts.js';
import { yearOf } from '../contracts.js';
import type { ViewerOffset } from '../head.js';

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
  /** The street bar (year, chips, buttons) shows in street and in portal mode. */
  showBar: boolean;
  timeButtonEnabled: boolean;
  timeButtonLabel: string;
  yearText: string;
  /** Lens is on: the year pill gets the "past" tint. */
  yearIsPast: boolean;
  /**
   * MAP and PORTAL on the street bar. Hidden in portal mode: the window carries its own
   * STEP IN and MAP buttons there, and two controls must not do one job.
   */
  showNavButtons: boolean;
  /** The HUD credit line. Hidden in the room, where the table rim carries the credit. */
  showCredits: boolean;
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
    showBar: inScene,
    timeButtonEnabled: enabled,
    timeButtonLabel: lensOn ? 'BACK TO NOW' : 'TIME MACHINE',
    yearText: shown === null ? '----' : String(shown),
    yearIsPast: lensOn && state.year !== null,
    showNavButtons: state.mode === 'street',
    showCredits: inScene,
    noEarlierImagery:
      inScene && yearsKnown && state.pano !== null && !canUseTimeMachine(state.years, true),
  };
}

// ---------------------------------------------------------------------------------------------
// Year list (the chips under the year on the street bar)
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

/** What the places panel would show, apart from its frame. */
export interface PlacesContent {
  placeCount: number;
  loading: boolean;
  /** The continue row; `resumeRow` already limits it to the room. */
  resume: ResumeRow | null;
}

/**
 * The places list shows in the room and in street, when it has something to show: a place,
 * a running lookup, or a saved street to continue.
 */
export const showPlacesPanel = (mode: Mode, { placeCount, loading, resume }: PlacesContent): boolean =>
  (mode === 'table' || mode === 'street') && (placeCount > 0 || loading || resume !== null);

export interface ResumeRow {
  name: string;
  detail: string;
}

/** Longest place name on the continue row before it is cut short. */
const RESUME_NAME_MAX = 26;

/**
 * The "continue where you left off" row at the top of the places list. Only in the room
 * (the table), and only when a street was saved. ASCII only.
 */
export function resumeRow(saved: Pick<SavedSession, 'label' | 'year'> | null, mode: Mode): ResumeRow | null {
  if (!saved || mode !== 'table') return null;
  const label = clean(saved.label);
  const place = label.length > RESUME_NAME_MAX ? `${label.slice(0, RESUME_NAME_MAX - 3)}...` : label;
  return {
    name: place ? `Continue: ${place}` : 'Continue last street',
    detail: saved.year === null ? 'NOW' : String(saved.year),
  };
}

/** The settings switches (map look, theme, lens hand) are set up before visiting a street, so the
 * panel shows at the table alone — not in street or portal. */
export const showSettingsPanel = (mode: Mode): boolean => mode === 'table';

/** Drops places with a non-finite position or no finite year, so no row can read "NaN".
 * When `centre` is given with `minOffsetM > 0`, also drops places closer than that to the
 * centre — the street panel must not list the spot the player is standing on. */
export function usablePlaces<T extends LatLng & { years: readonly number[] }>(
  places: readonly T[],
  opts: { centre?: LatLng | null; minOffsetM?: number } = {},
): T[] {
  const { centre = null, minOffsetM = 0 } = opts;
  const tooClose = (p: LatLng): boolean => {
    if (minOffsetM <= 0 || centre === null) return false;
    const dLat = (p.lat - centre.lat) * 111_320;
    const dLng = (p.lng - centre.lng) * 111_320 * Math.cos((centre.lat * Math.PI) / 180);
    return !Number.isFinite(dLat) || !Number.isFinite(dLng) || Math.hypot(dLat, dLng) < minOffsetM;
  };
  return places.filter(
    (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.years.some((y) => Number.isFinite(y)) && !tooClose(p),
  );
}

/** Whether a collapsible panel starts folded to its header in a mode. Search and settings are
 * rare; the places list stays open everywhere, so its arrows are always reachable. */
export function startsCollapsed(panel: 'places' | 'search' | 'settings', _mode: Mode): boolean {
  return panel !== 'places';
}

/** PREV and NEXT are only worth showing when there is somewhere to go. */
export const showPager = (pageCount: number): boolean => pageCount > 1;

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
  return count === 0 ? 'NO PAST IMAGERY NEARBY' : 'NEARBY STREET VIEW';
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
    // Every year on its own, first in full ("2016, 22, 25"), so a gap year is never implied.
    const yearsText = [...new Set(ys)]
      .map((y, i) => (i === 0 ? String(y) : String(y % 100).padStart(2, '0')))
      .join(', ');
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

export type HudSlot = 'bar' | 'places' | 'search' | 'settings' | 'credits' | 'status';

/**
 * Furthest any panel centre opens from straight ahead, degrees. A seated user should see
 * every panel without turning in the chair: a Quest shows about 45-49 degrees per side, and
 * a 60 cm panel 1.5 m away spans about 12 degrees either side of its centre.
 */
export const MAX_SLOT_DEG = 30;

/**
 * Where each panel opens. The centre of the view stays clear for the map table and the
 * street; the core controls (street bar) sit just below it and the lists to the sides, all
 * within `MAX_SLOT_DEG` of forward. Settings stacks above search on the right (both are
 * table-mode only and start folded). Every panel except the status toast can be dragged.
 */
export const SLOTS: Readonly<Record<HudSlot, ViewerOffset>> = {
  status: { leftDeg: 0, distance: 1.5, dy: -0.2 },
  // Year, chips and MAP / TIME MACHINE / PORTAL: below the eye line, above the floor arrows.
  bar: { leftDeg: 0, distance: 1.3, dy: -0.47 },
  credits: { leftDeg: 0, distance: 1.5, dy: -0.92 },
  // Places list: beside the table in the room (see STREET_PLACES_SLOT when a pano is live).
  places: { leftDeg: 30, distance: 1.5, dy: -0.05 },
  // Search (type or speak a place), beside the table on the right. Table mode only.
  search: { leftDeg: -30, distance: 1.5, dy: -0.12 },
  // Settings sits above search, a little above the eye line.
  settings: { leftDeg: -30, distance: 1.5, dy: 0.3 },
};

/** Street lifts the places panel to the eye line, clear of the street bar. */
export const STREET_PLACES_SLOT: ViewerOffset = { leftDeg: 30, distance: 1.5, dy: 0 };

/** Street omits places that are basically the spot the player already stands on. */
export const STREET_PLACE_MIN_OFFSET_M = 15;

/** Where a HUD slot sits in a given mode. Only `places` moves; street needs the outer spot. */
export function slotSpec(slot: HudSlot, mode: Mode): ViewerOffset {
  return slot === 'places' && mode === 'street' ? STREET_PLACES_SLOT : SLOTS[slot];
}
