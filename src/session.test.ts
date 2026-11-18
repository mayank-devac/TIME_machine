import { describe, expect, it } from 'vitest';
import { EventBus, createAppState } from './contracts.js';
import type { Pano } from './contracts.js';
import { SESSION_KEY, SESSION_MAX_AGE_MS, SessionStore, loadSession } from './session.js';

const storage = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

const pano = (lat: number, lng: number, capturedAt = '2024-05-01T00:00:00Z'): Pano =>
  ({ id: `p${lat}`, lat, lng, capturedAt }) as unknown as Pano;

const NOW = 1_800_000_000_000;

describe('loadSession', () => {
  it('reads nothing from empty, broken, malformed or stale storage', () => {
    expect(loadSession(null, NOW)).toBeNull();
    expect(loadSession(storage(), NOW)).toBeNull();
    expect(loadSession(storage({ [SESSION_KEY]: '{oops' }), NOW)).toBeNull();
    expect(loadSession(storage({ [SESSION_KEY]: JSON.stringify({ lat: 'x', lng: 1, savedAt: NOW }) }), NOW)).toBeNull();
    const old = JSON.stringify({ lat: 1, lng: 2, year: null, savedAt: NOW - SESSION_MAX_AGE_MS - 1 });
    expect(loadSession(storage({ [SESSION_KEY]: old }), NOW)).toBeNull();
  });

  it('reads a good save', () => {
    const s = storage({ [SESSION_KEY]: JSON.stringify({ lat: 1, lng: 2, label: 'Main St', year: 2016, savedAt: NOW }) });
    expect(loadSession(s, NOW)).toEqual({ lat: 1, lng: 2, label: 'Main St', year: 2016, savedAt: NOW });
  });
});

describe('SessionStore', () => {
  it('saves the street on screen, and the lens year while the lens is on', () => {
    const bus = new EventBus();
    const state = createAppState(bus);
    const st = storage();
    const store = new SessionStore(bus, state, st, () => NOW);
    bus.emit('spot:selected', { lat: 10, lng: 20, label: 'Main St' });
    bus.emit('pano:shown', { pano: pano(10.0001, 20.0001) });
    expect(store.last()).toMatchObject({ lat: 10.0001, lng: 20.0001, label: 'Main St', year: null });

    bus.emit('time:toggled', { on: true });
    bus.emit('time:yearChanged', { year: 2016 });
    expect(store.last()?.year).toBe(2016);
    expect(JSON.parse(st.data.get(SESSION_KEY)!).year).toBe(2016);

    bus.emit('time:toggled', { on: false });
    expect(store.last()?.year).toBeNull();
  });

  it('a map pick without a label does not keep the previous name', () => {
    const bus = new EventBus();
    const state = createAppState(bus);
    const store = new SessionStore(bus, state, storage(), () => NOW);
    bus.emit('spot:selected', { lat: 1, lng: 1, label: 'Old Place' });
    bus.emit('pano:shown', { pano: pano(1, 1) });
    bus.emit('spot:selected', { lat: 5, lng: 5 });
    bus.emit('pano:shown', { pano: pano(5, 5) });
    expect(store.last()?.label).toBeUndefined();
  });

  it('resume selects the saved street, then dials the saved year once years are known', () => {
    const bus = new EventBus();
    const state = createAppState(bus);
    const saved = JSON.stringify({ lat: 3, lng: 4, label: 'Main St', year: 2016, savedAt: NOW });
    const store = new SessionStore(bus, state, storage({ [SESSION_KEY]: saved }), () => NOW);
    const seen: string[] = [];
    bus.on('spot:selected', (s) => seen.push(`spot ${s.lat},${s.lng}`));
    bus.on('time:toggled', ({ on }) => seen.push(`toggle ${on}`));
    bus.on('time:yearRequested', ({ year }) => seen.push(`year ${year}`));

    store.resume();
    expect(seen).toEqual(['spot 3,4']);
    bus.emit('time:yearsKnown', { years: [2014, 2016, 2024], earliest: 2014 });
    expect(seen).toEqual(['spot 3,4', 'toggle true', 'year 2016']);
    // Only once: a later street's years do not move the lens again.
    bus.emit('time:yearsKnown', { years: [2014, 2024], earliest: 2014 });
    expect(seen).toHaveLength(3);
  });

  it('resume skips the year when the street no longer has an earlier one', () => {
    const bus = new EventBus();
    const state = createAppState(bus);
    const saved = JSON.stringify({ lat: 3, lng: 4, year: 2016, savedAt: NOW });
    const store = new SessionStore(bus, state, storage({ [SESSION_KEY]: saved }), () => NOW);
    const seen: string[] = [];
    bus.on('time:toggled', () => seen.push('toggle'));
    store.resume();
    bus.emit('time:yearsKnown', { years: [2024], earliest: 2024 });
    expect(seen).toEqual([]);
  });
});
