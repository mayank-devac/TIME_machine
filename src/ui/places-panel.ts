/**
 * The places panel: spots with past imagery near the map's view (in the room) or near the
 * panorama the player stands in (in a street). Click a row to go there. In a street it is
 * folded to its header until the player opens it.
 */
import type { LatLng, Mode, NearbyPlace } from '../contracts.js';
import {
  PLACES_MIN_ZOOM,
  PLACES_PER_PAGE,
  STREET_PLACE_MIN_OFFSET_M,
  placesPage,
  placesTitle,
  showPager,
  showPlacesPanel,
  startsCollapsed,
  usablePlaces,
} from './hud-logic.js';
import type { PlacesPage } from './hud-logic.js';
import type { Host, PanelModule } from './host.js';
import { paintBox, paintButton, paintText } from './panel-style.js';

export interface PlacesPanel extends PanelModule {
  /** Look up places around a point; `zoom` is null in a street (no map zoom applies). */
  load(lat: number, lng: number, zoom: number | null): Promise<void>;
  /** A panorama came on screen: in a street, follow the player to the new spot. */
  followPano(): void;
}

export function createPlacesPanel(host: Host): PlacesPanel {
  const { bus, state, services } = host.ctx;
  let places: NearbyPlace[] = [];
  let centre: LatLng | null = null;
  let zoom: number | null = null;
  let loading = false;
  let dotFrame = 1;
  let dotTimer: ReturnType<typeof setInterval> | null = null;
  let token = 0;
  let pageIndex = 0;
  let view: PlacesPage = placesPage(places, null, 0);
  // Folded or open is remembered per mode: open beside the table, folded in a street.
  const folded: Record<Mode, boolean> = {
    table: startsCollapsed('places', 'table'),
    street: startsCollapsed('places', 'street'),
    portal: startsCollapsed('places', 'portal'),
  };
  let shape = '';

  const refresh = (): void => {
    // Animate the "LOOKING NEARBY..." dots only while a lookup is running.
    if (loading && dotTimer === null) {
      dotTimer = setInterval(() => {
        dotFrame = (dotFrame % 3) + 1;
        refresh();
      }, 400);
    } else if (!loading && dotTimer !== null) {
      clearInterval(dotTimer);
      dotTimer = null;
      dotFrame = 1;
    }
    const mode = state.get().mode;
    const show = showPlacesPanel(mode, places.length, loading);
    host.setVisible('places', show);
    if (!show) return;

    const isFolded = folded[mode];
    view = placesPage(places, centre, pageIndex);
    pageIndex = view.page;

    paintBox(host.el('places', 'places-root'), 'panel');
    const title = host.text('places', 'places-title');
    title?.setProperties({ text: placesTitle(zoom, loading, places.length, dotFrame) });
    paintText(title, 'secondary');
    const foldLabel = host.text('places', 'places-fold-label');
    foldLabel?.setProperties({ text: isFolded ? '+' : '-' });
    paintButton(host.el('places', 'places-fold'), foldLabel, 'control');
    host.el('places', 'places-content')?.setProperties({ display: isFolded ? 'none' : 'flex' });

    for (let i = 0; i < PLACES_PER_PAGE; i++) {
      const row = view.rows[i];
      const box = host.el('places', `place-row-${i}`);
      box?.setProperties({ display: row ? 'flex' : 'none' });
      if (!row) continue;
      const name = host.text('places', `place-name-${i}`);
      const years = host.text('places', `place-years-${i}`);
      name?.setProperties({ text: row.name });
      years?.setProperties({ text: row.yearsText });
      paintBox(box, 'control');
      paintText(name, 'primary');
      paintText(years, 'past');
    }

    const pager = showPager(view.pageCount);
    host.el('places', 'places-pager')?.setProperties({ display: pager ? 'flex' : 'none' });
    const page = host.text('places', 'places-page');
    page?.setProperties({ text: view.pageText });
    paintText(page, 'secondary');
    paintButton(host.el('places', 'places-prev'), host.text('places', 'places-prev-label'), 'control');
    paintButton(host.el('places', 'places-next'), host.text('places', 'places-next-label'), 'control');

    // The grip sits above the panel, so it has to move whenever the panel's height changes.
    const next = `${isFolded}|${view.rows.length}|${pager}`;
    if (next !== shape) {
      shape = next;
      host.resized('places');
    }
  };

  // Rooms look around the map view; a street with a live pano looks around the player. Trims by
  // the lookup kind (a street lookup sets no zoom), not the current mode, so a lookup that
  // finishes during the table-to-street transition still loses the row the player stands on.
  const streetTrim = (list: NearbyPlace[]): NearbyPlace[] => {
    const s = state.get();
    if (!s.pano || zoom !== null || s.mode === 'portal') return list;
    return usablePlaces(list, { centre: s.pano, minOffsetM: STREET_PLACE_MIN_OFFSET_M });
  };

  const load = async (lat: number, lng: number, z: number | null): Promise<void> => {
    const mine = ++token;
    centre = { lat, lng };
    zoom = z;
    if (z !== null && z < PLACES_MIN_ZOOM) {
      places = [];
      loading = false;
      pageIndex = 0;
      refresh();
      return;
    }
    loading = true;
    refresh();
    try {
      const found = await services.source.placesNear(lat, lng, (partial) => {
        if (mine !== token || host.disposed) return;
        places = streetTrim(usablePlaces(partial));
        pageIndex = 0;
        refresh();
      });
      if (mine !== token || host.disposed) return;
      places = streetTrim(usablePlaces(found));
      pageIndex = 0;
    } catch (err) {
      if (mine !== token || host.disposed) return;
      places = [];
      bus.emit('error', { source: 'ui', message: `Could not look up places: ${String(err)}`, recoverable: true });
    }
    loading = false;
    refresh();
  };

  const followPano = (): void => {
    const s = state.get();
    if (s.mode !== 'street' || !s.pano) return;
    // A time hop at the same spot keeps the list.
    const moved = !centre || Math.abs(centre.lat - s.pano.lat) > 0.0001 || Math.abs(centre.lng - s.pano.lng) > 0.0001;
    if (!moved) return;
    places = [];
    pageIndex = 0;
    void load(s.pano.lat, s.pano.lng, null);
  };

  for (let i = 0; i < PLACES_PER_PAGE; i++) {
    host.control(host.el('places', `place-row-${i}`), 'row', () => {
      const row = view.rows[i];
      const place = row ? places[row.index] : undefined;
      if (place) bus.emit('spot:selected', { lat: place.lat, lng: place.lng, label: row?.name });
    });
  }
  const turnPage = (delta: number): void => {
    pageIndex = (view.page + delta + view.pageCount) % view.pageCount;
    refresh();
  };
  host.control(host.el('places', 'places-prev'), 'default', () => turnPage(-1));
  host.control(host.el('places', 'places-next'), 'default', () => turnPage(1));
  host.control(host.el('places', 'places-fold'), 'default', () => {
    const mode = state.get().mode;
    folded[mode] = !folded[mode];
    refresh();
  });

  return {
    refresh,
    load,
    followPano,
    dispose() {
      token++;
      if (dotTimer !== null) clearInterval(dotTimer);
    },
  };
}
