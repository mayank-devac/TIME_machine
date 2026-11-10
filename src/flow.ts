import type { Mode, TrackContext } from './contracts.js';

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
        const [nearest] = await source.panosNear(spot.lat, spot.lng);
        if (!nearest) {
          bus.emit('error', { source: 'flow', message: 'No street imagery at this spot.', recoverable: true });
          return;
        }
        await stage.show(nearest);
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
