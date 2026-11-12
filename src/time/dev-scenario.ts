/**
 * DEV-only driver, so Track C can be exercised alone (no map, no TIME MACHINE button yet).
 * Leave `DEV_SCENARIO` as '' when committing.
 *
 *  'fixture'       open the fixture spot (Times Square 2025), then switch TIME MACHINE on.
 *  'fixture-keys'  the same, and also: press T to toggle TIME MACHINE.
 *
 * The managed browser cannot open a URL with a query string, hence a constant.
 */
import type { TrackContext } from '../contracts.js';

export const DEV_SCENARIO: '' | 'fixture' | 'fixture-keys' = 'fixture';

export async function runDevScenario({ bus, state, services }: TrackContext): Promise<() => void> {
  const scenario: string = DEV_SCENARIO;
  if (!scenario) return () => {};
  const { FIXTURE_SPOT } = await import('../mocks/mock-source.js');
  const offs: Array<() => void> = [];

  // Open the lens once the years for the first panorama are known.
  offs.push(
    bus.once('time:yearsKnown', ({ years }) => {
      console.info(`[time-dev] years known: ${years.join(', ')}`);
      bus.emit('time:toggled', { on: true });
    }),
    bus.on('time:yearChanged', ({ year }) => console.info(`[time-dev] time:yearChanged ${year}`)),
    bus.on('time:committed', ({ year, pano }) =>
      console.info(
        `[time-dev] time:committed ${year} pano=${pano.id} textures=${services.stage.textureCount()} current=${services.stage.currentPano?.id}`,
      ),
    ),
  );
  bus.emit('spot:selected', { lat: FIXTURE_SPOT.lat, lng: FIXTURE_SPOT.lng, label: FIXTURE_SPOT.name });

  if (scenario === 'fixture-keys') {
    const onKey = (e: KeyboardEvent): void => {
      if (e.code === 'KeyT') bus.emit('time:toggled', { on: !state.get().timeOn });
    };
    window.addEventListener('keydown', onKey);
    offs.push(() => window.removeEventListener('keydown', onKey));
  }
  return () => offs.forEach((off) => off());
}
