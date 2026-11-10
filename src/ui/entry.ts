import { RayInteractable, Vector3, Quaternion } from '@iwsdk/core';
import type { Entity, Object3D, UIKit, UIKitMLAsset } from '@iwsdk/core';
import type { ArchivePhoto, Track, TrackFactory, Unsubscribe } from '../contracts.js';
import { HudTag } from '../track-components.js';
import {
  BusyScopes,
  SLOTS,
  ToastQueue,
  composeCredits,
  deriveHud,
  slotPosition,
  yawFromForward,
} from './hud-logic.js';
import type { HudSlot, Toast } from './hud-logic.js';

/**
 * DEV-only demo driver used to produce screenshots. Keep false when finishing.
 * When true, entry.ts feeds fixture events on a timeline (see runDemo).
 */
const DEMO = false;

const ASSET_IDS: Record<HudSlot, string> = {
  time: 'hud-time-button',
  year: 'hud-year-label',
  credits: 'hud-credits',
  status: 'hud-status',
  portal: 'hud-portal-button',
};

interface Panel {
  entity: Entity;
  asset: UIKitMLAsset;
  object: Object3D;
}

const COLORS = {
  timeOn: '#3b2a8f',
  timeBackToNow: '#8f2a6a',
  timeDisabled: '#3a3d48',
  textDisabled: '#8a8f9f',
  loading: '#1d2a4a',
  error: '#6b1d1d',
  info: '#6b4a10',
  yearNow: '#14161d',
  yearPast: '#5a3a08',
} as const;

const RECENTRE_AFTER_XR_MS = 700;

