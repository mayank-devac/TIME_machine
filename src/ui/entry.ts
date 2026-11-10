import { RayInteractable, Vector3, Quaternion } from '@iwsdk/core';
import type { Entity, Object3D, UIKit, UIKitMLAsset } from '@iwsdk/core';
import type { ArchivePhoto, LatLng, NearbyPlace, Track, TrackFactory, Unsubscribe } from '../contracts.js';
import { HudTag } from '../track-components.js';
import { searchPlaces } from '../map/photon.js';
import type { PlaceResult } from '../map/photon.js';
import {
  KEY_IDS,
  SEARCH_RESULTS,
  SEARCH_ZOOM,
  applyKey,
  canSearch,
  cleanSpoken,
  displayText,
  resultLabel,
  showSearchPanel,
} from './search-logic.js';
import { createVoiceInput } from './voice.js';
import {
  BusyScopes,
  SLOTS,
  slotSpec,
  STREET_PLACE_MIN_OFFSET_M,
  ToastQueue,
  composeCredits,
  MAX_YEAR_CHIPS,
  deriveHud,
  yearChipAction,
  yearChips,
  slotPosition,
  yawFromForward,
  PLACES_PER_PAGE,
  placesPage,
  placesTitle,
  PLACES_MIN_ZOOM,
  showMapButton,
  showPlacesPanel,
  usablePlaces,
} from './hud-logic.js';
import type { PlacesPage } from './hud-logic.js';
import type { HudSlot, Toast } from './hud-logic.js';

const ASSET_IDS: Record<HudSlot, string> = {
  time: 'hud-time-button',
  year: 'hud-year-label',
  credits: 'hud-credits',
  status: 'hud-status',
  portal: 'hud-portal-button',
  info: 'hud-info-button',
  search: 'hud-search',
  places: 'hud-places',
  map: 'hud-map-button',
};

interface Panel {
  entity: Entity;
  asset: UIKitMLAsset;
  object: Object3D;
}

const COLORS = {
  // Translucent glass tints: 8-digit hex, last byte is alpha.
  timeOn: '#7c6cff59',
  timeBackToNow: '#ff5fb559',
  timeDisabled: '#ffffff14',
  textDisabled: '#ffffff66',
  loading: '#0f121c99',
  error: '#ff5a5a66',
  info: '#ffb84d59',
  yearNow: '#ffffff1f',
  yearPast: '#ffb84d40',
  chip: '#ffffff1f',
  chipSelected: '#7c6cff59',
  chipPresent: '#ffffff33',
} as const;

const RECENTRE_AFTER_XR_MS = 700;

