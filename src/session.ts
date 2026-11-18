/**
 * "Continue where you left off". Orchestrator-owned.
 *
 * Saves the street the user stands in, its label and the lens year (when the lens is on) to
 * `localStorage`, so a later visit can jump straight back. Everything saved is read from the
 * app state, so this store must be created AFTER `createAppState` on the same bus: handlers
 * run in subscription order, and the state must already reflect each event when `persist`
 * reads it. Never throws; with storage blocked there is simply nothing to resume.
 */
import type { AppStateStore, EventBus, SavedSession, SessionAccess, SpotInfo, Unsubscribe } from './contracts.js';

export const SESSION_KEY = 'tm-last-session';
/** Older saves than this are not offered: the user has moved on. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** What is written to storage: the session plus when it was saved (for expiry only). */
interface StoredSession extends SavedSession {
  savedAt: number;
}

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read a saved session. Anything malformed or older than `SESSION_MAX_AGE_MS` reads as none. */
export function loadSession(storage: StorageLike | null, now: number): SavedSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof s.lat !== 'number' || !Number.isFinite(s.lat)) return null;
    if (typeof s.lng !== 'number' || !Number.isFinite(s.lng)) return null;
    if (typeof s.savedAt !== 'number' || now - s.savedAt > SESSION_MAX_AGE_MS) return null;
    const year = typeof s.year === 'number' && Number.isFinite(s.year) ? Math.round(s.year) : null;
    const label = typeof s.label === 'string' && s.label ? s.label : undefined;
    return { lat: s.lat, lng: s.lng, label, year };
  } catch {
    return null;
  }
}

export class SessionStore implements SessionAccess {
  private saved: SavedSession | null;
  /** The spot a running `resume` selected and the year to dial there, until its years arrive. */
  private resuming: { spot: SpotInfo; year: number } | null = null;
  private readonly offs: Unsubscribe[];

  constructor(
    private readonly bus: EventBus,
    private readonly state: AppStateStore,
    private readonly storage: StorageLike | null = browserStorage(),
    private readonly now: () => number = Date.now,
  ) {
    this.saved = loadSession(storage, now());
    this.offs = [
      bus.on('pano:shown', () => this.persist()),
      bus.on('time:toggled', () => this.persist()),
      bus.on('time:yearChanged', () => this.persist()),
      // Push-through clears the lens in the state, but the user is now in that year: keep it.
      bus.on('time:committed', ({ year }) => this.persist(year)),
      bus.on('time:yearsKnown', ({ years }) => this.finishResume(years)),
    ];
  }

  last(): Readonly<SavedSession> | null {
    return this.saved;
  }

  resume(): void {
    const s = this.saved;
    if (!s) return;
    const spot: SpotInfo = { lat: s.lat, lng: s.lng, label: s.label };
    this.resuming = s.year === null ? null : { spot, year: s.year };
    this.bus.emit('spot:selected', spot);
  }

  dispose(): void {
    this.offs.forEach((off) => off());
  }

  /**
   * Dial the saved year once the resumed street's years are known. Dropped if the user has
   * picked another spot since (the state's spot is no longer the one resume selected), or if
   * the street no longer has imagery before the saved year's successor.
   */
  private finishResume(years: readonly number[]): void {
    const r = this.resuming;
    this.resuming = null;
    if (!r || this.state.get().spot !== r.spot) return;
    if (years.length < 2 || r.year >= years[years.length - 1]!) return;
    this.bus.emit('time:toggled', { on: true });
    this.bus.emit('time:yearRequested', { year: r.year });
  }

  /** Save the street on screen; `year` defaults to the lens year when the lens is on. */
  private persist(year?: number): void {
    const { pano, spot, timeOn, year: lensYear } = this.state.get();
    if (!pano) return;
    const next: SavedSession = {
      lat: pano.lat,
      lng: pano.lng,
      label: spot?.label,
      year: year ?? (timeOn ? lensYear : null),
    };
    this.saved = next;
    try {
      const stored: StoredSession = { ...next, savedAt: this.now() };
      this.storage?.setItem(SESSION_KEY, JSON.stringify(stored));
    } catch {
      /* storage full or blocked: resume just won't be offered next time */
    }
  }
}
