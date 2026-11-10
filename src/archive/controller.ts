import type { ArchivePhoto, ArchiveService, EventBus, AppStateStore } from '../contracts.js';
import { placeKey } from './commons.js';

/** What the controller needs from the 3D side. */
export interface PhotoRenderer {
  /** Put the photos on screen. Resolves with the photos that actually loaded and are visible. */
  show(photos: ArchivePhoto[]): Promise<ArchivePhoto[]>;
  /** Remove them (fade out, then free textures). */
  hide(): void;
}

/**
 * Decides when the photos are visible and keeps `archive:visible` accurate.
 * Visible = mode street AND lens on AND a dialled year below the earliest Mapillary year.
 */
export function createController(deps: {
  bus: EventBus;
  state: AppStateStore;
  service: ArchiveService;
  renderer: PhotoRenderer;
}): () => void {
  const { bus, state, service, renderer } = deps;
  let visibleKey: string | null = null; // place whose photos are on screen (or loading)
  let visible: ArchivePhoto[] = [];
  let epoch = 0; // bumps on every hide/show decision so stale async work is dropped

  const place = (): { lat: number; lng: number } | null => {
    const s = state.get();
    return s.pano ?? s.spot;
  };

  const wanted = (): boolean => {
    const s = state.get();
    return s.mode === 'street' && s.timeOn && s.year !== null && s.years.length > 0 && s.year < s.years[0];
  };

  const setVisible = (photos: ArchivePhoto[]): void => {
    visible = photos;
    bus.emit('archive:visible', { photos });
  };

  const hide = (): void => {
    epoch++;
    const had = visible.length > 0 || visibleKey !== null;
    visibleKey = null;
    if (!had) return;
    renderer.hide();
    if (visible.length > 0) setVisible([]);
  };

  const prefetch = (p: { lat: number; lng: number } | null): void => {
    if (!p) return;
    service.photosNear(p.lat, p.lng).catch(() => undefined); // errors surface on the real request
  };

  const evaluate = (): void => {
    const p = place();
    if (!wanted() || !p) {
      hide();
      return;
    }
    const key = placeKey(p.lat, p.lng);
    if (visibleKey === key) return; // already showing or loading this place
    hide();
    visibleKey = key;
    const mine = epoch;
    const earliest = state.get().years[0];
    void (async () => {
      try {
        const photos = await service.photosNear(p.lat, p.lng, earliest);
        if (mine !== epoch) return;
        if (photos.length === 0) return; // nothing to show; visibleKey stays so we do not refetch
        const shown = await renderer.show(photos);
        if (mine !== epoch) {
          return; // a hide() already told the renderer to clear
        }
        setVisible(shown);
      } catch (err) {
        if (mine !== epoch) return;
        console.warn('[archive] could not load old photos', err);
        bus.emit('error', { source: 'archive', message: 'Old photos are unavailable right now.', recoverable: true });
      }
    })();
  };

  const offs = [
    bus.on('spot:selected', (spot) => prefetch(spot)),
    bus.on('pano:shown', ({ pano }) => {
      prefetch(pano);
      evaluate(); // a new place while photos are up must replace or clear them
    }),
    bus.on('time:yearsKnown', evaluate),
    bus.on('time:toggled', evaluate),
    bus.on('time:yearChanged', evaluate),
    bus.on('time:committed', evaluate),
    bus.on('mode:changed', evaluate),
  ];
  return () => {
    offs.forEach((off) => off());
    hide();
  };
}
