import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pano } from '../contracts.js';
import {
  yearChipAction,
  yearChips,
  BusyScopes,
  SLOTS,
  ToastQueue,
  canUseTimeMachine,
  composeCredits,
  deriveHud,
  slotPosition,
  yawFromForward,
} from './hud-logic.js';
import type { HudInputs, Toast } from './hud-logic.js';

const pano = (creator: string, year = 2025): Pano =>
  ({ id: 'p', creator, capturedAt: Date.UTC(year, 5, 1) }) as Pano;

describe('composeCredits', () => {
  it('is never empty and always credits Mapillary and OpenStreetMap', () => {
    for (const text of [composeCredits(null), composeCredits(undefined, []), composeCredits(pano(''))]) {
      expect(text).toContain('Mapillary');
      expect(text).toContain('OpenStreetMap');
    }
  });

  it('adds the street imagery creator', () => {
    expect(composeCredits(pano('alice'))).toContain('Photo: alice');
  });

  it('adds archive creators with licences and dedupes', () => {
    const text = composeCredits(pano('alice'), [
      { creator: 'Bob', license: 'CC BY-SA 4.0' },
      { creator: 'bob ', license: 'cc by-sa 4.0' },
      { creator: 'Carol', license: '' },
      { creator: '', license: 'PD' },
    ]);
    expect(text).toContain('Archive: Bob (CC BY-SA 4.0), Carol, unknown (PD)');
    expect(text.match(/Bob/gu)).toHaveLength(1);
  });

  it('is plain ASCII', () => {
    expect(/^[\x20-\x7e]*$/u.test(composeCredits(pano('x'), [{ creator: 'y', license: 'z' }]))).toBe(true);
  });
});

describe('deriveHud', () => {
  const base = { mode: 'street' as const, pano: pano('a'), years: [2022, 2025], timeOn: false, year: null };

  it('shows only credits and status on the table', () => {
    const v = deriveHud({ state: { ...base, mode: 'table' }, yearsKnown: true });
    expect(v.showBar || v.showNavButtons || v.showCredits).toBe(false); // the table rim carries the credit
    expect(v.noEarlierImagery).toBe(false);
  });

  it('shows the street bar and the credit line in street and portal modes', () => {
    for (const mode of ['street', 'portal'] as const) {
      const v = deriveHud({ state: { ...base, mode }, yearsKnown: true });
      expect(v.showBar && v.showCredits).toBe(true);
    }
  });

  it('enables the button only with two or more years', () => {
    expect(deriveHud({ state: base, yearsKnown: true }).timeButtonEnabled).toBe(true);
    const one = deriveHud({ state: { ...base, years: [2025] }, yearsKnown: true });
    expect(one.timeButtonEnabled).toBe(false);
    expect(one.noEarlierImagery).toBe(true);
    expect(canUseTimeMachine([], true)).toBe(false);
    expect(canUseTimeMachine([2020, 2021], false)).toBe(false);
  });

  it('does not claim "no earlier imagery" before years are known', () => {
    const v = deriveHud({ state: { ...base, years: [] }, yearsKnown: false });
    expect(v.noEarlierImagery).toBe(false);
    expect(v.timeButtonEnabled).toBe(false);
  });

  it('shows the present year, then the dialled year when the lens is on', () => {
    expect(deriveHud({ state: base, yearsKnown: true }).yearText).toBe('2025');
    const on = deriveHud({ state: { ...base, timeOn: true, year: 2022 }, yearsKnown: true });
    expect(on.yearText).toBe('2022');
    expect(on.yearIsPast).toBe(true);
    expect(on.timeButtonLabel).toBe('BACK TO NOW');
    expect(deriveHud({ state: { ...base, pano: null }, yearsKnown: false }).yearText).toBe('----');
  });

  it('hides MAP and PORTAL in portal mode, where the window has its own buttons', () => {
    expect(deriveHud({ state: base, yearsKnown: true }).showNavButtons).toBe(true);
    expect(deriveHud({ state: { ...base, mode: 'portal' }, yearsKnown: true }).showNavButtons).toBe(false);
  });
});

describe('BusyScopes', () => {
  it('is busy while any scope is busy', () => {
    const b = new BusyScopes();
    expect(b.busy).toBe(false);
    b.set('a', true);
    b.set('b', true);
    b.set('a', true);
    expect(b.count).toBe(2);
    b.set('a', false);
    expect(b.busy).toBe(true);
    b.set('b', false);
    expect(b.busy).toBe(false);
    b.set('never-started', false);
    expect(b.count).toBe(0);
  });
});

