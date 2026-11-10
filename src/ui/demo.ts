import type { Mode, TrackContext } from '../contracts.js';
import { FIXTURE_PANOS, FIXTURE_SPOT } from '../mocks/mock-source.js';

/**
 * DEV-only screenshot driver, imported only when DEMO is true in entry.ts (delete before
 * finishing). Keys 1-9 and 0 put the HUD in each state; the same steps hang off window.__hudDemo.
 */
export function runDemo({ bus, state }: TrackContext): void {
  const pano = FIXTURE_PANOS[1];
  const years = FIXTURE_SPOT.years;
  const setMode = (mode: Mode): void => {
    bus.emit('mode:changed', { mode, previous: state.get().mode });
  };
  bus.on('time:toggled', (p) => console.log('[hud-evidence] time:toggled', JSON.stringify(p)));
  bus.on('mode:requested', (p) => console.log('[hud-evidence] mode:requested', JSON.stringify(p)));
  let loadingOn = false;
  const steps: Record<string, () => void> = {
    '1': () => setMode('table'),
    '2': () => {
      bus.emit('spot:selected', FIXTURE_SPOT);
      setMode('street');
      bus.emit('pano:shown', { pano });
      bus.emit('time:yearsKnown', { years, earliest: years[0] });
    },
    '3': () => {
      bus.emit('time:toggled', { on: true });
      bus.emit('time:yearChanged', { year: years[0] });
    },
    '4': () => {
      bus.emit('spot:selected', FIXTURE_SPOT);
      setMode('street');
      bus.emit('pano:shown', { pano });
      bus.emit('time:yearsKnown', { years: [years[1]], earliest: years[1] });
    },
    '5': () => setMode('portal'),
    '6': () => bus.emit('error', { source: 'demo', message: 'Could not load that panorama. Try again.', recoverable: true }),
    '7': () => {
      loadingOn = !loadingOn;
      bus.emit('loading', { scope: 'demo', busy: loadingOn });
    },
    '8': () =>
      bus.emit('archive:visible', {
        photos: [
          { creator: 'Jane Doe', license: 'CC BY-SA 4.0' },
          { creator: 'NYC Municipal Archives', license: 'Public domain' },
        ] as never,
      }),
    '9': () => bus.emit('error', { source: 'demo', message: 'Mapillary is unreachable. Check the token.', recoverable: false }),
  };
  (window as unknown as { __hudDemo: unknown }).__hudDemo = steps;
  window.addEventListener('keydown', (e) => steps[e.key]?.());
}
