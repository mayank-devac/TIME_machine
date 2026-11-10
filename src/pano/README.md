# Track B: pano stage

The production `PanoStage` (see `src/contracts.ts`). Entry: `createPanoStage(world, bus, source?)`
in `entry.ts`.

## Files

| File | What it does |
|---|---|
| `stage.ts` | `ProductionPanoStage`: one inside-out sphere centred on each eye, current + past texture, lens uniforms, fades, stencil, hop arrows. |
| `stage-shader.ts` | Sphere shader. Samples by view direction; lens mask, rim shimmer, fade multiplier. |
| `lifecycle.ts` | Texture ledger (max-two counter), latest-only load cancellation, fader, off-thread decode (`createImageBitmap` with resize). No Three.js, unit-tested. |
| `pano-math.ts` | Heading/uv maths, texture size caps, bearings, arrow target selection. Unit-tested. |
| `arrows.ts` | Pool of up to 4 floor chevrons toward `PanoSource.neighbours`, selectable with `RayInteractable`. |
| `dev-flag.ts`, `dev-harness.ts` | Dev-only keyboard harness. `PANO_DEV_HARNESS` must be `false` when committed. |

## Rules it keeps

- **Render order.** Sphere `renderOrder = -1000`, `depthWrite: false`. Track E's portal mask
  draws first at -2000. The stencil test is enabled only while `stencilRef !== null`
  (equal-to-ref, write mask 0), the same as the mock stage fix in main.
- **Alignment.** `azimuth = atan(d.x, -d.z)` (clockwise from north, north = -Z),
  `u = fract(0.5 + (azimuth - heading)/2pi)`, `v = 0.5 - asin(d.y)/pi` (bitmaps upload
  top row first). Rotation is about the vertical axis only, so the horizon stays level.
  Checked against the two Times Square fixtures: the Marriott Marquis towers measure at
  about 304 deg (2023) and 330 deg (2025); the map predicts about 294 and 313 from the two
  capture points 25 m apart, so the sign and zero are right and the residue is parallax.
  The opposite sign would put them at 102 and 267.
- **Memory.** Every panorama texture goes through `TextureLedger` (cap
  `config.texture.maxLive` = 2). On every swap the old texture is taken out of the uniform,
  disposed and its bitmap closed **before** the new one is created. Decode sizes come from
  `config.texture` (current: desktop/headset cap; past: lens cap; preview: 2048) and never
  exceed `renderer.capabilities.maxTextureSize`. No mipmaps.
- **Hops.** `show()` fades to black (`config.hop.fadeOutMs`), switches, fades in. It loads
  the 2048 preview and the capped full image in parallel; the first to arrive goes on screen,
  the full image replaces the preview later with no fade. A newer `show` aborts the older
  one's fetches. The camera is never moved.
- **Past.** `loadPast` decodes at the lens cap; `commitPast` swaps it in and then quietly
  reloads it at the current cap. Entering an XR session also refits to the headset cap.
- **Arrows.** Shown only in `street` mode, not mid-hop. Placed 1.6 m from the viewer on the
  floor at the great-circle bearing to each neighbour, at most 4, at least 35 deg apart.

## Change request (orchestrator)

`index.ts` should call `createPanoStage(world, bus, source)` so the arrows share Track A's
cache and request throttle. Without it the stage creates its own `PanoSource`.

## Dev harness

Set `PANO_DEV_HARNESS = true` in `dev-flag.ts`, run the dev server, and press keys in the app
tab: `1`/`2` show a fixture year, `h` 20 hops with texture counts, `b` a hop that holds black
for 4 s, `l` lens toggle, `c` commit, `t`/`s` table/street, `r` report. Results are logged
as `PANO ...` lines. It is stripped from production builds.