export const createTrack: TrackFactory = async (ctx) => {
  const { world, bus, state } = ctx;
  const offs: Unsubscribe[] = [];
  const panels = new Map<HudSlot, Panel>();
  const busy = new BusyScopes();
  const spinnerFrames = ['Loading', 'Loading.', 'Loading..', 'Loading...'];
  let spinnerIndex = 0;
  let spinnerTimer: ReturnType<typeof setInterval> | null = null;
  let recentreTimer: ReturnType<typeof setTimeout> | null = null;
  let yearsKnown = false;
  let photos: ArchivePhoto[] = [];
  let toast: Toast | null = null;
  let disposed = false;

  // Scratch objects, allocated once.
  const head = new Vector3();
  const fwd = new Vector3();
  const headQuat = new Quaternion();
  const pos = { x: 0, y: 0, z: 0 };

  const toasts = new ToastQueue({
    onChange: (current) => {
      toast = current;
      refreshStatus();
    },
  });

  // ---------------------------------------------------------------------------------------
  // Panels
  // ---------------------------------------------------------------------------------------
  const text = (slot: HudSlot, id: string): UIKit.Text | null =>
    panels.get(slot)?.asset.getElementById<UIKit.Text>(id) ?? null;
  const box = (slot: HudSlot, id: string) => panels.get(slot)?.asset.getElementById(id) ?? null;
  const setVisible = (slot: HudSlot, visible: boolean): void => {
    const panel = panels.get(slot);
    if (panel) panel.object.visible = visible;
  };

  /** Hard snap of every panel to the head's current position and heading. Never animated. */
  const recentre = (): void => {
    if (disposed) return;
    const camera = world.camera;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(head);
    camera.getWorldQuaternion(headQuat);
    fwd.set(0, 0, -1).applyQuaternion(headQuat);
    const yaw = yawFromForward(fwd.x, fwd.z);
    for (const [slot, panel] of panels) {
      slotPosition(head, yaw, SLOTS[slot], pos);
      panel.object.position.set(pos.x, pos.y, pos.z);
      // Single-sided panels face +Z; lookAt on a non-camera points +Z at the target.
      panel.object.lookAt(head);
    }
  };

  const scheduleRecentre = (delayMs: number): void => {
    if (recentreTimer !== null) clearTimeout(recentreTimer);
    recentreTimer = setTimeout(() => {
      recentreTimer = null;
      recentre();
    }, delayMs);
  };

  const refreshCredits = (): void => {
    const el = text('credits', 'credits-text');
    el?.setProperties({ text: composeCredits(state.get().pano, photos) });
  };

  const refreshStatus = (): void => {
    const view = deriveHud({ state: state.get(), yearsKnown });
    let message: string | null = null;
    let bg: string = COLORS.loading;
    if (toast) {
      message = toast.message;
      bg = COLORS.error;
    } else if (busy.busy) {
      message = spinnerFrames[spinnerIndex];
      bg = COLORS.loading;
    } else if (view.noEarlierImagery) {
      message = 'No earlier imagery here';
      bg = COLORS.info;
    }
    setVisible('status', message !== null);
    if (message !== null) {
      text('status', 'status-text')?.setProperties({ text: message });
      box('status', 'status-root')?.setProperties({ backgroundColor: bg });
    }
  };

  const refreshHud = (): void => {
    const view = deriveHud({ state: state.get(), yearsKnown });
    setVisible('time', view.showTimeButton);
    setVisible('year', view.showYear);
    setVisible('portal', view.showPortalButton);
    text('time', 'time-btn-label')?.setProperties({
      text: view.timeButtonLabel,
      color: view.timeButtonEnabled ? '#ffffff' : COLORS.textDisabled,
    });
    box('time', 'time-btn')?.setProperties({
      backgroundColor: !view.timeButtonEnabled
        ? COLORS.timeDisabled
        : state.get().timeOn
          ? COLORS.timeBackToNow
          : COLORS.timeOn,
    });
    text('year', 'year-text')?.setProperties({ text: view.yearText });
    box('year', 'year-root')?.setProperties({
      backgroundColor: view.yearIsPast ? COLORS.yearPast : COLORS.yearNow,
    });
    text('portal', 'portal-btn-label')?.setProperties({ text: view.portalButtonLabel });
    refreshStatus();
  };

  const updateSpinner = (): void => {
    if (busy.busy && spinnerTimer === null) {
      spinnerTimer = setInterval(() => {
        spinnerIndex = (spinnerIndex + 1) % spinnerFrames.length;
        refreshStatus();
      }, 350);
    } else if (!busy.busy && spinnerTimer !== null) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      spinnerIndex = 0;
    }
  };

  // ---------------------------------------------------------------------------------------
  // Create the five panels (persistent app content, not level content)
  // ---------------------------------------------------------------------------------------
  for (const slot of Object.keys(ASSET_IDS) as HudSlot[]) {
    const asset = await world.assets.instantiate<UIKitMLAsset>(ASSET_IDS[slot]);
    asset.name = `hud-${slot}`;
    const entity = world.createTransformEntity(asset, { persistent: true });
    entity.addComponent(HudTag, { slot });
    if (slot === 'time' || slot === 'portal') entity.addComponent(RayInteractable);
    asset.visible = slot === 'credits';
    panels.set(slot, { entity, asset, object: asset });
  }

  // Controls: UIKit elements receive pointer clicks from both XR rays and desktop canvas events.
  const onTimeClick = (): void => {
    const view = deriveHud({ state: state.get(), yearsKnown });
    if (!view.timeButtonEnabled) return;
    bus.emit('time:toggled', { on: !state.get().timeOn });
  };
  const onPortalClick = (): void => {
    bus.emit('mode:requested', { mode: deriveHud({ state: state.get(), yearsKnown }).portalTarget });
  };
  const timeBtn = box('time', 'time-btn');
  const portalBtn = box('portal', 'portal-btn');
  timeBtn?.addEventListener('click', onTimeClick);
  portalBtn?.addEventListener('click', onPortalClick);
  offs.push(
    () => timeBtn?.removeEventListener('click', onTimeClick),
    () => portalBtn?.removeEventListener('click', onPortalClick),
  );

  // ---------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------
  offs.push(
    bus.on('spot:selected', () => {
      yearsKnown = false;
      photos = [];
      toasts.clear();
      refreshCredits();
      refreshHud();
    }),
    bus.on('pano:shown', () => {
      refreshCredits();
      refreshHud();
    }),
    bus.on('time:yearsKnown', () => {
      yearsKnown = true;
      refreshHud();
    }),
    bus.on('time:toggled', refreshHud),
    bus.on('time:yearChanged', refreshHud),
    bus.on('time:committed', () => {
      refreshCredits();
      refreshHud();
    }),
    bus.on('archive:visible', ({ photos: visible }) => {
      photos = visible;
      refreshCredits();
    }),
    bus.on('mode:changed', () => {
      refreshHud();
      recentre();
    }),
    bus.on('loading', ({ scope, busy: isBusy }) => {
      busy.set(scope, isBusy);
      updateSpinner();
      refreshStatus();
    }),
    bus.on('error', ({ source, message, recoverable }) => {
      console.warn(`[ui] error from ${source}: ${message}`);
      toasts.push(source, message, recoverable);
    }),
  );

  // Recentre when an immersive session starts (the head moves to a new origin) and on KeyC
  // (a deliberate desktop recentre). Both are hard snaps.
  const xr = world.renderer.xr;
  const onSessionStart = (): void => scheduleRecentre(RECENTRE_AFTER_XR_MS);
  xr.addEventListener('sessionstart', onSessionStart);
  offs.push(() => xr.removeEventListener('sessionstart', onSessionStart));
  const onKey = (event: KeyboardEvent): void => {
    if (event.code === 'KeyC' && !event.repeat && !event.ctrlKey && !event.metaKey) recentre();
  };
  window.addEventListener('keydown', onKey);
  offs.push(() => window.removeEventListener('keydown', onKey));

  refreshCredits();
  refreshHud();
  recentre();
  scheduleRecentre(300); // the camera pose is only trustworthy after the first frame

  if (import.meta.env.DEV && DEMO) void import('./demo.js').then((m) => m.runDemo(ctx));

  const track: Track & { recentre: () => void } = {
    name: 'ui',
    recentre,
    dispose() {
      disposed = true;
      offs.forEach((off) => off());
      toasts.dispose();
      if (spinnerTimer !== null) clearInterval(spinnerTimer);
      if (recentreTimer !== null) clearTimeout(recentreTimer);
      for (const { entity, asset } of panels.values()) {
        asset.dispose();
        entity.dispose();
      }
      panels.clear();
    },
  };
  return track;
};
