/**
 * Colours and hover for UIKitML elements. The `.uikitml` files carry layout only; every
 * colour is applied here from `src/theme.ts` tokens, so a theme switch repaints everything
 * and no panel code ever names a colour.
 *
 * A panel paints an element by ROLE: `paintBox(el, 'control')`, `paintText(el, 'secondary')`.
 * The last role of each element is remembered, which lets a hover overlay sit on top of it
 * and lets `repaintAll()` redo every element after a theme change.
 */
import type { UIKitMLAsset } from '@iwsdk/core';
import {
  HOVER,
  HOVER_LIGHTEN,
  SHAPE,
  currentTokens,
  mix,
  opaque,
  withAlpha,
} from '../theme.js';
import type { HoverVariant, Tokens } from '../theme.js';

/** Any element of a UIKitML panel. */
export type El = NonNullable<ReturnType<UIKitMLAsset['getElementById']>>;

type Props = Record<string, string | number | undefined>;
const setProps = (el: El, props: Props): void =>
  (el as unknown as { setProperties(p: Props): void }).setProperties(props);

/** What a box (panel, button, row, key, chip, switch) is, which decides fill and border. */
export type Fill =
  | 'panel' // a panel backdrop
  | 'control' // a button, row, key or chip at rest
  | 'primary' // the main action, a selected chip or row, a switch that is on
  | 'disabled' // a control that does nothing right now
  | 'past' // the year pill while the lens shows a past year
  | 'notice' // a soft notice toast
  | 'danger' // an error toast
  | 'listening' // the mic while it listens
  | 'knobOn' // the knob of a switch that is on
  | 'knobOff'
  | 'ghost' // a subtle button with a surface fill but no border (chevron arrows)
  | 'none'; // no fill and no border (layout wrappers)

/** What a piece of text is. */
export type Ink = 'primary' | 'secondary' | 'onAccent' | 'past' | 'disabled' | 'muted';

interface BoxColours {
  backgroundColor: string;
  borderColor: string;
}

function boxColours(t: Readonly<Tokens>, fill: Fill): BoxColours {
  switch (fill) {
    case 'panel':
      return { backgroundColor: t.background, borderColor: t.border };
    case 'control':
      return { backgroundColor: t.surface, borderColor: t.border };
    case 'primary':
      return { backgroundColor: t.accent, borderColor: t.accent };
    case 'disabled':
      return { backgroundColor: withAlpha(t.surface, 0.45), borderColor: withAlpha(t.border, 0.45) };
    case 'past':
      return { backgroundColor: withAlpha(mix(t.surface, t.warning, 0.22), 0.7), borderColor: t.warning };
    case 'notice':
      // Dark theme glass behind grey text: readable over bright panos, still not a solid block.
      return { backgroundColor: withAlpha(opaque(t.background), 0.7), borderColor: t.warning };
    case 'danger':
      return { backgroundColor: withAlpha(mix(opaque(t.background), t.danger, 0.32), 0.75), borderColor: t.danger };
    case 'listening':
      return { backgroundColor: withAlpha(mix(t.surface, t.success, 0.35), 0.75), borderColor: t.success };
    case 'knobOn':
      return { backgroundColor: t.onAccent, borderColor: t.onAccent };
    case 'knobOff':
      return { backgroundColor: t.textSecondary, borderColor: t.textSecondary };
    case 'ghost':
      return { backgroundColor: t.surface, borderColor: withAlpha(t.border, 0) };
    case 'none':
      return { backgroundColor: withAlpha(t.background, 0), borderColor: withAlpha(t.border, 0) };
  }
}

function inkColour(t: Readonly<Tokens>, ink: Ink): string {
  switch (ink) {
    case 'primary':
      return t.textPrimary;
    case 'secondary':
      return t.textSecondary;
    case 'onAccent':
      return t.onAccent;
    case 'past':
      return t.textPrimary;
    case 'disabled':
      return withAlpha(t.textSecondary, 0.6);
    case 'muted':
      // Grey: light enough to read on the dark notice glass, still softer than primary.
      return withAlpha(t.textPrimary, 0.8);
  }
}

/** The text role that reads well on a box of the given fill. */
export function inkOn(fill: Fill): Ink {
  return fill === 'primary' ? 'onAccent' : fill === 'disabled' ? 'disabled' : 'primary';
}

interface BoxState {
  fill: Fill;
  variant: HoverVariant | null;
  hovered: boolean;
}

const boxes = new Map<El, BoxState>();
const inks = new Map<El, Ink>();