describe('ToastQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = (): { q: ToastQueue; log: Array<Toast | null> } => {
    const log: Array<Toast | null> = [];
    return { q: new ToastQueue({ onChange: (t) => log.push(t) }), log };
  };

  it('auto-dismisses a recoverable toast after the duration', () => {
    const { q, log } = make();
    q.push('x', 'oops', true);
    expect(q.current?.message).toBe('oops');
    vi.advanceTimersByTime(ToastQueue.DEFAULT_DURATION_MS - 1);
    expect(q.current).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(q.current).toBeNull();
    expect(log.map((t) => t?.message ?? null)).toEqual(['oops', null]);
  });

  it('shows queued toasts one after another', () => {
    const { q } = make();
    q.push('x', 'one', true);
    q.push('x', 'two', true);
    expect(q.pending).toBe(1);
    vi.advanceTimersByTime(ToastQueue.DEFAULT_DURATION_MS);
    expect(q.current?.message).toBe('two');
    vi.advanceTimersByTime(ToastQueue.DEFAULT_DURATION_MS);
    expect(q.current).toBeNull();
  });

  it('ignores an identical consecutive message', () => {
    const { q } = make();
    q.push('x', 'same', true);
    q.push('y', 'same', true);
    expect(q.pending).toBe(0);
  });

  it('keeps a non-recoverable toast until cleared', () => {
    const { q } = make();
    q.push('x', 'fatal', false);
    vi.advanceTimersByTime(60_000);
    expect(q.current?.message).toBe('fatal');
    expect(q.current?.sticky).toBe(true);
    q.clear();
    expect(q.current).toBeNull();
  });

  it('caps the queue and never fires after dispose', () => {
    const { q, log } = make();
    q.push('x', 'm0', true);
    for (let i = 1; i <= 9; i++) q.push('x', `m${i}`, true);
    expect(q.pending).toBe(5);
    q.dispose();
    const before = log.length;
    vi.advanceTimersByTime(60_000);
    expect(log.length).toBe(before);
  });
});

describe('placement', () => {
  it('puts the credits line 1.5 m ahead and below the eye line', () => {
    const out = { x: 0, y: 0, z: 0 };
    slotPosition({ x: 0, y: 1.6, z: 1 }, 0, SLOTS.credits, out);
    expect(out.x).toBeCloseTo(0);
    expect(out.z).toBeCloseTo(-0.5);
    expect(out.y).toBeLessThan(1.6);
  });

  it('places the places list to the left of forward, whatever the heading', () => {
    const out = { x: 0, y: 0, z: 0 };
    slotPosition({ x: 0, y: 1.6, z: 0 }, 0, SLOTS.places, out);
    expect(out.x).toBeLessThan(0); // left of -Z is -X
    const yaw = yawFromForward(-1, 0); // facing -X
    expect(yaw).toBeCloseTo(Math.PI / 2);
    slotPosition({ x: 0, y: 1.6, z: 0 }, yaw, SLOTS.credits, out);
    expect(out.x).toBeCloseTo(-1.5);
    expect(out.z).toBeCloseTo(0);
  });
});

describe('stale lens state', () => {
  it('shows the present and the plain label when the lens is on but nothing earlier exists', () => {
    const v = deriveHud({
      state: { mode: 'street', pano: pano('a', 2025), years: [2025], timeOn: true, year: 2023 },
      yearsKnown: true,
    });
    expect(v.timeButtonLabel).toBe('TIME MACHINE');
    expect(v.yearText).toBe('2025');
    expect(v.yearIsPast).toBe(false);
  });
});

describe('year chips', () => {
  const here = pano('x', 2023);
  const base: HudInputs['state'] = { mode: 'street', pano: here, years: [2020, 2022, 2023], timeOn: false, year: null };

  it('lists only the years the source has, newest last, present marked', () => {
    const chips = yearChips({ state: base, yearsKnown: true });
    expect(chips.map((c) => c.year)).toEqual([2020, 2022, 2023]);
    expect(chips.find((c) => c.isPresent)?.year).toBe(2023);
    expect(chips.find((c) => c.selected)?.year).toBe(2023);
  });

  it('selects the lens year while the lens is on', () => {
    const chips = yearChips({ state: { ...base, timeOn: true, year: 2020 }, yearsKnown: true });
    expect(chips.find((c) => c.selected)?.year).toBe(2020);
  });

  it('is empty on the table, before years are known, or with one year', () => {
    expect(yearChips({ state: { ...base, mode: 'table' }, yearsKnown: true })).toEqual([]);
    expect(yearChips({ state: base, yearsKnown: false })).toEqual([]);
    expect(yearChips({ state: { ...base, years: [2023] }, yearsKnown: true })).toEqual([]);
  });

  it('click: present year turns the lens off, others open it if needed and go there', () => {
    const [a, , c] = yearChips({ state: base, yearsKnown: true });
    expect(yearChipAction(c, true)).toEqual({ kind: 'toggleOff' });
    expect(yearChipAction(a, false)).toEqual({ kind: 'goto', year: 2020, openLens: true });
    expect(yearChipAction(a, true)).toEqual({ kind: 'goto', year: 2020, openLens: false });
  });
});

