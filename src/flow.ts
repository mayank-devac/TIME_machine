import { config } from './config.js';
import type { LatLng, Mode, Pano, TrackContext } from './contracts.js';

/** Equirectangular distance; accurate to well under a metre at these ranges. */
function metresBetween(a: LatLng, b: LatLng): number {
  const dLat = ((a.lat - b.lat) * Math.PI) / 180;
  const dLng = ((a.lng - b.lng) * Math.PI) / 180 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot(dLat, dLng) * 6371000;
}

/**
 * Where to spawn, from panoramas already fetched (no extra request, so no waiting): the one
 * with the most capture years within the time machine's reach. `panos` is nearest first, so
 * ties keep the nearest.
 */
export function bestStart(panos: Pano[]): Pano {
  let best = panos[0]!;
  let bestYears = 0;
  for (const p of panos) {
    const years = new Set<number>();
    for (const q of panos) {
      if (metresBetween(p, q) <= config.maxYearOffsetMetres) years.add(new Date(q.capturedAt).getUTCFullYear());
    }
    if (years.size > bestYears) {
      best = p;
      bestYears = years.size;
    }
  }
  return best;
}

/**
 * Orchestrator-owned glue. The only place that turns a map pick into a street view and
 * decides mode changes. Tracks emit events; they never call each other.
 */
export function wireFlow({ bus, state, services }: TrackContext): () => void {
  const { source, stage } = services;

  const setMode = (mode: Mode): void => {
    const previous = state.get().mode;
    if (previous === mode) return;
    stage.setVisible(mode !== 'table');
    if (mode === 'table') stage.clearPast();
    bus.emit('mode:changed', { mode, previous });
  };

  const offs = [
    bus.on('mode:requested', ({ mode }) => {
      if (mode !== 'table' && !stage.currentPano) {
        bus.emit('error', { source: 'flow', message: 'Pick a place on the map first.', recoverable: true });
        return;
      }
      setMode(mode);
    }),
    bus.on('spot:selected', async (spot) => {
      bus.emit('loading', { scope: 'spot', busy: true });
      try {
        const found = await source.panosNear(spot.lat, spot.lng);
        if (!found.length) {
          bus.emit('error', { source: 'flow', message: 'No street imagery at this spot.', recoverable: true });
          return;
        }
        await stage.show(bestStart(found));
        setMode('street');
      } catch (err) {
        bus.emit('error', { source: 'flow', message: String(err), recoverable: true });
      } finally {
        bus.emit('loading', { scope: 'spot', busy: false });
      }
    }),
  ];
  return () => offs.forEach((off) => off());
}
