import type { TrackContext } from '../contracts.js';
import { FIXTURE_SPOT } from '../mocks/mock-source.js';

/**
 * Dev only. Replays the events other tracks would emit so the archive frames can be seen
 * without them. Enabled by DEV_DRIVER in entry.ts.
 */
export function runDevDriver({ bus }: TrackContext): void {
  const { lat, lng } = FIXTURE_SPOT;
  setTimeout(() => {
    bus.emit('spot:selected', { lat, lng });
    bus.emit('mode:changed', { mode: 'street', previous: 'table' });
    bus.emit('time:yearsKnown', { years: [2023, 2025], earliest: 2023 });
    bus.emit('time:toggled', { on: true });
    bus.emit('time:yearChanged', { year: 2010 });
  }, 2500);
}
