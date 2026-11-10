# Phase 0 spike results (2026-11-10)

Evidence levels: **Seen** = I ran it and looked at the output or a screenshot (emulator or
browser). **Read** = from docs or HTTP headers only. **Not proven** = say so.

Spike code: `src/spikes/spike.ts`, selected by `src/spikes/active.ts` (empty string = off).
The managed browser cannot navigate to a query URL, so edit `active.ts` and reload.

## 1. Mapillary panorama as a WebGL texture — PASSED (Seen)

- Token works: radius search at Times Square (50 m) returned 50 images, 34 panoramas, from
  2022, 2023 and 2025.
- Image CDN (`scontent…fbcdn.net`) sends `access-control-allow-origin: *`. A CORS-mode
  `fetch()` of `thumb_original_url` succeeded (3.3 MB for a 7680×3840 image, 1.4–2.5 s).
- `createImageBitmap(blob, {resizeWidth})` decoded 7680×3840 in about 60 ms. Rendered on the
  stage sphere in the emulator (screenshot: Times Square, readable signs).
- GPU `MAX_TEXTURE_SIZE` on this Mac is 16384. **Quest value is not known.**
- **URLs expire.** The `oe` query parameter is a hex Unix time, about 30 days ahead. Never
  store URLs. `spots.json` stores ids; call `PanoSource.resolve(id)`.
- `camera_type` for panoramas is `"spherical"`, not `"equirectangular"`. Filter on `is_pano`.
- Panorama sizes seen: 5760×2880 and 7680×3840.
- People's faces are blurred by Mapillary.
- Tile endpoint also sends `access-control-allow-origin: *`. OpenFreeMap style, Photon and
  Wikimedia Commons (`origin=*`) all allow cross-origin requests (Read, HTTP headers).
- Rate limits (Read from the API docs): entity 60,000/min, search 10,000/min,
  **tiles 50,000/day**. Tiles are the tight one: a map redraw fetches many tiles.
- Licence wording for imagery: **not found on the API page. Not proven.** Credit
  "© Mapillary" plus the creator's username until confirmed.

## 2. MapLibre drawing into a canvas texture — PARTLY PROVEN

- Seen (by the user, in a normal visible Chrome window, not in XR): OpenFreeMap "liberty"
  style drawn into a 2048² MapLibre canvas, used as a `CanvasTexture` on a 0.9 m plane at
  table height, with Mapillary `sequence` coverage lines (green, `is_pano == true`) over it.
- Pitfall found: MapLibre sizes its canvas from `container.clientWidth/Height`. In the
  managed browser's app tab the window reports 0×0, so the canvas came out 400×300.
  Fix that worked: pin the size with
  `Object.defineProperty(holder, 'clientWidth', { get: () => size })` (same for height).
  Do this in production too; layout on a headset is not something to trust.
- The warning "Image X could not be loaded" is the style's POI sprite icons; harmless.
- **Not proven: redrawing while an XR session runs.** In the managed (hidden-window) tab the
  style never finished loading, so `xrFrames` stayed 0 and no redraw happened in a session.
  Window `requestAnimationFrame` is expected to stop on a real headset during an immersive
  session. Planned fix, unverified: call `map.redraw()` from `world.onXRFrame` when the map
  is dirty, then set `texture.needsUpdate`.
  **Track D must prove this first** (inside an emulated session, with a screenshot taken
  after a pan). If it fails, the fallback in the plan applies: the map lives on the 2D
  landing page only and VR gets the curated list.

## 3. AR session with an opaque sphere in IWER — PASSED (Seen)

- `xr_accept_session` gave `sessionMode: immersive-ar`, features `local-floor`,
  `bounded-floor`, `hand-tracking`, device Meta Quest 3 (emulated).
- The inside-out sphere (`depthWrite: false`, `renderOrder: -1000`) completely replaced the
  emulated living room, and the emulated hands drew over it. Screenshot taken.
- So "one AR session, full VR = opaque sphere" works in the emulator. Whether Quest Browser
  composites it identically is **not proven**.

## Other findings worth keeping

- **Entities:** `world.createTransformEntity(obj)` parents to the active level and tags it
  with `LevelTag`. App content (stage, map, portal, HUD) is not level-authored, so use
  `createTransformEntity(obj, { persistent: true })`.
- **Fixture JSON** must be imported from `src/`, not `public/` (dev server refuses; the
  production build allows it). Images stay in `public/dev/`.
- Editing a source file while the managed browser is open triggers a late full reload that
  ends any XR session. Make all edits first, then reload, then enter XR.
- `xr_look_at` (target in metres) aims the emulated headset; the emulated head is at y 1.6.
- A screenshot taken straight after a reload is black until the pano finishes loading.
- Direction convention chosen for the stage shader (needs proving with the fixtures, Track B):
  `u = 0.5 + (azimuth - heading) / 2π`, `azimuth = atan(d.x, -d.z)`, north is -Z, east +X.
