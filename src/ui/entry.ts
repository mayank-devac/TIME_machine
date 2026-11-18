import { Mesh, MeshBasicMaterial, RayInteractable, RingGeometry, Vector3, createSystem } from '@iwsdk/core';
import type { Entity, Object3D, UIKit, UIKitMLAsset } from '@iwsdk/core';
import type { ArchivePhoto, Track, TrackFactory, Unsubscribe } from '../contracts.js';
import { DragRig, placements, stopBubbling } from '../drag.js';
import { positionAround, readHead, yawFromForward } from '../head.js';
import { currentTokens, onThemeChange } from '../theme.js';
import { HudTag } from '../track-components.js';
import { BusyScopes, ToastQueue, composeCredits, deriveHud, slotSpec } from './hud-logic.js';
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

/** How fast the grip glides to a panel's new top edge: 1/e of the gap closes in this many seconds. */
const GRIP_EASE_S = 0.06;
/** Below this gap, metres, the grip lands exactly on its target. */
const GRIP_SNAP_M = 0.0005;
/** How long the grip stays visible after the pointer leaves its panel. */
const GRIP_HIDE_DELAY_MS = 1500;
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
  face: ((delta: number) => void) | null = null;
  spinner: Mesh | null = null;

  update(delta: number): void {
    if (this.spinner?.visible) this.spinner.rotation.z -= delta * SPINNER_SPEED;
    this.face?.(delta);
  }
}

