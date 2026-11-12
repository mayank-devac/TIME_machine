import { Mesh, MeshBasicMaterial, Quaternion, RayInteractable, RingGeometry, Vector3, createSystem } from '@iwsdk/core';
import type { Entity, Object3D, UIKit, UIKitMLAsset } from '@iwsdk/core';
import type { ArchivePhoto, Track, TrackFactory, Unsubscribe } from '../contracts.js';
import { DragRig, placements, stopBubbling } from '../drag.js';
import { readHead } from '../head.js';
import { currentTokens, onThemeChange } from '../theme.js';
import { HudTag } from '../track-components.js';
import { BusyScopes, ToastQueue, composeCredits, deriveHud, slotPosition, slotSpec, yawFromForward } from './hud-logic.js';
import type { HudSlot, Toast } from './hud-logic.js';
import type { Host, PanelModule } from './host.js';
import { attachHover, forgetStyles, paintBox, paintIconButton, paintText, repaintAll } from './panel-style.js';
import type { El, Fill } from './panel-style.js';
import { createPlacesPanel } from './places-panel.js';
import { createSearchPanel } from './search-panel.js';
import { createSettingsPanel } from './settings-panel.js';
import { createStreetBar } from './street-bar.js';

interface PanelSpec {
  /** Manifest id in `src/assets.ts`. */
  asset: string;
  /** Id of the panel's root element, measured to put the drag grip above it. */
  root: string;
  /** Has controls, so it needs `RayInteractable` for clicks to land. */
  interactive: boolean;
  /** Can be moved by its grip. The status toast is transient and stays put. */
  draggable: boolean;
}

const PANELS: Readonly<Record<HudSlot, PanelSpec>> = {
  bar: { asset: 'hud-street-bar', root: 'bar-root', interactive: true, draggable: true },
  places: { asset: 'hud-places', root: 'places-root', interactive: true, draggable: true },
  search: { asset: 'hud-search', root: 'search-root', interactive: true, draggable: true },
  settings: { asset: 'hud-settings', root: 'settings-root', interactive: true, draggable: true },
  credits: { asset: 'hud-credits', root: 'credits-root', interactive: true, draggable: true },
  status: { asset: 'hud-status', root: 'status-root', interactive: false, draggable: false },
};

interface Panel {
  entity: Entity;
  asset: UIKitMLAsset;
  rig: DragRig | null;
  /** What is positioned and shown or hidden: the rig when there is one, else the panel. */
  node: Object3D;
}

const RECENTRE_AFTER_XR_MS = 700;
/** UIKit lays a panel out a few frames after a change; measure for the grip after this. */
const GRIP_SETTLE_MS = 150;
/** Gap between a panel's top edge and its grip, metres. */
const GRIP_GAP_M = 0.03;
/** Buffer spinner: arc sweep and spin rate, rad/s. */
const SPINNER_ARC = Math.PI * 1.5;
const SPINNER_SPEED = 5;
/** Pill width while only the spinner shows, UIKit units (the text pill is 70). */
const SPINNER_PILL = 12;

/**
 * Per frame: turn every visible panel to face the viewer, wherever it is placed, and spin the
 * status panel's buffer arc. The work lives behind a callback because the object to turn is the
 * rig root (not the entity's own asset, which is a child of it), and the panel map belongs to
 * the UI track.
 */
class PanelFaceSystem extends createSystem({}) {
  face: (() => void) | null = null;
  spinner: Mesh | null = null;

  update(delta: number): void {
    if (this.spinner?.visible) this.spinner.rotation.z -= delta * SPINNER_SPEED;
    this.face?.();
  }
}