export const createTrack: TrackFactory = async (ctx) => {
  const { world, bus, state } = ctx;
  const offs: Unsubscribe[] = [];
  const panels = new Map<HudSlot, Panel>();
  const busy = new BusyScopes();
  const spinnerFrames = ['Loading', 'Loading.', 'Loading..', 'Loading...'];
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let recentreTimer: ReturnType<typeof setTimeout> | null = null;
  let yearsKnown = false;
  let photos: ArchivePhoto[] = [];
  let toast: Toast | null = null;
  let disposed = false;

  // Scratch objects, allocated once.
  const head = new Vector3();
  const fwd = new Vector3();
  const headQuat = new Quaternion();
  const pos = { x: 0, y: 0, z: 0 };

  const toasts = new ToastQueue({
    onChange: (current) => {
      toast = current;
      refreshStatus();
    },
  });

  // ---------------------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------------------
  const text = (slot: HudSlot, id: string): UIKit.Text | null =>
    panels.get(slot)?.asset.getElementById<UIKit.Text>(id) ?? null;
  const box = (slot: HudSlot, id: string) => panels.get(slot)?.asset.getElementById(id) ?? null;
  const setVisible = (slot: HudSlot, visible: boolean): void => {
    const panel = panels.get(slot);
    if (panel) panel.object.visible = visible;
  };

  /** Hard snap of every panel to the head's current position and heading. Never animated. */
  const recentre = (): void => {
    if (disposed) return;
    const camera = world.camera;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(head);
    camera.getWorldQuaternion(headQuat);
    fwd.set(0, 0, -1).applyQuaternion(headQuat);
    const yaw = yawFromForward(fwd.x, fwd.z);
    const mode = state.get().mode;
    for (const [slot, panel] of panels) {
      slotPosition(head, yaw, slotSpec(slot, mode), pos);
      panel.object.position.set(pos.x, pos.y, pos.z);
      // Single-sided panels face +Z; lookAt on a non-camera points +Z at the target.
      panel.object.lookAt(head);
    }
  };

  const scheduleRecentre = (delayMs: number): void => {
    if (recentreTimer !== null) clearTimeout(recentreTimer);
    recentreTimer = setTimeout(() => {
      recentreTimer = null;
      recentre();
    }, delayMs);
  };

  const refreshCredits = (): void => {
    const el = text('credits', 'credits-text');
    el?.setProperties({ text: composeCredits(state.get().pano, photos) });
  };

  const refreshStatus = (): void => {
    const view = deriveHud({ state: state.get(), yearsKnown });
    let message: string | null = null;
    let bg: string = COLORS.loading;
    if (toast) {
      message = toast.message;
      bg = COLORS.error;
    } else if (busy.busy) {
      message = spinnerFrames[spinnerIndex];
      bg = COLORS.loading;
    } else if (view.noEarlierImagery) {
      message = 'No earlier imagery here';
      bg = COLORS.info;
    }
    setVisible('status', message !== null);
    if (message !== null) {
      text('status', 'status-text')?.setProperties({ text: message });
      box('status', 'status-root')?.setProperties({ backgroundColor: bg });
    }
  };

  let chips: ReturnType<typeof yearChips> = [];
  const refreshYearList = (): void => {
    chips = yearChips({ state: state.get(), yearsKnown });
    for (let i = 0; i < MAX_YEAR_CHIPS; i++) {
      const chip = chips[i];
      const root = box('year', `year-chip-${i}`);
      root?.setProperties({
        display: chip ? 'flex' : 'none',
        backgroundColor: !chip ? COLORS.chip : chip.selected ? COLORS.chipSelected : chip.isPresent ? COLORS.chipPresent : COLORS.chip,
      });
      if (chip) {
        text('year', `year-chip-label-${i}`)?.setProperties({
          text: String(chip.year),
          color: chip.selected ? '#ffffff' : '#ffffffcc',
        });
      }
    }
  };

  // Room panel: places near the map's current view that have past imagery. Click a row to enter.
  let places: NearbyPlace[] = [];
  let placesCentre: LatLng | null = null;
  let placesZoom: number | null = null;
  let placesLoading = false;
  let placesDotFrame = 1;
  let placesDotTimer: ReturnType<typeof setInterval> | null = null;
  let placesToken = 0;
  let placesPageIndex = 0;
  let placesView: PlacesPage = placesPage(places, null, 0);
  const refreshPlaces = (): void => {
    // Animate the "LOOKING NEARBY..." dots only while a lookup is running.
    if (placesLoading && placesDotTimer === null) {
      placesDotTimer = setInterval(() => {
        placesDotFrame = (placesDotFrame % 3) + 1;
        refreshPlaces();
      }, 400);
    } else if (!placesLoading && placesDotTimer !== null) {
      clearInterval(placesDotTimer);
      placesDotTimer = null;
      placesDotFrame = 1;
    }
    const mode = state.get().mode;
    const showPlaces = showPlacesPanel(mode, places.length, placesLoading);
    setVisible('places', showPlaces);
    setVisible('map', showMapButton(mode));
    if (!showPlaces) return;
    placesView = placesPage(places, placesCentre, placesPageIndex);
    placesPageIndex = placesView.page;
    text('places', 'places-title')?.setProperties({ text: placesTitle(placesZoom, placesLoading, places.length, placesDotFrame) });
    for (let i = 0; i < PLACES_PER_PAGE; i++) {
      const row = placesView.rows[i];
      box('places', `place-row-${i}`)?.setProperties({ display: row ? 'flex' : 'none' });
      if (row) {
        text('places', `place-name-${i}`)?.setProperties({ text: row.name });
        text('places', `place-years-${i}`)?.setProperties({ text: row.yearsText });
      }
    }
    text('places', 'places-page')?.setProperties({ text: placesView.pageText });
  };

  // Places list: rooms look around the map view; street with a live pano looks around the player.
  // Trims by the lookup kind (street sets no zoom), not the current mode, so a lookup that
  // finishes during the table→street transition still loses the spot-the-player-stands-on row.
  const streetTrim = (list: NearbyPlace[]): NearbyPlace[] => {
    const s = state.get();
    if (!s.pano || placesZoom !== null || s.mode === 'portal') return list;
    return usablePlaces(list, { centre: s.pano, minOffsetM: STREET_PLACE_MIN_OFFSET_M });
  };

  /** Look up places around a point; `zoom` is null in street (no map zoom applies). */
  const loadPlaces = async (lat: number, lng: number, zoom: number | null): Promise<void> => {
    const token = ++placesToken;
    placesCentre = { lat, lng };
    placesZoom = zoom;
    if (zoom !== null && zoom < PLACES_MIN_ZOOM) {
      places = [];
      placesLoading = false;
      placesPageIndex = 0;
      refreshPlaces();
      return;
    }
    placesLoading = true;
    refreshPlaces();
    try {
      const found = await ctx.services.source.placesNear(lat, lng, (partial) => {
        if (token !== placesToken || disposed) return;
        places = streetTrim(usablePlaces(partial));
        placesPageIndex = 0;
        refreshPlaces();
      });
      if (token !== placesToken || disposed) return;
      places = streetTrim(usablePlaces(found));
      placesPageIndex = 0;
    } catch (err) {
      if (token !== placesToken || disposed) return;
      places = [];
      bus.emit('error', { source: 'ui', message: `Could not look up places: ${String(err)}`, recoverable: true });
    }
    placesLoading = false;
    refreshPlaces();
  };

  // Room search: type on the panel keyboard or speak, ENTER looks the text up, OK flies the map there.
  const voice = createVoiceInput();
  let query = '';
  let found: PlaceResult[] = [];
  let picked = -1;
  let searchNote = 'Pick a place name, then ENTER.';
  let searchCollapsed = false;
  let searchToken = 0;
  let searchAbort: AbortController | null = null;
  const refreshSearch = (): void => {
    setVisible('search', showSearchPanel(state.get().mode));
    box('search', 'search-content')?.setProperties({ display: searchCollapsed ? 'none' : 'flex' });
    const shown = displayText(query, !voice.listening);
    text('search', 'search-text')?.setProperties({
      text: voice.listening && query.length === 0 ? 'Listening…' : shown.text,
      color: shown.placeholder && !voice.listening ? '#ffffff80' : '#ffffff',
    });
    text('search', 'search-status')?.setProperties({ text: searchNote });
    box('search', 'search-mic-icon')?.setProperties({ display: voice.listening ? 'none' : 'flex' });
    box('search', 'search-mic-stop')?.setProperties({ display: voice.listening ? 'flex' : 'none' });
    box('search', 'search-mic')?.setProperties({
      backgroundColor: !voice.supported ? COLORS.timeDisabled : voice.listening ? COLORS.timeBackToNow : COLORS.timeOn,
    });
    box('search', 'search-enter')?.setProperties({
      backgroundColor: canSearch(query) ? COLORS.timeOn : COLORS.timeDisabled,
    });
    box('search', 'search-use')?.setProperties({
      backgroundColor: picked >= 0 ? '#2ee6d659' : COLORS.timeDisabled,
    });
    for (let i = 0; i < SEARCH_RESULTS; i++) {
      const r = found[i];
      box('search', `search-row-${i}`)?.setProperties({
        display: r ? 'flex' : 'none',
        backgroundColor: i === picked ? COLORS.chipSelected : COLORS.chip,
      });
      if (r) text('search', `search-row-label-${i}`)?.setProperties({ text: resultLabel(r.label) });
    }
  };
  const runSearch = async (): Promise<void> => {
    if (!canSearch(query)) {
      searchNote = 'Type at least 3 letters.';
      refreshSearch();
      return;
    }
    const mine = ++searchToken;
    searchAbort?.abort();
    searchAbort = new AbortController();
    searchNote = 'Searching…';
    refreshSearch();
    try {
      const list = await searchPlaces(query, { signal: searchAbort.signal, limit: SEARCH_RESULTS });
      if (mine !== searchToken || disposed) return;
      found = list;
      picked = list.length > 0 ? 0 : -1;
      searchNote = list.length > 0 ? 'Tap a result, then OK.' : `No places found for "${query}".`;
    } catch (err) {
      if (mine !== searchToken || disposed || (err as { name?: string }).name === 'AbortError') return;
      found = [];
      picked = -1;
      searchNote = 'Search failed. Check the connection.';
    }
    refreshSearch();
  };
  const clearSearch = (): void => {
    voice.stop();
    searchToken++;
    searchAbort?.abort();
    query = '';
    found = [];
    picked = -1;
    searchNote = 'Pick a place name, then ENTER.';
    refreshSearch();
  };
  const toggleSearchVisibility = (): void => {
    searchCollapsed = !searchCollapsed;
    refreshSearch();
  };
  const useResult = (): void => {
    const r = found[picked];
    if (!r) {
      searchNote = 'Search, then tap a result.';
      refreshSearch();
      return;
    }
    bus.emit('map:flyRequested', { lat: r.lat, lng: r.lng, zoom: SEARCH_ZOOM, label: r.label });
    searchNote = `Showing ${resultLabel(r.label).split(',')[0]} on the table.`;
    refreshSearch();
  };
  const toggleMic = (): void => {
    if (!voice.supported) {
      searchNote = 'Speech is not available here. Use the keys.';
      refreshSearch();
      return;
    }
    if (voice.listening) {
      voice.stop();
      return;
    }
    searchNote = 'Speak now…';
    voice.start({
      onText: (heard, final) => {
        query = cleanSpoken(heard);
        refreshSearch();
        if (final) void runSearch();
      },
      onEnd: (error) => {
        if (error) searchNote = error;
        refreshSearch();
      },
    });
    refreshSearch();
  };

  const refreshHud = (): void => {
    refreshPlaces();
    refreshSearch();
    const view = deriveHud({ state: state.get(), yearsKnown });
    setVisible('time', view.showTimeButton);
    setVisible('year', view.showYear);
    setVisible('portal', view.showPortalButton);
    text('time', 'time-btn-label')?.setProperties({
      text: view.timeButtonLabel,
      color: view.timeButtonEnabled ? '#ffffff' : COLORS.textDisabled,
    });
    box('time', 'time-btn')?.setProperties({
      backgroundColor: !view.timeButtonEnabled
        ? COLORS.timeDisabled
        : view.timeButtonLabel === 'BACK TO NOW'
          ? COLORS.timeBackToNow
          : COLORS.timeOn,
    });
    text('year', 'year-text')?.setProperties({ text: view.yearText });
    box('year', 'year-root')?.setProperties({
      backgroundColor: view.yearIsPast ? COLORS.yearPast : COLORS.yearNow,
    });
    text('portal', 'portal-btn-label')?.setProperties({ text: view.portalButtonLabel });
    refreshYearList();
    refreshStatus();
  };

  const updateSpinner = (): void => {
    if (busy.busy && spinnerTimer === null) {
      spinnerTimer = setInterval(() => {
        spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        refreshStatus();
      }, 350);
    } else if (!busy.busy && spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      spinnerIndex = 0;
    }
  };

  // ---------------------------------------------------------------------------------------
  // Create the HUD panels (persistent app content, not level content)
  // ---------------------------------------------------------------------------------------
  for (const slot of Object.keys(ASSET_IDS) as HudSlot[]) {
    const asset = await world.assets.instantiate<UIKitMLAsset>(ASSET_IDS[slot]);
    asset.name = `hud-${slot}`;
    const entity = world.createTransformEntity(asset, { persistent: true });
    entity.addComponent(HudTag, { slot });
    if (['time', 'portal', 'info', 'year', 'places', 'map', 'search'].includes(slot)) entity.addComponent(RayInteractable);
    asset.visible = slot === 'info';
    panels.set(slot, { entity, asset, object: asset });
  }

  // Controls: UIKit elements receive pointer clicks from both XR rays and desktop canvas events.
  const onTimeClick = (): void => {
    const view = deriveHud({ state: state.get(), yearsKnown });
    if (!view.timeButtonEnabled) return;
    bus.emit('time:toggled', { on: !state.get().timeOn });
  };
  const onPortalClick = (): void => {
    bus.emit('mode:requested', { mode: deriveHud({ state: state.get(), yearsKnown }).portalTarget });
  };
  const onChipClick = (i: number): void => {
    const chip = chips[i];
    if (!chip) return;
    const action = yearChipAction(chip, state.get().timeOn);
    if (action.kind === 'toggleOff') {
      if (state.get().timeOn) bus.emit('time:toggled', { on: false });
      return;
    }
    if (action.openLens) bus.emit('time:toggled', { on: true });
    bus.emit('time:yearRequested', { year: action.year });
  };
  for (let i = 0; i < MAX_YEAR_CHIPS; i++) {
    const el = box('year', `year-chip-${i}`);
    const handler = (): void => onChipClick(i);
    el?.addEventListener('click', handler);
    offs.push(() => el?.removeEventListener('click', handler));
  }
  const listen = (el: ReturnType<typeof box>, handler: () => void): void => {
    el?.addEventListener('click', handler);
    offs.push(() => el?.removeEventListener('click', handler));
  };
  for (let i = 0; i < PLACES_PER_PAGE; i++) {
    listen(box('places', `place-row-${i}`), () => {
      const row = placesView.rows[i];
      const place = row ? places[row.index] : undefined;
      if (place) bus.emit('spot:selected', { lat: place.lat, lng: place.lng, label: row?.name });
    });
  }
  const turnPage = (delta: number): void => {
    placesPageIndex = (placesView.page + delta + placesView.pageCount) % placesView.pageCount;
    refreshPlaces();
  };
  listen(box('places', 'places-prev'), () => turnPage(-1));
  listen(box('places', 'places-next'), () => turnPage(1));
  for (const key of [...KEY_IDS, 'SPACE']) {
    const id = key === 'SPACE' ? 'search-space' : `search-key-${key}`;
    listen(box('search', id), () => {
      query = applyKey(query, key);
      refreshSearch();
    });
  }
  for (let i = 0; i < SEARCH_RESULTS; i++) {
    listen(box('search', `search-row-${i}`), () => {
      if (!found[i]) return;
      picked = i;
      refreshSearch();
    });
  }
  listen(box('search', 'search-enter'), () => void runSearch());
  listen(box('search', 'search-clear'), clearSearch);
  listen(box('search', 'search-use'), useResult);
  listen(box('search', 'search-visibility'), toggleSearchVisibility);
  listen(box('search', 'search-mic'), toggleMic);
  listen(box('map', 'map-btn'), () => bus.emit('mode:requested', { mode: 'table' }));
  const timeBtn = box('time', 'time-btn');
  const portalBtn = box('portal', 'portal-btn');
  timeBtn?.addEventListener('click', onTimeClick);
  portalBtn?.addEventListener('click', onPortalClick);
  const onInfoClick = (): void => {
    const panel = panels.get('credits');
    if (!panel) return;
    panel.object.visible = !panel.object.visible;
    refreshCredits();
  };
  const infoBtn = box('info', 'info-btn');
  infoBtn?.addEventListener('click', onInfoClick);
  offs.push(
    () => timeBtn?.removeEventListener('click', onTimeClick),
    () => portalBtn?.removeEventListener('click', onPortalClick),
    () => infoBtn?.removeEventListener('click', onInfoClick),
  );

  // ---------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------
  offs.push(
    bus.on('map:viewChanged', ({ lat, lng, zoom }) => void loadPlaces(lat, lng, zoom)),
    bus.on('spot:selected', () => {
      yearsKnown = false;
      photos = [];
      toasts.clear();
      refreshCredits();
      refreshHud();
    }),
    bus.on('pano:shown', () => {
      refreshCredits();
      refreshHud();
      // In street, the panel follows the player's spot; a same-spot time hop keeps the list.
      const s = state.get();
      if (s.mode !== 'street' || !s.pano) return;
      const c = placesCentre;
      const moved = !c || Math.abs(c.lat - s.pano.lat) > 0.0001 || Math.abs(c.lng - s.pano.lng) > 0.0001;
      if (!moved) return;
      places = [];
      placesPageIndex = 0;
      placesZoom = null;
      void loadPlaces(s.pano.lat, s.pano.lng, null);
    }),
    bus.on('time:yearsKnown', () => {
      yearsKnown = true;
      refreshHud();
    }),
    bus.on('time:toggled', refreshHud),
    bus.on('time:yearChanged', refreshHud),
    bus.on('time:committed', () => {
      refreshCredits();
      refreshHud();
    }),
    bus.on('archive:visible', ({ photos: visible }) => {
      photos = visible;
      refreshCredits();
    }),
    bus.on('mode:changed', () => {
      refreshHud();
      recentre();
    }),
    bus.on('loading', ({ scope, busy: isBusy }) => {
      busy.set(scope, isBusy);
      updateSpinner();
      refreshStatus();
    }),
    bus.on('error', ({ source, message, recoverable }) => {
      console.warn(`[ui] error from ${source}: ${message}`);
      toasts.push(source, message, recoverable);
    }),
  );

  // Recentre when an immersive session starts (the head moves to a new origin) and on KeyC
  // (a deliberate desktop recentre). Both are hard snaps.
  const xr = world.renderer.xr;
  const onSessionStart = (): void => scheduleRecentre(RECENTRE_AFTER_XR_MS);
  xr.addEventListener('sessionstart', onSessionStart);
  offs.push(() => xr.removeEventListener('sessionstart', onSessionStart));
  const onKey = (event: KeyboardEvent): void => {
    if (event.code === 'KeyC' && !event.repeat && !event.ctrlKey && !event.metaKey) recentre();
  };
  window.addEventListener('keydown', onKey);
  offs.push(() => window.removeEventListener('keydown', onKey));

  refreshCredits();
  refreshHud();
  recentre();
  scheduleRecentre(300); // the camera pose is only trustworthy after the first frame

  const track: Track & { recentre: () => void } = {
    name: 'ui',
    recentre,
    dispose() {
      disposed = true;
      voice.stop();
      searchAbort?.abort();
      offs.forEach((off) => off());
      toasts.dispose();
      if (spinnerTimer !== null) clearInterval(spinnerTimer);
      if (placesDotTimer !== null) clearInterval(placesDotTimer);
      if (recentreTimer !== null) clearTimeout(recentreTimer);
      for (const { entity, asset } of panels.values()) {
        asset.dispose();
        entity.dispose();
      }
      panels.clear();
    },
  };
  return track;
};
