/**
 * "Continue where you left off". Orchestrator-owned.
 * Saves the street the user is standing in (and the lens year, when the lens is on) to
 * `localStorage`, so a later visit can jump straight back. Never throws; with storage blocked
 * the app simply has nothing to resume.
 */
import type { AppStateStore, EventBus, SavedSession, SessionAccess, Unsubscribe } from './contracts.js';

export const SESSION_KEY = 'tm-last-session';
/** Older saves than this are not offered: the user has moved on. */
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Read a saved session. Anything malformed or too old reads as none. */
export function loadSession(storage: StorageLike | null, now = Date.now()): SavedSession | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<SavedSession>;
    if (typeof s.lat !== 'number' || !Number.isFinite(s.lat)) return null;
    if (typeof s.lng !== 'number' || !Number.isFinite(s.lng)) return null;
    if (typeof s.savedAt !== 'number' || now - s.savedAt > SESSION_MAX_AGE_MS) return null;
    const year = typeof s.year === 'number' && Number.isFinite(s.year) ? Math.round(s.year) : null;
    const label = typeof s.label === 'string' && s.label ? s.label : undefined;
    return { lat: s.lat, lng: s.lng, label, year, savedAt: s.savedAt };
  } catch {
    return null;
  }
}

export class SessionStore implements SessionAccess {
  private saved: SavedSession | null;
  private label: string | undefined;
  private pendingYear: Unsubscribe | null = null;
  private readonly offs: Unsubscribe[];

  constructor(
    private readonly bus: EventBus,
    private readonly state: AppStateStore,
    private readonly storage: StorageLike | null = browserStorage(),
    private readonly now: () => number = Date.now,
  ) {
    this.saved = loadSession(storage, now());
    this.offs = [
      bus.on('spot:selected', (spot) => {
        this.label = spot.label;
      }),
      // A panorama on screen is the street the user is in: save its exact spot.
      bus.on('pano:shown', ({ pano }) => this.save(pano.lat, pano.lng, this.yearNow())),
      bus.on('time:toggled', () => this.saveYear()),
      bus.on('time:yearChanged', ({ year }) => this.saveYear(year)),
      bus.on('time:committed', ({ year, pano }) => this.save(pano.lat, pano.lng, year)),
    ];
  }

  last(): Readonly<SavedSession> | null {
    return this.saved;
  }

  resume(): void {
    const s = this.saved;
    if (!s) return;
    this.pendingYear?.();
    this.pendingYear = null;
    if (s.year !== null) {
      const year = s.year;
      // The lens can only jump once the new street's years are known.
      this.pendingYear = this.bus.once('time:yearsKnown', ({ years }) => {
        this.pendingYear = null;
        if (years.length < 2 || year >= Math.max(...years)) return;
        this.bus.emit('time:toggled', { on: true });
        this.bus.emit('time:yearRequested', { year });
      });
    }
    this.bus.emit('spot:selected', { lat: s.lat, lng: s.lng, label: s.label });
  }

  dispose(): void {
    this.pendingYear?.();
    this.offs.forEach((off) => off());
  }

  private yearNow(): number | null {
    const st = this.state.get();
    return st.timeOn ? st.year : null;
  }

  private saveYear(year: number | null = this.yearNow()): void {
    if (!this.saved || !this.state.get().pano) return;
    this.save(this.saved.lat, this.saved.lng, this.state.get().timeOn ? year : null);
  }

  private save(lat: number, lng: number, year: number | null): void {
    const next: SavedSession = { lat, lng, label: this.label, year, savedAt: this.now() };
    this.saved = next;
    try {
      this.storage?.setItem(SESSION_KEY, JSON.stringify(next));
    } catch {
      /* storage full or blocked: resume just won't be offered next time */
    }
  }
}
