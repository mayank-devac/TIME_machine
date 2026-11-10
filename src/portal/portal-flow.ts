import { config } from '../config.js';
import type { EventBus, Mode, PanoStage, Unsubscribe } from '../contracts.js';

/** What the flow needs from the stage. A real `PanoStage` satisfies it; tests pass a fake. */
export type StageLike = Pick<PanoStage, 'stencilRef' | 'setVisible'>;

/** Why the user left the portal for the full street. Logged, and handy in tests. */
export type EnterReason = 'head' | 'hand' | 'press';

export interface PortalFlowHooks {
  /** Mode became `portal`: show the window (place it in front of the head). */
  onOpen(): void;
  /** Mode left `portal`: hide the window. */
  onClose(): void;
}

/**
 * How long a sent `mode:requested` blocks a repeat. The orchestrator's flow answers with
 * `mode:changed` synchronously when it accepts; when it refuses (for example no panorama
 * yet) nothing comes back, so the block must lapse instead of sticking forever.
 */
export const REQUEST_TIMEOUT_MS = 1500;

/**
 * Portal mode logic, free of Three.js:
 *  - listens to `mode:changed`; in `portal` it sets `stage.stencilRef` and opens the window,
 *    in any other mode it clears `stage.stencilRef` (sphere draws everywhere again) and
 *    closes the window;
 *  - turns user intents (open, step/push through, exit) into at most ONE `mode:requested`
 *    until the flow answers or the request times out.
 */
export class PortalFlow {
  private mode: Mode;
  private pending: Mode | null = null;
  private pendingSince = 0;
  private readonly off: Unsubscribe;
  /** Number of `mode:requested` events this flow has emitted. For tests and logs. */
  requests = 0;
  lastEnterReason: EnterReason | null = null;

  constructor(
    private readonly bus: EventBus,
    private readonly stage: StageLike,
    initialMode: Mode,
    private readonly hooks: PortalFlowHooks,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.mode = initialMode;
    this.off = bus.on('mode:changed', ({ mode }) => this.onModeChanged(mode));
    if (initialMode === 'portal') this.applyOpen();
  }

  get currentMode(): Mode {
    return this.mode;
  }

  get isOpen(): boolean {
    return this.mode === 'portal';
  }

  get pendingRequest(): Mode | null {
    this.expire();
    return this.pending;
  }

  /** From the street, ask to switch to portal mode. */
  requestPortal(): boolean {
    return this.mode === 'street' && this.request('portal');
  }

  /** Stepped or pushed through, or pressed the window: ask for the full street. */
  enterStreet(reason: EnterReason): boolean {
    if (this.mode !== 'portal') return false;
    const sent = this.request('street');
    if (sent) this.lastEnterReason = reason;
    return sent;
  }

  /** Leave the portal and go back to the room (the table). */
  exitToRoom(): boolean {
    return this.mode === 'portal' && this.request('table');
  }

  dispose(): void {
    this.off();
    if (this.mode === 'portal') this.stage.stencilRef = null;
  }

  private request(mode: Mode): boolean {
    this.expire();
    if (this.pending !== null) return false;
    this.pending = mode;
    this.pendingSince = this.now();
    this.requests++;
    this.bus.emit('mode:requested', { mode });
    return true;
  }

  private expire(): void {
    if (this.pending !== null && this.now() - this.pendingSince > REQUEST_TIMEOUT_MS) {
      this.pending = null;
    }
  }

  private onModeChanged(mode: Mode): void {
    const was = this.mode;
    this.mode = mode;
    this.pending = null;
    if (mode === 'portal' && was !== 'portal') this.applyOpen();
    else if (mode !== 'portal' && was === 'portal') this.applyClose();
  }

  private applyOpen(): void {
    this.stage.stencilRef = config.portal.stencilRef;
    this.stage.setVisible(true);
    this.hooks.onOpen();
  }

  private applyClose(): void {
    this.stage.stencilRef = null;
    this.hooks.onClose();
  }
}
