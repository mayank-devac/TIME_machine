/**
 * The settings panel: three switches and nothing else. Folded to its header until opened.
 *  - Satellite view: satellite imagery on the table map (off shows the themed map).
 *  - Dark mode: the colours of every UI surface, and the non-satellite base map.
 *  - 3D buildings: tilted table map with raised buildings.
 * Each switch writes `ctx.prefs`; the map and the theme follow `prefs:changed`.
 */
import type { Prefs } from '../contracts.js';
import { showSettingsPanel, startsCollapsed } from './hud-logic.js';
import type { Host, PanelModule } from './host.js';
import { paintBox, paintIconButton, paintText } from './panel-style.js';

interface Switch {
  /** Id suffix in `settings.uikitml`. */
  key: 'satellite' | 'dark' | '3d';
  on(p: Readonly<Prefs>): boolean;
  toggled(p: Readonly<Prefs>): Partial<Prefs>;
}

export const SETTINGS_SWITCHES: readonly Switch[] = [
  { key: 'satellite', on: (p) => p.satellite, toggled: (p) => ({ satellite: !p.satellite }) },
  { key: 'dark', on: (p) => p.theme === 'dark', toggled: (p) => ({ theme: p.theme === 'dark' ? 'light' : 'dark' }) },
  { key: '3d', on: (p) => p.buildings3d, toggled: (p) => ({ buildings3d: !p.buildings3d }) },
];

export function createSettingsPanel(host: Host): PanelModule {
  const { prefs, state } = host.ctx;
  let folded = startsCollapsed('settings', 'table');
  let shape: boolean | null = null;

  const refresh = (): void => {
    const show = showSettingsPanel(state.get().mode);
    host.setVisible('settings', show);
    if (!show) return;
    paintBox(host.el('settings', 'settings-root'), 'panel');
    paintText(host.text('settings', 'settings-title'), 'secondary');
    paintIconButton(
      host.el('settings', 'settings-fold'),
      host.el('settings', 'settings-fold-icon'),
      folded ? 'chevron-down' : 'chevron-up',
      'ghost',
    );
    host.el('settings', 'settings-content')?.setProperties({ display: folded ? 'none' : 'flex' });

    const p = prefs.get();
    for (const s of SETTINGS_SWITCHES) {
      const on = s.on(p);
      paintBox(host.el('settings', `set-row-${s.key}`), 'control');
      paintText(host.text('settings', `set-label-${s.key}`), 'primary');
      const track = host.el('settings', `set-switch-${s.key}`);
      // The knob slides to the right and the track fills with the accent when on.
      track?.setProperties({ justifyContent: on ? 'flex-end' : 'flex-start' });
      paintBox(track, on ? 'primary' : 'control');
      paintBox(host.el('settings', `set-knob-${s.key}`), on ? 'knobOn' : 'knobOff');
    }

    if (shape !== folded) {
      shape = folded;
      host.resized('settings');
    }
  };

  for (const s of SETTINGS_SWITCHES) {
    // The whole row is the target: a 12 cm switch alone is a small thing to hit with a ray.
    host.control(host.el('settings', `set-row-${s.key}`), 'toggle', () => {
      prefs.set(s.toggled(prefs.get()));
      refresh();
    });
  }
  host.control(host.el('settings', 'settings-fold'), 'default', () => {
    folded = !folded;
    refresh();
  });

  return { refresh };
}
