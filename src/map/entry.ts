import type { MapTable, Track, TrackFactory } from '../contracts.js';
import { LandingPage } from './landing.js';
import { TableMap } from './table.js';

/**
 * Dev evidence switches. Both must be false when committed for integration.
 *  - DEV_TRACE logs table events (pan, pick, redraws, canvas fingerprint) with a "MAPTRACK" tag.
 *  - DEV_SCRIPT also types "Times Square" into the landing search on start.
 */
const DEV_TRACE = true;
const DEV_SCRIPT = true;

export interface MapTrack extends Track, MapTable {
  readonly table: TableMap;
}

/** Track D entry: the tabletop map and the 2D landing page. */
export const createTrack: TrackFactory = (ctx): MapTrack => {
  const { world, bus, state, services } = ctx;
  const spots = services.source.spots();
  const start = spots[0] ?? { lat: 40.758, lng: -73.9855 };
  const token = import.meta.env.VITE_MAPILLARY_TOKEN as string | undefined;

  const table = new TableMap(world, bus, start, token || undefined);
  table.setSpots(spots);

  const landing = new LandingPage(
    {
      onPreview: (p) => table.flyTo(p.lat, p.lng, 17),
      onEnter: (p) => {
        table.flyTo(p.lat, p.lng, 17);
        bus.emit('spot:selected', { lat: p.lat, lng: p.lng, label: p.label });
      },
    },
    spots,
  );

  const inXR = (): boolean => !!world.session || world.renderer.xr.isPresenting;
  const syncLanding = (): void => landing.setVisible(state.get().mode === 'table' && !inXR());

  const offMode = bus.on('mode:changed', ({ mode }) => {
    if (mode === 'table') table.show();
    else table.hide();
    syncLanding();
  });
  const xr = world.renderer.xr;
  const onSession = (): void => syncLanding();
  xr.addEventListener('sessionstart', onSession);
  xr.addEventListener('sessionend', onSession);
  if (state.get().mode === 'table') table.show();
  else table.hide();
  syncLanding();

  let timer: ReturnType<typeof setInterval> | null = null;
  const offTrace: Array<() => void> = [];
  if (import.meta.env.DEV && DEV_TRACE) {
    const tag = (): string => location.hash || 'app';
    table.onLog = (msg, data) => console.log(`MAPTRACK ${tag()} ${msg} ${JSON.stringify(data ?? null)}`);
    offTrace.push(
      bus.on('spot:selected', (s) => console.log(`MAPTRACK ${tag()} event spot:selected ${JSON.stringify(s)}`)),
      bus.on('mode:changed', (m) => console.log(`MAPTRACK ${tag()} event mode:changed ${JSON.stringify(m)}`)),
      bus.on('error', (m) => console.log(`MAPTRACK ${tag()} event error ${JSON.stringify(m)}`)),
    );
    timer = setInterval(() => {
      console.log(`MAPTRACK ${tag()} stats ${JSON.stringify({ ...table.stats(), fp: table.fingerprint() })}`);
    }, 4000);
    (window as unknown as { __map: unknown }).__map = { table, landing };
    if (DEV_SCRIPT) setTimeout(() => landing.searchNow('Times Square'), 1500);
  }

  return {
    name: 'map',
    table,
    show: () => table.show(),
    hide: () => table.hide(),
    flyTo: (lat, lng, zoom) => table.flyTo(lat, lng, zoom),
    dispose() {
      if (timer) clearInterval(timer);
      offTrace.forEach((off) => off());
      offMode();
      xr.removeEventListener('sessionstart', onSession);
      xr.removeEventListener('sessionend', onSession);
      landing.dispose();
      table.dispose();
    },
  };
};
