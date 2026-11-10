import type { TrackContext } from '../contracts.js';
import { FIXTURE_SPOT } from '../mocks/mock-source.js';

/**
 * Dev only. Replays the events other tracks would emit so the archive frames can be seen
 * without them. Enabled by DEV_DRIVER in entry.ts.
 */
export function runDevDriver({ bus, world }: TrackContext): void {
  const { lat, lng } = FIXTURE_SPOT;
  const dial = (): void => {
    bus.emit('time:toggled', { on: false });
    bus.emit('time:toggled', { on: true });
    bus.emit('time:yearChanged', { year: 2010 });
  };
  setTimeout(() => {
    bus.emit('spot:selected', { lat, lng });
    bus.emit('mode:changed', { mode: 'street', previous: 'table' });
    bus.emit('time:yearsKnown', { years: [2023, 2025], earliest: 2023 });
    dial();
  }, 2500);
  // Re-place the frames around the headset once an emulated XR session starts.
  world.renderer.xr.addEventListener('sessionstart', () => setTimeout(dial, 1500));
}
