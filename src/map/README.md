# Track D — map table and landing page

Entry: `createTrack` in `entry.ts`. It returns a `Track` that also implements `MapTable`
(`show`, `hide`, `flyTo`).

## What it does

- **Table map** (`table.ts`): MapLibre draws the OpenFreeMap "liberty" style into an
  offscreen 2048 px canvas (`config.map.canvasPx`). The canvas is a `CanvasTexture` on a
  0.9 m plane at 0.85 m height, 0.62 m in front of the player (north = far edge). Credit
  strip on the rim: "© OpenStreetMap contributors · OpenFreeMap · Coverage © Mapillary".
- **Coverage layer**: Mapillary vector tiles, `sequence` layer, filtered to
  `is_pano == true`, drawn teal under the labels. Curated spots are violet dots with labels.
  No token means no coverage layer and an `error` event.
- **Map style** (`style.ts`): base raster map, coverage, buildings, spot and pick layers.
- **Input** goes through IWSDK pointer events on a `RayInteractable` surface, so the desktop
  mouse, controller rays (trigger) and hand rays (pinch) share one code path. Presses are
  classified by `TableGestures` (`gestures.ts`, pure, tested in `gestures.test.ts`); the
  thresholds are the constants there (`TAP_TRAVEL_M`, `TAP_MAX_MS`, `PINCH_DEADZONE`,
  `STALE_POINTER_MS`):
  - one pointer moved past the tap slop (measured from the press point, not path length):
    pan. Inside the slop the map does not move at all;
  - released inside the slop and quickly enough: pick. The pick snaps to the nearest teal
    line within 48 canvas px, drops the pin and emits `spot:selected`, which enters street view
    there. The table does not move while the street loads; the map entry recentres it on
    every `pano:shown`, so it shows where the player is on return; a miss emits a
    recoverable `error` ("No 360° imagery there. Tap a glowing street.");
  - two pointers pressed: pinch. The midpoint pans; zoom follows the spread (double = +1)
    once it has changed past the dead zone. A sequence that had two pointers never picks.
    A held pointer silent for `STALE_POINTER_MS` is dropped when another goes down (a
    workaround, see `docs/untested-on-device.md`);
  - mouse wheel: zoom around the pointer; right thumbstick up/down: zoom.
  - Zoom is clamped to 12–18 (below 12 a 0.9 m table pulls too many tiles for the quota).
- **Redraw** (`redraw.ts`): `map.redraw()` is called from the surface mesh's
  `onBeforeRender`, i.e. from the IWSDK render loop, so it does not depend on the page's
  `requestAnimationFrame`. Redraws happen only when the view changed or data arrived
  (≤ 30/s), plus every 150 ms while tiles are loading, and stop after 3 s with no new data.
  `flyTo` is a jump, not an animation, so it does not fetch tiles for every in-between view.
  MapLibre's container has `clientWidth/Height` pinned (the managed tab reports 0×0).
- **Landing page** (`landing.ts`, `photon.ts`): a 2D DOM card with the
  curated list from `PanoSource.spots()`. Clicking a name shows the place on the table;
  "Street view" emits `spot:selected`. The card is hidden while an XR session runs or the
  mode is not `table`. It carries the full credit line (OSM, OpenFreeMap, Mapillary).
- Pure maths (projection, pan, zoom-around, pinch, snap) is in `geo.ts`.

## Is redrawing during an XR session proven?

**Yes in the IWER emulator (Seen), not on a headset.** So the fallback (landing-page-only
map) was not needed. Evidence, 2026-11-10, headless managed browser, emulated Quest 3,
immersive-ar session (`DEV_TRACE` and `DEV_SCRIPT` on):

- Before the pan, in session: `redraws 714, selfUploads 24, fp 56d5557a`.
  `screenshots/xr-before-pan.png`.
