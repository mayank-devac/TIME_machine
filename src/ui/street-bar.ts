/**
 * The street bar: the year, the year chips, and MAP / TIME MACHINE / PORTAL in one panel.
 * Shown in street and portal mode. In portal mode MAP and PORTAL are hidden, because the
 * portal window carries its own STEP IN and MAP buttons.
 */
import { MAX_YEAR_CHIPS, deriveHud, yearChipAction, yearChips } from './hud-logic.js';
import type { Host, PanelModule } from './host.js';
import { paintBox, paintButton, paintText } from './panel-style.js';

export function createStreetBar(host: Host, yearsKnown: () => boolean): PanelModule {
  const { bus, state } = host.ctx;
  let chips: ReturnType<typeof yearChips> = [];
  let navShown: boolean | null = null;

  const inputs = () => ({ state: state.get(), yearsKnown: yearsKnown() });

  const refresh = (): void => {
    const view = deriveHud(inputs());
    host.setVisible('bar', view.showBar);
    if (!view.showBar) return;

    paintBox(host.el('bar', 'bar-root'), 'panel');
    paintBox(host.el('bar', 'year-root'), view.yearIsPast ? 'past' : 'control');
    const year = host.text('bar', 'year-text');
    year?.setProperties({ text: view.yearText });
    paintText(year, view.yearIsPast ? 'past' : 'primary');

    chips = yearChips(inputs());
    for (let i = 0; i < MAX_YEAR_CHIPS; i++) {
      const chip = chips[i];
      const root = host.el('bar', `year-chip-${i}`);
      const label = host.text('bar', `year-chip-label-${i}`);
      root?.setProperties({ display: chip ? 'flex' : 'none' });
      if (!chip) continue;
      label?.setProperties({ text: String(chip.year) });
      paintButton(root, label, chip.selected ? 'primary' : 'control');
    }
    host.el('bar', 'years-root')?.setProperties({ display: chips.length > 0 ? 'flex' : 'none' });

    const timeLabel = host.text('bar', 'time-btn-label');
    timeLabel?.setProperties({ text: view.timeButtonLabel });
    paintButton(host.el('bar', 'time-btn'), timeLabel, view.timeButtonEnabled ? 'primary' : 'disabled');

    for (const id of ['map-btn', 'portal-btn']) {
      const btn = host.el('bar', id);
      btn?.setProperties({ display: view.showNavButtons ? 'flex' : 'none' });
      paintButton(btn, host.text('bar', `${id}-label`), 'control');
    }
    if (navShown !== view.showNavButtons) {
      navShown = view.showNavButtons;
      host.resized('bar');
    }
  };

  host.control(host.el('bar', 'time-btn'), 'primary', () => {
    if (!deriveHud(inputs()).timeButtonEnabled) return;
    bus.emit('time:toggled', { on: !state.get().timeOn });
  });
  host.control(host.el('bar', 'map-btn'), 'default', () => bus.emit('mode:requested', { mode: 'table' }));
  host.control(host.el('bar', 'portal-btn'), 'default', () => bus.emit('mode:requested', { mode: 'portal' }));
  for (let i = 0; i < MAX_YEAR_CHIPS; i++) {
    host.control(host.el('bar', `year-chip-${i}`), 'dense', () => {
      const chip = chips[i];
      if (!chip) return;
      const action = yearChipAction(chip, state.get().timeOn);
      if (action.kind === 'toggleOff') {
        if (state.get().timeOn) bus.emit('time:toggled', { on: false });
        return;
      }
      if (action.openLens) bus.emit('time:toggled', { on: true });
      bus.emit('time:yearRequested', { year: action.year });
    });
  }

  return { refresh };
}
