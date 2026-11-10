import type { TrackFactory } from '../contracts.js';
import { TimeLensSystem } from './system.js';
import { TimeMachine } from './time-machine.js';

/**
 * Track C entry: the time lens, the wrist dial and push-through. See `README.md`.
 * Listens to `pano:shown`, `time:toggled`, `mode:changed`; emits `time:yearsKnown`,
 * `time:yearChanged`, `time:committed`.
 */
export const createTrack: TrackFactory = async (ctx) => {
  const { world } = ctx;
  const timeMachine = new TimeMachine(ctx);
  world.registerSystem(TimeLensSystem);
  world.getSystem(TimeLensSystem)?.bind(timeMachine);

  let stopDev: () => void = () => {};
  if (import.meta.env.DEV) {
    const { runDevScenario } = await import('./dev-scenario.js');
    stopDev = await runDevScenario(ctx);
  }

  return {
    name: 'time',
    dispose() {
      stopDev();
      world.getSystem(TimeLensSystem)?.bind(null);
      world.unregisterSystem(TimeLensSystem);
      timeMachine.dispose();
    },
  };
};
