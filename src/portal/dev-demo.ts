import type { TrackContext } from '../contracts.js';
import { FIXTURE_SPOT } from '../mocks/mock-source.js';
import type { PortalFlow } from './portal-flow.js';

/**
 * DEV ONLY. When true, the portal track drives itself on load: pick the fixture spot, wait
 * for street mode, then request portal mode. Used to take emulator evidence without editing
 * `src/index.ts`. Must be false when committed for integration.
 */
export const PORTAL_DEV_DEMO: boolean = false;
const DEMO_REOPEN_MS = 20000;

export function runDevDemo({ bus, state, services }: TrackContext, flow: PortalFlow): void {
  const off = bus.on('mode:changed', ({ mode, previous }) => {
    console.log(`[portal-demo] mode ${previous} -> ${mode} stage.stencilRef=${services.stage.stencilRef}`);
    if (mode === 'street' && previous === 'table' && !flow.requests) {
      flow.requestPortal();
    }
    // After stepping through, reopen the portal a few seconds later so the exit path
    // (BACK TO ROOM) can be exercised in the same session.
    if (mode === 'street' && previous === 'portal') {
      setTimeout(() => flow.requestPortal(), DEMO_REOPEN_MS);
    }
  });
  bus.emit('spot:selected', { lat: FIXTURE_SPOT.lat, lng: FIXTURE_SPOT.lng, label: FIXTURE_SPOT.name });
  (window as unknown as { __portalDemoOff: () => void }).__portalDemoOff = off;
  console.log(`[portal-demo] started in mode ${state.get().mode}`);
}
