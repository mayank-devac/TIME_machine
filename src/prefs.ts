/**
 * User settings (the three switches on the settings panel). Orchestrator-owned.
 * Saved in `localStorage`, announced on the bus as `prefs:changed`, and the theme switch is
 * applied to `theme.ts` here so no track has to remember to do it.
 */
import type { EventBus, Prefs } from './contracts.js';
import { setTheme } from './theme.js';

export const PREFS_KEY = 'tm-prefs';
/** Keys written by earlier versions; read once so a returning user keeps their choice. */
const LEGACY_BASE_MAP_KEY = 'tm-base-map';
const LEGACY_3D_KEY = 'tm-buildings-3d';

export const DEFAULT_PREFS: Readonly<Prefs> = { satellite: true, theme: 'dark', buildings3d: false };

export type BaseMapKind = 'satellite' | 'dark' | 'light';

/** Which base map the table shows: satellite when on, else the map that matches the theme. */
export function baseMapFor(prefs: Pick<Prefs, 'satellite' | 'theme'>): BaseMapKind {
  return prefs.satellite ? 'satellite' : prefs.theme;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage can be blocked outright
  }
}

/** Read saved settings. Never throws; anything unreadable falls back to the defaults. */
export function loadPrefs(storage: StorageLike | null = browserStorage()): Prefs {
  const prefs: Prefs = { ...DEFAULT_PREFS };
  if (!storage) return prefs;
  try {
    const saved = storage.getItem(PREFS_KEY);
    if (saved) {
      const p = JSON.parse(saved) as Partial<Prefs>;
      if (typeof p.satellite === 'boolean') prefs.satellite = p.satellite;
      if (p.theme === 'dark' || p.theme === 'light') prefs.theme = p.theme;
      if (typeof p.buildings3d === 'boolean') prefs.buildings3d = p.buildings3d;
      return prefs;
    }
    const kind = storage.getItem(LEGACY_BASE_MAP_KEY);
    if (kind === 'satellite' || kind === 'dark' || kind === 'light') {
      prefs.satellite = kind === 'satellite';
      if (kind === 'light') prefs.theme = 'light';
    }
    if (storage.getItem(LEGACY_3D_KEY) === '1') prefs.buildings3d = true;
  } catch {
    /* corrupt or unavailable: keep the defaults */
  }
  return prefs;
}

export class PrefsStore {
  private prefs: Prefs;

  constructor(
    private readonly bus: EventBus,
    private readonly storage: StorageLike | null = browserStorage(),
  ) {
    this.prefs = loadPrefs(storage);
    setTheme(this.prefs.theme);
  }

  get(): Readonly<Prefs> {
    return this.prefs;
  }

  /** Change one or more settings. Saves, applies the theme, then emits `prefs:changed`. */
  set(patch: Partial<Prefs>): void {
    const next: Prefs = { ...this.prefs, ...patch };
    if (
      next.satellite === this.prefs.satellite &&
      next.theme === this.prefs.theme &&
      next.buildings3d === this.prefs.buildings3d
    ) {
      return;
    }
    this.prefs = next;
    try {
      this.storage?.setItem(PREFS_KEY, JSON.stringify(next));
    } catch {
      /* storage may be full or blocked; the setting still applies for this visit */
    }
    setTheme(next.theme);
    this.bus.emit('prefs:changed', next);
  }
}