describe('places list', () => {
  const centre = { lat: 40.758, lng: -73.9855 };
  const places = Array.from({ length: 12 }, (_, i) => ({
    lat: centre.lat + i * 0.0003,
    lng: centre.lng,
    years: i === 0 ? [2020] : [2025, 2016, 2020],
  }));

  it('pages five at a time and keeps the incoming order', async () => {
    const { placesPage } = await import('./hud-logic.js');
    const first = placesPage(places, centre, 0);
    expect(first.rows).toHaveLength(5);
    expect(first.pageText).toBe('1 / 3');
    expect(first.rows[0]).toMatchObject({ name: 'Here', yearsText: '2020', index: 0 });
    expect(first.rows[1]).toMatchObject({ name: '30m N', yearsText: '2016-2025', index: 1 });
    const last = placesPage(places, centre, 99);
    expect(last.page).toBe(2);
    expect(last.rows.map((r) => r.index)).toEqual([10, 11]);
  });

  it('handles an empty list', async () => {
    const { placesPage } = await import('./hud-logic.js');
    expect(placesPage([], null, 3)).toMatchObject({ rows: [], page: 0, pageText: '1 / 1' });
  });

  it('describes offsets in metres, kilometres and compass points', async () => {
    const { describeOffset } = await import('./hud-logic.js');
    expect(describeOffset(centre, { lat: centre.lat, lng: centre.lng + 0.002 })).toBe('170m E');
    expect(describeOffset(centre, { lat: centre.lat - 0.02, lng: centre.lng })).toBe('2.2km S');
    expect(describeOffset(centre, { lat: centre.lat + 0.0001, lng: centre.lng })).toBe('Here');
  });

  it('explains an empty list', async () => {
    const { placesTitle } = await import('./hud-logic.js');
    expect(placesTitle(10, false, 0)).toBe('ZOOM IN TO FIND PLACES');
    expect(placesTitle(15, true, 0)).toBe('LOOKING NEARBY...');
    expect(placesTitle(15, false, 0)).toBe('NO PAST IMAGERY NEARBY');
    expect(placesTitle(15, false, 3)).toBe('NEARBY, WITH PAST IMAGERY');
  });

  it('shows the list in the room and in street', async () => {
    const { showPlacesPanel } = await import('./hud-logic.js');
    expect([showPlacesPanel('table', 3), showPlacesPanel('street', 3)]).toEqual([true, true]);
    expect(showPlacesPanel('table', 0)).toBe(false);
    expect(showPlacesPanel('table', 0, true)).toBe(true);
    expect(showPlacesPanel('street', 0, true)).toBe(true);
    expect(showPlacesPanel('portal', 3)).toBe(false);
  });

  it('folds rare panels to their header, and hides the pager on a single page', async () => {
    const { startsCollapsed, showPager } = await import('./hud-logic.js');
    expect([startsCollapsed('places', 'table'), startsCollapsed('places', 'street')]).toEqual([false, true]);
    expect([startsCollapsed('search', 'table'), startsCollapsed('settings', 'street')]).toEqual([true, true]);
    expect([showPager(1), showPager(2)]).toEqual([false, true]);
  });

  it('moves the places slot out of the button band only in street', async () => {
    const { SLOTS, STREET_PLACES_SLOT, slotSpec } = await import('./hud-logic.js');
    expect(slotSpec('places', 'table')).toBe(SLOTS.places);
    expect(slotSpec('places', 'street')).toBe(STREET_PLACES_SLOT);
    expect(slotSpec('bar', 'street')).toBe(SLOTS.bar);
  });

  it('drops places that would show NaN', async () => {
    const { usablePlaces, placesPage } = await import('./hud-logic.js');
    const good = { lat: 1, lng: 2, years: [2020, 2021] };
    const kept = usablePlaces([good, { lat: NaN, lng: 2, years: [2020] }, { lat: 1, lng: 2, years: [NaN] }, { lat: 1, lng: 2, years: [] }]);
    expect(kept).toEqual([good]);
    expect(placesPage([{ lat: 1, lng: 2, years: [NaN, 2020] }], { lat: NaN, lng: 0 }, 0).rows[0]).toMatchObject({
      name: 'Nearby',
      yearsText: '2020',
    });
  });

  it('drops places closer than the minimum offset when street trimming asks for it', async () => {
    const { usablePlaces } = await import('./hud-logic.js');
    const here = { lat: 52.35, lng: 4.9, years: [2020] };
    const near = { lat: 52.3501, lng: 4.9, years: [2021] }; // about 11 m north
    const far = { lat: 52.3505, lng: 4.9, years: [2022] }; // about 55 m north
    expect(usablePlaces([here, near, far], { centre: here, minOffsetM: 15 })).toEqual([far]);
    expect(usablePlaces([here, near, far], { centre: here })).toEqual([here, near, far]);
    expect(usablePlaces([here, near, far], { centre: null, minOffsetM: 15 })).toEqual([here, near, far]);
    expect(usablePlaces([near], { centre: { lat: NaN, lng: NaN }, minOffsetM: 15 })).toEqual([]);
  });
});
