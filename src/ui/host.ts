/**
 * What each HUD panel module gets from `entry.ts`: element lookup, click wiring and a few
 * shared services. Keeps the panel modules free of entity and placement details.
 */
import type { UIKit } from '@iwsdk/core';
import type { TrackContext } from '../contracts.js';
import type { HudSlot } from './hud-logic.js';
import type { El } from './panel-style.js';
import type { HoverVariant } from '../theme.js';

export interface Host {
  readonly ctx: TrackContext;
  /** An element of a panel, or null if the panel or id is missing. */
  el(slot: HudSlot, id: string): El | null;
  text(slot: HudSlot, id: string): UIKit.Text | null;
  setVisible(slot: HudSlot, visible: boolean): void;
  /** Click handler plus hover variant for a control; both are removed on dispose. */
  control(el: El | null, variant: HoverVariant, onClick: () => void): void;
  /** The panel changed size (folded, rows appeared): move its drag grip back under it. */
  resized(slot: HudSlot): void;
  /** True once the HUD has been disposed; async work must stop touching panels. */
  readonly disposed: boolean;
}

/** A panel module: repaint from state, and stop timers or requests on dispose. */
export interface PanelModule {
  refresh(): void;
  dispose?(): void;
}
