# Street View Time Machine

A WebXR app built with [IWSDK](https://iwsdk.dev). Stand at a street spot and
travel through its past: 360° panoramas are fetched from
[Mapillary](https://www.mapillary.com), placed on an immersive sphere, and a
wristside time dial lets you hop between the years that spot was captured. In AR
you can open a portal and step through it; in desktop mode a 3D map table does
the same job with mouse input.

## Run it

```sh
npm install
npm run dev
```

`npm run dev` starts the CLI-managed Vite server and a managed browser. Use the
Runtime / Editor toggle in that window to switch between the running experience
and the authored scene; IWER (the in-browser XR emulator) boots as a Meta Quest 3
in a sunlit living room per `iwsdk.config.json`.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run dev` | Managed dev server + browser (the normal loop) |
| `npm run dev:runtime` | Plain `vite` without the managed browser |
| `npm run dev:down` / `dev:status` | Stop / inspect the managed server |
| `npm run typecheck` | `tsc --noEmit` — run before testing anything |
| `npm run build` / `preview` | Production build / serve it |
| `npm test` | Vitest suites (per-track logic tests) |
| `npm run reference:status` / `reference:warmup` | Check / warm the `@iwsdk/reference` docs index |

## How it works

`iwsdk.config.json` is the project authority: it selects
`public/scenes/main.iwsdk.scene.json`, the asset and component modules, AR mode
with hand tracking, Horizon spatial UI, and emulator defaults.
`src/index.ts` creates the `World` from the virtual project options, then wires
the app as six tracks around an EventBus (`src/contracts.ts`):

| Track | Job |
| --- | --- |
| `src/data` | `PanoSource` — Mapillary client with year grouping, throttling, caching; falls back to a mock without `VITE_MAPILLARY_TOKEN` |
| `src/pano` | The pano sphere, shader stage, load/dispose lifecycle, street arrows |
| `src/map` | 3D map table (MapLibre), spot search, the landing/search UI |
| `src/time` | The time dial, year ribbon, lens and push-through time travel |
| `src/portal` | The AR portal you grab and step through |
| `src/archive` | Archive windows into past imagery |
| `src/ui` | HUD panels, search logic, voice |

`src/flow.ts` is the orchestrator glue: a map pick resolves the nearest pano and
turns the mode change; tracks only emit/observe events, never call each other.

## Setup

- Node ≥ 20.19 (see `engines` in `package.json`).
- Mapillary token in `.env.local` as `VITE_MAPILLARY_TOKEN`. Without it the app
  still starts on mock data.
- Curated spots live in `src/data/spots.json` with 3+ capture years each;
  regenerate with `node src/data/build-spots.mjs`.

Per-track details sit in `src/<track>/README.md`, and `AGENTS.md` documents the
IWSDK conventions this repo follows (ECS components, asset manifest contract,
testing workflow).

## Testing on a headset

Run `npm run dev`, then open a URL from `data.runtimeUrls.network` (`npm run
dev:status`) on a headset on the same Wi-Fi network and accept the local
certificate warning. See
[testing your experience](https://iwsdk.dev/guides/02-testing-experience.html)
for the complete workflow, and the IWER
[emulator controls](https://iwsdk.dev/guides/02-testing-experience.html#iwer-controls)
for desktop keys.

## Links

- [Minimal scene walkthrough](https://iwsdk.dev/guides/01b-minimal-scene.html)
- [IWSDK guides](https://iwsdk.dev/guides/)