export const createTrack: TrackFactory = async (ctx) => {
  const { world, bus, state } = ctx;
  const offs: Unsubscribe[] = [];
  const panels = new Map<HudSlot, Panel>();
  const gripTimers = new Map<HudSlot, ReturnType<typeof setTimeout>>();
  const busy = new BusyScopes();
  let recentreTimer: ReturnType<typeof setTimeout> | null = null;
  let yearsKnown = false;
  let photos: ArchivePhoto[] = [];
  let toast: Toast | null = null;
  let disposed = false;
  let creditsFolded = true;
  let creditsShape: boolean | null = null;

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
  // Panels (persistent app content, not level content)
  // ---------------------------------------------------------------------------------------
  for (const slot of Object.keys(PANELS) as HudSlot[]) {
    const spec = PANELS[slot];
    const asset = await world.assets.instantiate<UIKitMLAsset>(spec.asset);
    asset.name = `hud-${slot}`;
    const rig = spec.draggable ? new DragRig(world, { id: `hud-${slot}` }) : null;
    const entity = world.createTransformEntity(asset, rig ? { parent: rig.entity, persistent: true } : { persistent: true });
    entity.addComponent(HudTag, { slot });
    if (spec.interactive) entity.addComponent(RayInteractable);
    // Pressing a control on the panel must never start a drag; only the grip does.
    if (rig) stopBubbling(asset);
    const node = rig ? rig.root : asset;
    node.visible = false;
    panels.set(slot, { entity, asset, rig, node });
  }

  /**
   * The status panel's buffer spinner: a YouTube-style arc mesh in front of the pill. UIKit's
   * bundled font atlas has no spinner glyphs, so the animation is geometry, not text. Built at
   * pill scale (UIKit units, 1 = 1 cm) and scaled down to the panel's metre space.
   */
  const spinnerGeometry = new RingGeometry(1.7, 2.6, 24, 1, 0, SPINNER_ARC);
  const spinnerMaterial = new MeshBasicMaterial({ color: currentTokens().accent });
  const spinner = new Mesh(spinnerGeometry, spinnerMaterial);
  spinner.scale.setScalar(0.01); // cm-geometry into the metre-space of the UIKit group
  spinner.position.z = 0.003; // in front of the pill surface
  spinner.visible = false;
  panels.get('status')!.asset.add(spinner);

  const host: Host = {
    ctx,
    el: (slot, id) => panels.get(slot)?.asset.getElementById(id) ?? null,
    text: (slot, id) => panels.get(slot)?.asset.getElementById<UIKit.Text>(id) ?? null,
    setVisible(slot, visible) {
      const panel = panels.get(slot);
      if (panel) panel.node.visible = visible;
    },
    control(el, variant, onClick) {
      if (!el) return;
      el.addEventListener('click', onClick);
      offs.push(() => el.removeEventListener('click', onClick), attachHover(el, variant));
    },
    resized(slot) {
      const pending = gripTimers.get(slot);
      if (pending !== undefined) clearTimeout(pending);
      gripTimers.set(
        slot,
        setTimeout(() => {
          gripTimers.delete(slot);
          placeGrip(slot);
        }, GRIP_SETTLE_MS),
      );
    },
    get disposed() {
      return disposed;
    },
  };

  /**
   * Put a panel's grip just above its top edge. UIKit panels are instanced meshes with empty
   * geometry bounds, so a `Box3` walk measures nothing; the top edge comes from UIKit's own
   * laid-out height instead (the root element is centred on the panel origin, 1 px = 1 cm).
   */
  function placeGrip(slot: HudSlot): void {
    const panel = panels.get(slot);
    const root = host.el(slot, PANELS[slot].root) as (El & { size?: { peek(): [number, number] | undefined } }) | null;
    if (disposed || !panel?.rig || !root) return;
    const heightPx = root.size?.peek()?.[1] ?? Number.NaN;
    // Before the first layout the size is unknown; keep the grip close in that case.
    const top = Number.isFinite(heightPx) && heightPx > 0 ? (heightPx / 2) * 0.01 : 0.06;
    panel.rig.placeGrip(0, top + GRIP_GAP_M, 0);
  }

  /**
   * Hard snap of every panel to the head's current position and heading. Never animated.
   * A panel the user has dragged stays where they left it.
   */
  const recentre = (): void => {
    if (disposed) return;
    const camera = world.camera;
    camera.updateWorldMatrix(true, false);
    camera.getWorldPosition(head);
    camera.getWorldQuaternion(headQuat);
    fwd.set(0, 0, -1).applyQuaternion(headQuat);
    const yaw = yawFromForward(fwd.x, fwd.z);
    const mode = state.get().mode;
    for (const [slot, panel] of panels) {
      if (panel.rig && placements.has(panel.rig.id)) continue;
      slotPosition(head, yaw, slotSpec(slot, mode), pos);
      panel.node.position.set(pos.x, pos.y, pos.z);
      // Single-sided panels face +Z; lookAt on a non-camera points +Z at the target.
      panel.node.lookAt(head);
      host.resized(slot);
    }
  };

  /**
   * Turn every visible panel to face the head (yaw and pitch), wherever recentre or a drag
   * left it. Runs every frame via `PanelFaceSystem`, so a panel never sits edge-on or
   * backwards to whoever looks at it.
   */
  const faceHead = (): void => {
    if (disposed) return;
    readHead(world, head);
    for (const panel of panels.values()) {
      if (!panel.node.visible) continue;
      panel.node.lookAt(head);
    }
  };

  world.registerSystem(PanelFaceSystem);
  const faceSystem = world.getSystem(PanelFaceSystem)!;
  faceSystem.face = faceHead;
  faceSystem.spinner = spinner;

  /** Forget where the user dragged the panels, then recentre (new XR session, desktop C key). */
  const resetPlacements = (): void => {
    for (const panel of panels.values()) if (panel.rig) placements.delete(panel.rig.id);
  };

  const scheduleRecentre = (delayMs: number): void => {
    if (recentreTimer !== null) clearTimeout(recentreTimer);
    recentreTimer = setTimeout(() => {
      recentreTimer = null;
      recentre();
    }, delayMs);
  };

  // ---------------------------------------------------------------------------------------
  // Credits and status (small enough to live here)
  // ---------------------------------------------------------------------------------------
  const refreshCredits = (): void => {
    const view = deriveHud({ state: state.get(), yearsKnown });
    host.setVisible('credits', view.showCredits);
    paintBox(host.el('credits', 'credits-root'), 'panel');
    paintIconButton(host.el('credits', 'credits-info'), host.el('credits', 'credits-info-icon'), 'info', 'control');
    const el = host.text('credits', 'credits-text');
    el?.setProperties({ text: composeCredits(state.get().pano, photos), display: creditsFolded ? 'none' : 'flex' });
    paintText(el, 'secondary');
    if (creditsShape !== creditsFolded) {
      creditsShape = creditsFolded;
      host.resized('credits');
    }
  };
  // The info button folds the attribution to the button alone; it is never removed.
  host.control(host.el('credits', 'credits-info'), 'default', () => {
    creditsFolded = !creditsFolded;
    refreshCredits();
  });

  function refreshStatus(): void {
    const view = deriveHud({ state: state.get(), yearsKnown });
    let message: string | null = null;
    let fill: Fill = 'panel';
    let spinnerOnly = false;
    if (toast) {
      message = toast.message;
      fill = 'danger';
    } else if (busy.busy) {
      // Buffering shows the rotating arc alone, like a video player's spinner.
      spinnerOnly = true;
    } else if (view.noEarlierImagery) {
      message = 'No earlier imagery here';
      fill = 'notice';
    }
    host.setVisible('status', message !== null || spinnerOnly);
    spinner.visible = spinnerOnly;
    const root = host.el('status', 'status-root');
    if (spinnerOnly) {
      root?.setProperties({ width: SPINNER_PILL });
      host.text('status', 'status-text')?.setProperties({ text: '', display: 'none' });
      paintBox(root, 'panel');
      return;
    }
    root?.setProperties({ width: 70 }); // back to the class width for text messages
    if (message === null) return;
    const el = host.text('status', 'status-text');
    el?.setProperties({ text: message, display: 'flex' });
    paintText(el, fill === 'notice' ? 'muted' : 'primary');
    paintBox(root, fill);
  }

  const bar = createStreetBar(host, () => yearsKnown);
  const places = createPlacesPanel(host);
  const search = createSearchPanel(host);
  const settings = createSettingsPanel(host);
  const modules: PanelModule[] = [bar, places, search, settings];

  const refreshHud = (): void => {
    for (const m of modules) m.refresh();
    refreshCredits();
    refreshStatus();
  };

  // ---------------------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------------------
  offs.push(
    onThemeChange(repaintAll),
    onThemeChange((t) => spinnerMaterial.color.set(t.accent)),
    bus.on('prefs:changed', () => settings.refresh()),
    bus.on('map:viewChanged', ({ lat, lng, zoom }) => void places.load(lat, lng, zoom)),
    bus.on('spot:selected', () => {
      yearsKnown = false;
      photos = [];
      toasts.clear();
      refreshHud();
    }),
    bus.on('pano:shown', () => {
      refreshHud();
      places.followPano();
    }),
    bus.on('time:yearsKnown', () => {
      yearsKnown = true;
      refreshHud();
    }),
    bus.on('time:toggled', refreshHud),
    bus.on('time:yearChanged', refreshHud),
    bus.on('time:committed', refreshHud),
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
      refreshStatus();
    }),
    bus.on('error', ({ source, message, recoverable }) => {
      console.warn(`[ui] error from ${source}: ${message}`);
      toasts.push(source, message, recoverable);
    }),
  );

  // The world origin moves when an immersive session starts or ends, so dragged positions no
  // longer mean anything: forget them and recentre. KeyC is the deliberate desktop recentre.
  // All of these are hard snaps.
  const xr = world.renderer.xr;
  const onSessionChange = (): void => {
    resetPlacements();
    scheduleRecentre(RECENTRE_AFTER_XR_MS);
  };
  xr.addEventListener('sessionstart', onSessionChange);
  xr.addEventListener('sessionend', onSessionChange);
  offs.push(
    () => xr.removeEventListener('sessionstart', onSessionChange),
    () => xr.removeEventListener('sessionend', onSessionChange),
  );
  const onKey = (event: KeyboardEvent): void => {
    if (event.code !== 'KeyC' || event.repeat || event.ctrlKey || event.metaKey) return;
    resetPlacements();
    recentre();
  };
  window.addEventListener('keydown', onKey);
  offs.push(() => window.removeEventListener('keydown', onKey));

  refreshHud();
  recentre();
  scheduleRecentre(300); // the camera pose is only trustworthy after the first frame

  const track: Track & { recentre: () => void } = {
    name: 'ui',
    recentre,
    dispose() {
      disposed = true;
      for (const m of modules) m.dispose?.();
      offs.forEach((off) => off());
      world.unregisterSystem(PanelFaceSystem);
      toasts.dispose();
      if (recentreTimer !== null) clearTimeout(recentreTimer);
      spinnerGeometry.dispose();
      spinnerMaterial.dispose();
      for (const t of gripTimers.values()) clearTimeout(t);
      gripTimers.clear();
      for (const { entity, asset, rig } of panels.values()) {
        asset.dispose();
        entity.dispose();
        rig?.dispose();
      }
      panels.clear();
      forgetStyles();
    },
  };
  return track;
};
