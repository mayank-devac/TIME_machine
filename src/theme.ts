/**
 * The palette (black/white with green accents) and the hover rules. Orchestrator-owned.
 *
 * This is the ONLY file that may contain a colour literal. Every surface (UIKitML panels, the
 * DOM landing card, canvas-drawn labels, meshes, shaders, MapLibre layers) reads its colours
 * from `currentTokens()` and repaints on `onThemeChange`. `theme.test.ts` fails the build if a
 * colour literal appears anywhere else in `src/` or `public/ui/`.
 *
 * Pure: no Three.js, no DOM, so it runs under vitest and can be imported from anywhere.
 */

export type ThemeName = 'dark' | 'light';

export interface Tokens {
  /** Panel backdrops, landing card, archive card, dial face, toast. Slightly see-through. */
  background: string;
  /** Raised controls: buttons, list rows, keys, chips, input box, switch track when off. */
  surface: string;
  /** Hairline on every panel and control; table slab edge; portal frame. */
  border: string;
  /** Labels, the year, titles. */
  textPrimary: string;
  /** Captions, hints, credits, placeholders, disabled labels. */
  textSecondary: string;
  /** Primary action fill, selected chip or row, switch on, pick ring, curated spot markers. */
  accent: string;
  /** Text and icons drawn on `accent`. */
  onAccent: string;
  /** Coverage lines ("imagery here"), mic listening, confirmations. */
  success: string;
  /** Anything about the past: year pill, lens rim, dial ring, archive year; soft notices. */
  warning: string;
  /** Error toast, error text. */
  danger: string;
  /** Hover outline on every control; hop-arrow hover. */
  hover: string;
  /** Hover fill for controls that must not change size. */
  hoverFill: string;
}

export type TokenName = keyof Tokens;

const DARK: Tokens = {
  background: '#2A382AB8',
  surface: '#4A634A99',
  border: '#6FA66B',
  textPrimary: '#FFFFFF',
  textSecondary: '#FFFFFF',
  accent: '#7BFF73',
  onAccent: '#000000',
  success: '#5FE058',
  warning: '#FFD35C',
  danger: '#FF7A88',
  hover: '#D9FFD6',
  hoverFill: '#3F6B3B',
};

const LIGHT: Tokens = {
  background: '#FFFFFFA6',
  surface: '#F6FCF5B3',
  border: '#B6DCB3',
  textPrimary: '#000000',
  textSecondary: '#000000',
  accent: '#18A711',
  onAccent: '#000000',
  success: '#43C33C',
  warning: '#A35F00',
  danger: '#C92A3A',
  hover: '#1B7416',
  hoverFill: '#D7F0D5',
};

const THEMES: Record<ThemeName, Tokens> = { dark: DARK, light: LIGHT };

export function tokens(name: ThemeName): Readonly<Tokens> {
  return THEMES[name];
}

// ---------------------------------------------------------------------------------------------
// Active theme
// ---------------------------------------------------------------------------------------------

export type ThemeListener = (t: Readonly<Tokens>, name: ThemeName) => void;

let active: ThemeName = 'dark';
const listeners = new Set<ThemeListener>();

export function currentTheme(): ThemeName {
  return active;
}

export function currentTokens(): Readonly<Tokens> {
  return THEMES[active];
}

/** Switch theme. Listeners run synchronously; one throwing never blocks the rest. */
export function setTheme(name: ThemeName): void {
  if (name === active) return;
  active = name;
  for (const fn of [...listeners]) {
    try {
      fn(THEMES[active], active);
    } catch (err) {
      console.error('[theme] listener threw', err);
    }
  }
}

/** Run `fn` on every theme change. Returns the unsubscribe function. */
export function onThemeChange(fn: ThemeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---------------------------------------------------------------------------------------------
// Colour helpers (derive, never invent)
// ---------------------------------------------------------------------------------------------

const channel = (hex: string, i: number): number => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);

/** `#RRGGBB[AA]` to the 0xRRGGBB number Three.js colours take. */
export function hexNumber(hex: string): number {
  return parseInt(hex.slice(1, 7), 16);
}

/** Alpha of a `#RRGGBB[AA]` colour, 0 to 1 (1 when it has no alpha byte). */
export function hexAlpha(hex: string): number {
  return hex.length >= 9 ? channel(hex, 3) / 255 : 1;
}

