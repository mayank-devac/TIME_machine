# Track C: time lens, wrist dial, push-through

Entry: `createTrack` in `entry.ts`. Everything here talks to the rest of the app only through
`src/contracts.ts` (the event bus, `PanoStage`, `PanoSource`).

## What it does

- **Time lens.** When TIME MACHINE is on, a circle on the lens hand shows another year. The
  "glass" is not a mesh: Track C writes `stage.lens` (direction, radius, feather, time,
  enabled) every frame and the stage shader draws the past inside that circle. Direction is
  from the head to the hand's grip pose (where the hand is, not where it points). On the flat
  desktop page it is the view ray through the mouse pointer.
- **Rim, shimmer, ripple.** `rim.ts` draws one extra mesh (one draw call): a thin band placed
  in the vertex shader at `lens radius + offset` from the lens axis, far away, so it lines up
  with the mask in both eyes at any radius. Slow gold shimmer; two rings travel outward while
  the lens opens, and the lens radius itself wobbles by at most `config.lens.maxDistortion`.
  It is additive glow only. Nothing in this folder warps the panorama.
- **Wrist dial.** Pinch (or hold the trigger) on the other hand and roll the wrist: every 25
  degrees is one stop, clockwise is later. The twist is measured about the direction that hand
  was pointing when the pinch began, so swinging the arm does not count. A small round face
  (`dial-visual.ts`) floats above the dial hand with the year and the stops either side.
  Either thumbstick flicked left or right also steps a year. Desktop: mouse wheel, arrow keys
  or `[` and `]`.
- **Year ladder.** The stops are only the years the imagery source returned for this spot,
  except the one on screen. No invented years. Dialling past the first or last stop does
  nothing and emits a recoverable `error` ("No earlier imagery here. Earliest is 2020."),
  at most once per 2 s, which the UI shows as a toast. `time:yearRequested` (the year panel)
  jumps the dial straight to a listed year.
- **Push-through.** Hold a pinch or the trigger on the lens hand (Space on desktop) for 300 ms
  and the lens grows to cover the whole view in `config.lens.pushThroughMs`; then
  `stage.commitPast()` runs and `time:committed` is emitted. Letting go early shrinks it back.
  It only starts once the past panorama for the dialled year has loaded.

## Events

Listens: `pano:shown`, `time:toggled`, `time:yearRequested`, `mode:changed`.
Emits: `time:yearsKnown` (after every `pano:shown`), `time:yearChanged`, `time:committed`,
`loading` (scope `time`), `error` (source `time`).

If a spot has one year only, the lens does not open; `time:yearsKnown` carries a single year
so Track G can show "no earlier imagery here".

## Rules it keeps

- **Camera.** Nothing here moves or rotates the camera or the player. Push-through changes a
  mask radius; the lens direction is frozen while it grows.
- **Textures.** It never creates a panorama texture. It asks the stage for one past panorama
  at a time (`loadPast`, newest request wins) and calls `clearPast` when the lens closes, so
  the count stays at two or fewer. The dial face is a 256 px canvas label, not a panorama.
- **Per frame.** No allocation in `TimeLensSystem.update` or `TimeMachine.frame`.

## Files

| File | What |
|---|---|
| `entry.ts` | Track entry; registers the system; DEV-only scenario hook |
| `system.ts` | `TimeLensSystem`: samples hands, controllers, mouse, keys once per frame |
| `time-machine.ts` | Glue between the state machine, the bus and the stage |
| `machine.ts` | `LensMachine`: pure state machine (off, opening, open, dialling, pushing, closing) |
| `years.ts`, `curves.ts`, `dial.ts`, `lens-math.ts` | Pure maths, covered by vitest |
| `rim.ts`, `dial-visual.ts` | The two visible objects |
| `constants.ts` | Tuning not in `src/config.ts` (all untested on a headset) |
| `dev-scenario.ts` | DEV driver, off by default |
| `evidence/` | Emulator screenshots |

`TimeLensTag` marks three entities for ECS tools: the rim (`slot` = phase, `value` = year),
a probe (`slot: 'textures'`, `value` = highest texture count seen) and the dial
(`slot: 'dial'`).

## Trying it alone

Set `DEV_SCENARIO` in `dev-scenario.ts` to `'fixture-keys'`, run `npm run dev`. It opens the
fixture spot and switches TIME MACHINE on; `T` toggles it. Phase changes are logged as
`[time] ...`. Set it back to `''` before committing.

## Verified, and how

Against the Phase 0 mocks (`MockPanoStage`, `MockPanoSource`, two fixture years) in the IWER
emulator and on the flat page. Screenshots are in `evidence/`.

| Claim | Evidence |
|---|---|
| Lens shows the other year inside the circle only, and follows the controller | Seen in the emulator (`xr-01`) |
| Lens follows the mouse on desktop | Seen (`desktop-02`, and a second position not saved) |
| Dial: trigger + roll changes the year, both directions; dial face shows it | Seen in the emulator with controllers and with emulated hands (`xr-02`, `xr-05`), plus `time:yearChanged` in the log |
| Push-through grows the lens, then the past is the whole view | Seen (`xr-03`, `xr-04`); `time:committed` logged; texture count 1 after, never above 2 across five commits |
| Early release retracts | Log only (`pushing -> open`) |
| TIME MACHINE off closes the lens and frees the past texture | Log only (`closing -> off`, textures 1) |
| Year ladder, curves, twist maths, state machine | Tests only (35 vitest cases in this folder) |

Not verified:

- Anything on a real headset. See below.
- The real stage (Track B) and real Mapillary data (Track A): only the mocks were used. The
  "magic" edge distortion of the panorama, if wanted, belongs in Track B's shader.
- Heading alignment between years (a landmark staying put inside and outside the rim): that
  is the stage's job and was not judged here.
- Portal mode: the rim copies `stage.stencilRef`, but it was never run with a stencil.
- Thumbstick year stepping: written, not exercised.
- A spot with one year only: covered by the state-machine tests, not seen running.

## Unknown without a headset

- Whether 25 degrees per stop feels right, and whether real pinch noise makes the dial skip
  or drop a hold. The emulator's pinch is clean.
- Whether the twist axis is good for tracked hands. The emulator rolled the hand about its
  pointing ray; a real wrist roll may be off that axis and register as less twist.
- Which way a real grip pose points, so whether the lens sits exactly on the hand.
- Lens size (`config.lens.defaultRadius`), rim brightness, shimmer and ripple comfort.
- Whether 1.6 s of the past growing across the whole view is comfortable.
- Dial face size, placement above the hand and legibility at headset resolution.
- Frame rate and memory with real 4096 and 5760 px panoramas.
- Left-handed use: lens on the right hand and dial on the left are fixed in `constants.ts`.