- `panPixels(500, 300)` issued in session; 3 s later: `redraws 740, selfUploads 24,
  fp eab55436`, and `screenshots/xr-after-pan.png` shows the map moved (Times Square dot
  moved right and down, the Hudson came into view). Every frame in the session reached the
  texture through our scheduled `redraw()`; MapLibre's own frames (`selfUploads`) stayed flat.
- Caveat: in IWER the window `requestAnimationFrame` kept running during the session
  (counter kept rising), so the emulator cannot reproduce a headset that stops it. The code
  does not rely on it, but that is reasoning, not observation.
- Real input in session, emulated controllers: a right-controller ray tap on the table
  picked canvas px (1524, 1324), snapped to (1521, 1326) on a coverage line, emitted
  `spot:selected` {40.75800, -73.98559}, and the flow switched to `street` (mock pano shown).
  A ray drag of 347 px panned the view east as expected. Two controllers spread from 0.1 m
  to 0.3 m apart zoomed 15 → 16.56 (log2 3 = 1.58). An emulated hand pinch reached the same
  pick path (it missed a line and the miss toast event fired).
- Landing page (2D, no session): "Times Square" and "Eiffel Tower" searches returned Photon
  results (`screenshots/landing-search.png`); "Street view" on the Eiffel result emitted
  `spot:selected` {48.85826, 2.29450, label}.

Environment note: in the managed headless Chromium, requests to `tiles.openfreemap.org`
were very slow or aborted (a 690 KB z14 Manhattan tile took 97–127 s, others failed with
`net::ERR_ABORTED`), while `curl` fetched the same tile in about 1.4 s. So base-map tiles
fill in slowly in those screenshots; Mapillary coverage tiles and Photon were quick. Not a
code fault as far as I can tell, but worth a look on real hardware and a real network.

## Running the evidence again

1. Set `DEV_TRACE = true` and `DEV_SCRIPT = true` in `entry.ts` (both **false** when
   committed). Logs are tagged `MAPTRACK`; `window.__map` holds `{ table, landing }`.
2. `npx @iwsdk/cli dev up --headless`, wait for `browserCommandReady`, `xr enter`,
   `xr look-at` the headset at `{x:0, y:0.85, z:-0.62}`.
3. Read `npx @iwsdk/cli browser logs --count 200` for `xr-before-pan` / `xr-after-pan`.
4. Controller tap: `xr look-at` `controller-right` at a table point, then `xr select`.
   Drag: `xr set-select-value 1`, several `look-at`s, `set-select-value 0`.
   Table point to canvas px: `px = (x / 0.9 + 0.5) * 2048`, `py = (0.5 + (z + 0.62) / 0.9) * 2048`.

## Tests

`geo.test.ts`, `redraw.test.ts`, `photon.test.ts` (vitest, node): projection round-trip,
north-up, pan keeps the grabbed point under the pointer, zoom-around keeps the anchor,
pinch and wheel zoom, snap to polylines, tap vs drag, redraw throttling, Photon parsing,
debounce, abort of stale searches, error retry.

## Not verified (headset only)

- That a real Quest Browser keeps calling `onBeforeRender` (it should; it is the XR frame
  loop) and that window `requestAnimationFrame` stopping does not stall MapLibre's tile
  pipeline (workers and fetches do not need it, but placement/symbol fade might).
- Cost of re-uploading a 2048² texture up to 30 times a second while panning: frame time
  on Quest is unknown. If it drops frames, lower `canvasPx` or the active redraw rate.
- Text legibility of the map labels and the rim strips at headset resolution.
- How a hand-tracked pinch drag feels: real pinch rays are noisy; the tap threshold
  (1 % of the canvas, 700 ms) and the 48 px snap radius are guesses.
- Two-hand zoom with real hands (only two emulated controllers were tested).
- Whether the table height (0.85 m) and distance (0.62 m) are comfortable for a seated or
  standing user; the table does not follow the user.
- OpenFreeMap tile download speed on Quest over Wi-Fi.