/** `#RRGGBB` without any alpha byte (MapLibre paint properties take opacity separately). */
export function opaque(hex: string): string {
  return hex.slice(0, 7);
}

/** The colour with a new alpha (0 to 1), as `#RRGGBBAA`. */
export function withAlpha(hex: string, alpha: number): string {
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 255);
  return `${hex.slice(0, 7)}${a.toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Linear mix of two colours' RGB (t = 0 gives `a`, 1 gives `b`), as `#RRGGBB`. */
export function mix(a: string, b: string, t: number): string {
  const k = Math.min(1, Math.max(0, t));
  let out = '#';
  for (let i = 0; i < 3; i++) {
    const v = Math.round(channel(a, i) + (channel(b, i) - channel(a, i)) * k);
    out += v.toString(16).padStart(2, '0').toUpperCase();
  }
  return out;
}

/** WCAG relative luminance of a colour, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const lin = (i: number): number => {
    const c = channel(hex, i) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2);
}

/** WCAG contrast ratio between two colours (alpha ignored), 1 to 21. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CSS custom properties for the DOM landing card: `--tm-background: ...;` and so on. */
export function cssVars(t: Readonly<Tokens>): string {
  const kebab = (s: string): string => s.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`);
  return (Object.keys(t) as TokenName[]).map((k) => `--tm-${kebab(k)}:${t[k]}`).join(';');
}

// ---------------------------------------------------------------------------------------------
// Shape and type scale. UIKit units are centimetres.
// ---------------------------------------------------------------------------------------------

export const SHAPE = {
  borderWidth: 0.3,
  hoverBorderWidth: 0.5,
  panelRadius: 4,
  font: { title: 2.8, label: 3.2, small: 2.6, year: 9 },
  /** Spacing steps. */
  gap: 2,
} as const;

// ---------------------------------------------------------------------------------------------
// Hover
// ---------------------------------------------------------------------------------------------

/**
 * Pointer-ray hover. The default is a slight scale-up plus a thin outline in `hover`.
 * A control gets another variant only where the default would break its job:
 *
 *  default  street-bar buttons, PREV/NEXT, mic, clear, gear, collapse chevron.
 *  primary  TIME MACHINE, STEP IN, ENTER: the main action answers a little more (bigger
 *           scale, fill lightened).
 *  dense    keyboard keys, year chips: neighbours sit 1 cm apart, so no scale (it would
 *           overlap them); outline plus `hoverFill` instead.
 *  row      place rows, search results: full-width rows would poke out of the panel, so no
 *           scale; outline plus `hoverFill`.
 *  toggle   settings switches: outline only, because the fill colour carries on/off.
 *  grip     drag grips, zoom-rail knob, portal resize handle: bigger scale and `accent`
 *           fill, to say "this moves".
 *  world    hop arrows, portal mesh buttons: meshes with no border to outline; scale plus a
 *           tint (and an outline plane where the mesh has one).
 */
export type HoverVariant = 'default' | 'primary' | 'dense' | 'row' | 'toggle' | 'grip' | 'world';

export interface HoverSpec {
  /** Uniform scale while hovered (1 = none). */
  scale: number;
  /** Draw the thin outline in `hover`. */
  outline: boolean;
  /** What the fill becomes while hovered. */
  fill: 'keep' | 'hoverFill' | 'accent' | 'lighten' | 'hover';
}

export const HOVER: Readonly<Record<HoverVariant, HoverSpec>> = {
  default: { scale: 1.04, outline: true, fill: 'keep' },
  primary: { scale: 1.06, outline: true, fill: 'lighten' },
  dense: { scale: 1, outline: true, fill: 'hoverFill' },
  row: { scale: 1, outline: true, fill: 'hoverFill' },
  toggle: { scale: 1, outline: true, fill: 'keep' },
  grip: { scale: 1.1, outline: false, fill: 'accent' },
  world: { scale: 1.08, outline: true, fill: 'hover' },
};

/** How far `lighten` moves a fill toward the primary text colour. */
export const HOVER_LIGHTEN = 0.18;

export function isHoverVariant(v: string): v is HoverVariant {
  return v in HOVER;
}
