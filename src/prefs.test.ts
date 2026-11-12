import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from './contracts.js';
import { DEFAULT_PREFS, PREFS_KEY, PrefsStore, baseMapFor, loadPrefs } from './prefs.js';
import { currentTheme, setTheme } from './theme.js';

const storage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

afterEach(() => setTheme('dark'));

describe('prefs', () => {
  it('defaults when nothing is saved or storage is missing', () => {
    expect(loadPrefs(storage())).toEqual(DEFAULT_PREFS);
    expect(loadPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it('reads the saved settings and ignores bad fields', () => {
    const s = storage({ [PREFS_KEY]: JSON.stringify({ satellite: false, theme: 'purple', buildings3d: true }) });
    expect(loadPrefs(s)).toEqual({ satellite: false, theme: 'dark', buildings3d: true });
    expect(loadPrefs(storage({ [PREFS_KEY]: '{not json' }))).toEqual(DEFAULT_PREFS);
  });

  it('migrates the old base-map and 3D keys', () => {
    expect(loadPrefs(storage({ 'tm-base-map': 'light', 'tm-buildings-3d': '1' }))).toEqual({
      satellite: false,
      theme: 'light',
      buildings3d: true,
    });
    expect(loadPrefs(storage({ 'tm-base-map': 'dark' }))).toEqual({ satellite: false, theme: 'dark', buildings3d: false });
  });

  it('satellite wins over the theme for the base map', () => {
    expect(baseMapFor({ satellite: true, theme: 'light' })).toBe('satellite');
    expect(baseMapFor({ satellite: false, theme: 'light' })).toBe('light');
    expect(baseMapFor({ satellite: false, theme: 'dark' })).toBe('dark');
  });

  it('store saves, applies the theme and emits once per real change', () => {
    const bus = new EventBus();
    const s = storage();
    const store = new PrefsStore(bus, s);
    const fn = vi.fn();
    bus.on('prefs:changed', fn);
    store.set({ theme: 'light' });
    store.set({ theme: 'light' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(currentTheme()).toBe('light');
    expect(JSON.parse(s.data.get(PREFS_KEY)!)).toEqual({ satellite: true, theme: 'light', buildings3d: false });
    expect(new PrefsStore(new EventBus(), s).get().theme).toBe('light');
  });
});