function renderBox(el: El, s: BoxState): void {
  const t = currentTokens();
  const c = boxColours(t, s.fill);
  const props: Props = {
    backgroundColor: c.backgroundColor,
    borderColor: c.borderColor,
    borderWidth:
      s.fill === 'none' || s.fill === 'panel' || s.fill === 'ghost' || s.fill === 'knobOn' || s.fill === 'knobOff' || s.fill === 'notice'
        ? 0
        : SHAPE.borderWidth,
  };
  let scale = 1;
  // A disabled control gives no hover feedback: it would promise an action that is not there.
  if (s.hovered && s.variant && s.fill !== 'disabled') {
    const spec = HOVER[s.variant];
    scale = spec.scale;
    if (spec.outline) {
      props.borderColor = t.hover;
      props.borderWidth = SHAPE.hoverBorderWidth;
    }
    // Only a resting control takes the hover fill; state colours (selected, past) stay readable.
    if (spec.fill === 'hoverFill' && s.fill === 'control') props.backgroundColor = t.hoverFill;
    else if (spec.fill === 'lighten') props.backgroundColor = mix(opaque(c.backgroundColor), t.textPrimary, HOVER_LIGHTEN);
  }
  if (s.variant) {
    props.transformScaleX = scale;
    props.transformScaleY = scale;
  }
  setProps(el, props);
}

/** Give a box its role colours. Safe to call every refresh; a hover in progress is kept. */
export function paintBox(el: El | null, fill: Fill): void {
  if (!el) return;
  let s = boxes.get(el);
  if (!s) {
    s = { fill, variant: null, hovered: false };
    boxes.set(el, s);
  } else {
    s.fill = fill;
  }
  renderBox(el, s);
}

/** Give a text element its role colour. */
export function paintText(el: El | null, ink: Ink): void {
  if (!el) return;
  inks.set(el, ink);
  setProps(el, { color: inkColour(currentTokens(), ink) });
}

/** Icon files in `public/assets/icons/`. White fills; the tint comes from `color`. */
export type IconName =
  | 'chevron-up'
  | 'chevron-down'
  | 'chevron-left'
  | 'chevron-right'
  | 'close'
  | 'backspace'
  | 'space'
  | 'search'
  | 'map'
  | 'portal'
  | 'clock'
  | 'history'
  | 'mic'
  | 'stop'
  | 'info'
  | 'dice';

const iconUrl = (name: IconName): string => `${import.meta.env.BASE_URL}assets/icons/${name}.svg`;
const icons = new Map<El, { name: IconName; ink: Ink }>();

/** Show an icon in a `<svg>` element, tinted like text of the given role. */
export function paintIcon(el: El | null, name: IconName, ink: Ink): void {
  if (!el) return;
  icons.set(el, { name, ink });
  setProps(el, { src: iconUrl(name), color: inkColour(currentTokens(), ink) });
}

/** Paint a button box and the icon inside it. */
export function paintIconButton(box: El | null, icon: El | null, name: IconName, fill: Fill): void {
  paintBox(box, fill);
  paintIcon(icon, name, inkOn(fill));
}

/** Paint a button and its label in one go. */
export function paintButton(box: El | null, label: El | null, fill: Fill): void {
  paintBox(box, fill);
  paintText(label, inkOn(fill));
}

/**
 * Make a box answer the pointer ray with the given hover variant (see `HOVER` in
 * `src/theme.ts`). Returns the function that removes the listeners.
 */
export function attachHover(el: El | null, variant: HoverVariant): () => void {
  if (!el) return () => {};
  let s = boxes.get(el);
  if (!s) {
    s = { fill: 'control', variant, hovered: false };
    boxes.set(el, s);
  } else {
    s.variant = variant;
  }
  const state = s;
  const enter = (): void => {
    state.hovered = true;
    renderBox(el, state);
  };
  const leave = (): void => {
    state.hovered = false;
    renderBox(el, state);
  };
  el.addEventListener('pointerenter', enter);
  el.addEventListener('pointerleave', leave);
  return () => {
    el.removeEventListener('pointerenter', enter);
    el.removeEventListener('pointerleave', leave);
  };
}

/** Redo every painted element with the current theme. */
export function repaintAll(): void {
  for (const [el, s] of boxes) renderBox(el, s);
  const t = currentTokens();
  for (const [el, ink] of inks) setProps(el, { color: inkColour(t, ink) });
  for (const [el, i] of icons) setProps(el, { color: inkColour(t, i.ink) });
}

/** Forget all elements (the HUD is being disposed). */
export function forgetStyles(): void {
  boxes.clear();
  inks.clear();
  icons.clear();
}
