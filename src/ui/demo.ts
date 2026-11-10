import type { TrackContext } from '../contracts.js';
import { FIXTURE_PANOS, FIXTURE_SPOT } from '../mocks/mock-source.js';

/** DEV-only helper, imported only when DEMO is true in entry.ts. Drives HUD states. */
export function runDemo({ bus }: TrackContext): void {
  const pano = FIXTURE_PANOS[1];
  const years = FIXTURE_SPOT.years;
  (window as unknown as { __hudDemo: unknown }).__hudDemo = {
    street(): void {
      bus.emit('spot:selected', FIXTURE_SPOT);
      bus.emit('mode:changed', { mode: 'street', previous: 'table' });
      bus.emit('pano:shown', { pano });
      bus.emit('time:yearsKnown', { years, earliest: years[0] });
    },
  };
}
