---
name: xr-glass-design
description: The visual design system for Street View Time Machine - translucent "glass" surfaces, the colour tokens, type, radii, and per-surface recipes for UIKitML panels, the 2D landing card, canvas-drawn labels, the map table and the archive frames. Use this whenever you add or restyle any UI, label, panel, button, frame or colour in this project, so everything keeps one minimal, translucent, modern look.
---

# XR glass design system

One idea: **quiet frosted glass floating over the street view**. Surfaces are see-through,
borders are hairlines, type is light, colour is used only as a small accent.

## Tokens

| Token | Value | Use |
|---|---|---|
| `glass` | `#ffffff1f` | default surface (alpha 12%) |
| `glass-strong` | `#0f121cb3` | text-heavy surface: credits, cards (alpha 70%) |
| `glass-dim` | `#0f121c99` | status and toasts (alpha 60%) |
| `hairline` | `#ffffff38` | 0.3 border on every glass surface |
| `text` | `#ffffff` | primary text |
| `text-soft` | `#ffffffcc` | secondary text |
| `text-faint` | `#ffffff66` | disabled, hints |
| `accent` (violet) | `#7c6cff` | primary action; tint at `59` alpha |
| `accent-2` (mint) | `#2ee6d6` | portal, coverage lines, hover; tint at `33` alpha |
| `warm` (amber) | `#ffb84d` | notices, past years; tint at `59`/`40` alpha |
| `pink` | `#ff5fb5` | "back to now"; map pick ring |
| `danger` | `#ff5a5a` | errors; tint at `66` alpha |

Colours with an alpha byte are 8-digit hex (`#rrggbbaa`). In canvas and CSS use the same hex or `rgba()`.

## Shape and type

- Radius: pill or near-pill. UIKit panels: radius = height / 2 (buttons) or 4-5 (wide bars).
- Border: 0.3 UIKit units (1px on the web), `hairline` colour, always present.
- No drop shadows in XR. On the web card only: `box-shadow: 0 8px 32px rgba(0,0,0,.35)` and `backdrop-filter: blur(16px)`.
- Font: system sans, weights light (300) for big numbers, medium (500) for labels, never bold-heavy.
- UIKit sizes (cm): labels 3.2-3.6, year 9, credits 2.8. Uppercase labels get letter spacing on the web.
- Spacing: multiples of 2 (UIKit) / 4 (web px).

## Recipes

- **UIKitML panel** (`public/ui/*.uikitml`): `background-color` glass tint, `border-color: hairline`, `border-width: 0.3`, light type. State changes in `src/ui/entry.ts` `COLORS` must stay translucent 8-digit hex.
- **Primary action**: violet tint `#7c6cff59`. **Secondary**: `glass`. **Portal**: mint tint `#2ee6d633` with `#7ff5ea99` border.
- **Web landing card** (`src/map/landing.ts`): `rgba(15,18,28,.62)` + blur, hairline border, 16px radius, violet primary buttons, mint focus ring.
- **Canvas labels** (portal buttons, table strips): translucent fill, hairline stroke, 600 weight text, rounded rect.
- **Map table**: dark glass slab, mint coverage lines, violet place markers, pink pick ring.
- **Archive frames**: dark glass card, white year in light weight, soft text caption. No paper or serif look.

## Rules

- Never an opaque coloured block. If a surface must be readable over bright imagery use `glass-strong`, not a solid.
- Accent colour covers at most a button or a line, never a whole panel.
- Attribution text stays legible: `text-soft` on `glass-strong`.
- Comfort rules still win: nothing moves smoothly around the viewer; panels hard-snap.