export const createTrack: TrackFactory = async (ctx) => {
  const { world, bus, state } = ctx;
  const offs: Unsubscribe[] = [];
  const panels = new Map<HudSlot, Panel>();
  const busy = new BusyScopes();
  let yearsKnown = false;
  let photos: ArchivePhoto[] = [];
  let toast: Toast | null = null;
  let disposed = false;
  let creditsFolded = true;
  let creditsShape: boolean | null = null;

  // Scratch objects, allocated once.
  const head = new Vector3();
  const fwd = new Vector3();
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
    if (rig) {
      // The grip shows only while the ray is over the panel or the grip itself. A short hide
      // delay lets the ray cross the gap between the two without the grip flickering.
      rig.grip.visible = false;
      let hideTimer: ReturnType<typeof setTimeout> | null = null;
      const show = (): void => {
        if (hideTimer !== null) clearTimeout(hideTimer);
        hideTimer = null;
        rig.grip.visible = true;
      };
      const hide = (): void => {
        if (hideTimer !== null) clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
          hideTimer = null;
          rig.grip.visible = false;
        }, GRIP_HIDE_DELAY_MS);
      };
      type Target = { addEventListener(t: string, f: () => void): void; removeEventListener(t: string, f: () => void): void };
      for (const target of [asset, rig.root] as unknown as Target[]) {
        target.addEventListener('pointerenter', show);
        target.addEventListener('pointerleave', hide);
        offs.push(() => {
          target.removeEventListener('pointerenter', show);
          target.removeEventListener('pointerleave', hide);
          if (hideTimer !== null) clearTimeout(hideTimer);
        });
      }
    }
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
      // The grip follows the panel's layout every frame (`followGrip`); nothing to schedule.
      placeGrip(slot, 0);
    },
    get disposed() {
      return disposed;
    },
  };

  /**
   * Put a panel's grip just above its top edge. UIKit panels are instanced meshes with empty
   * geometry bounds, so a `Box3` walk measures nothing; the top edge comes from UIKit's own
   * laid-out height instead (the root element is centred on the panel origin, 1 px = 1 cm).
   *
   * Runs every frame for visible panels, so the grip tracks the panel while a tab opens instead
   * of waiting for the layout to finish and then jumping. A visible grip glides (`delta` > 0);
   * a hidden one, or `delta` 0, lands at once.
   */
  type Sized = El & { size?: { peek(): [number, number] | undefined } };
  const gripRoots = new Map<HudSlot, Sized | null>();
  function placeGrip(slot: HudSlot, delta: number): void {
    const panel = panels.get(slot);
    if (disposed || !panel?.rig) return;
    let root = gripRoots.get(slot);
    if (!root) {
      root = host.el(slot, PANELS[slot].root) as Sized | null;
      gripRoots.set(slot, root);
      if (!root) return;
    }
    const heightPx = root.size?.peek()?.[1] ?? Number.NaN;
    // Before the first layout the size is unknown; keep the grip close in that case.
    const top = Number.isFinite(heightPx) && heightPx > 0 ? (heightPx / 2) * 0.01 : 0.06;
    const target = top + GRIP_GAP_M;
    const grip = panel.rig.grip.position;
    const gap = target - grip.y;
    if (gap === 0) return;
    const glide = delta > 0 && panel.rig.grip.visible && Math.abs(gap) > GRIP_SNAP_M;
    const y = glide ? grip.y + gap * (1 - Math.exp(-delta / GRIP_EASE_S)) : target;
    panel.rig.placeGrip(0, y, 0);
  }

  /**
   * Where each panel sat in table mode when the viewer last left it. The map table is placed
   * only on `viewer:recentred`, not per mode change, so re-laying the panels around wherever
   * the head turned in the street would scatter them away from the table. Cleared with drags.
   */
  const tableLayout = new Map<HudSlot, Vector3>();
  const saveTableLayout = (): void => {
    for (const [slot, panel] of panels) {
      const saved = tableLayout.get(slot);
      if (saved) saved.copy(panel.node.position);
      else tableLayout.set(slot, panel.node.position.clone());
    }
  };

  /**
   * Hard snap of every panel to the head's current position and heading. Never animated.
   * A panel the user has dragged stays where they left it.
   */
  const recentre = (): void => {
    if (disposed) return;
    world.camera.updateWorldMatrix(true, false);
    readHead(world, head, fwd);
    const yaw = yawFromForward(fwd.x, fwd.z);
    const mode = state.get().mode;
    for (const [slot, panel] of panels) {
      // Back at the map: the table never moved, so neither do its panels.
      const saved = mode === 'table' ? tableLayout.get(slot) : undefined;
      if (saved) {
        panel.node.position.copy(saved);
        panel.node.lookAt(head);
        host.resized(slot);
        continue;
      }
      if (panel.rig && placements.has(panel.rig.id)) continue;
      positionAround(head, yaw, slotSpec(slot, mode), pos);
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
  const faceHead = (delta: number): void => {
    if (disposed) return;
    readHead(world, head);
    for (const [slot, panel] of panels) {
      if (!panel.node.visible) continue;
      panel.node.lookAt(head);
      if (panel.rig) placeGrip(slot, delta);
    }
  };

  world.registerSystem(PanelFaceSystem);
  const faceSystem = world.getSystem(PanelFaceSystem)!;
  faceSystem.face = faceHead;
  faceSystem.spinner = spinner;

  /** Forget where the user dragged the panels (their old positions mean nothing in a new frame). */
  const resetPlacements = (): void => {
    for (const panel of panels.values()) if (panel.rig) placements.delete(panel.rig.id);
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
      message = 'Some years street Unavailable ';
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
    bus.on('mode:changed', ({ previous }) => {
      if (previous === 'table') saveTableLayout();
      refreshHud();
      recentre();
    }),
    // A new frame of reference (session start or end, headset recentre, C key): drags are void.
    bus.on('viewer:recentred', () => {
      resetPlacements();
      tableLayout.clear();
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

  refreshHud();
  recentre(); // provisional; `viewer:recentred` follows once the head pose is trustworthy

  const track: Track & { recentre: () => void } = {
    name: 'ui',
    recentre,
    dispose() {
      disposed = true;
      for (const m of modules) m.dispose?.();
      offs.forEach((off) => off());
      world.unregisterSystem(PanelFaceSystem);
      toasts.dispose();
      spinnerGeometry.dispose();
      spinnerMaterial.dispose();
      gripRoots.clear();
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
