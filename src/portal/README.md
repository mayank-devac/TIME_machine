# Track E: passthrough portal

A framed window stands in your real room and shows the street through it. Everywhere else
you see the room (passthrough; the IWER emulator shows its living room). Grab the frame to
move it. Step through it, push a hand through it, or press STEP IN (or the glass) to enter
the street fully. BACK TO ROOM returns to the table.

## How it works

- **Stencil mask.** The stage sphere draws only where the stencil buffer equals
  `stage.stencilRef`. The window's invisible "glass" plane (`colorWrite: false`,
  `depthWrite: false`, `stencilFunc: Always`, `stencilZPass: Replace`,
  `stencilRef = config.portal.stencilRef`) is drawn first (`renderOrder -2000`, the sphere is
  `-1000`), so the street appears only inside the opening. The sphere still samples by view
  direction, so the street reads as infinitely far away through the window.
- **Mode.** `PortalFlow` listens to `mode:changed`. In `portal` it sets
  `stage.stencilRef = config.portal.stencilRef`, calls `stage.setVisible(true)` and places the
  window 1.3 m in front of the head (centre 15 cm below eye level, facing you). In any other
  mode it sets `stage.stencilRef = null` and hides the window. It emits at most one
  `mode:requested` at a time (`street` to enter, `table` to exit, `portal` from `open()`),
  and a refused request lapses after 1.5 s so it never sticks.
- **Always facing.** While the window is open, `PortalSystem` yaws it toward the head every
  frame (upright, position untouched), so it never sits edge-on. It is left alone while held.
- **Step / push through.** `PortalSystem` tracks the head and both index tips (controllers
  fall back to their ray pose) with `CrossingDetector`: the point must start clearly on the
  room side and end clearly on the street side, and the crossing must pass through the
  opening (inset from the frame). Walking around the frame does not count. Crossings are
  ignored while the frame is held, and detectors re-arm after a move.
- **Grab.** The frame has `DistanceGrabbable` (`MoveFromTarget`, translate only, no rotate or
  scale) plus `RayInteractable`: point at the frame and hold the trigger. The glass and the
  two buttons are child entities with `RayInteractable`; they stop `pointerdown` from bubbling
  so a click on them never starts a frame grab.
- **Desktop.** The same window opens in front of the camera; a mouse click on the glass or
  STEP IN enters the street (canvas pointer events feed `RayInteractable`).
- **Comfort.** The camera is never moved. Only the window moves, by hand, or jumps into
  place when it opens (and when an XR session starts or ends).

## Files

| File | What |
|---|---|
| `entry.ts` | `createTrack`; builds entities, wires the flow and system. Returns `Portal` (`open`, `close`). |
| `portal-flow.ts` | Mode state machine and stencil set/clear. No Three.js. |
| `portal-logic.ts` | Plane maths, `CrossingDetector`, `placeInFrontOfHead`. No Three.js, no allocation per frame. |
| `portal-window.ts` | Frame (one extruded mesh), stencil glass, button meshes. |
| `portal-system.ts` | Per-frame crossing checks, button presses, hover. |
| `head.ts` | Head pose: XR viewer pose in a session, the camera outside one. |
| `dev-demo.ts` | DEV-only self-driving demo, off (`PORTAL_DEV_DEMO = false`). |
| `portal.test.ts` | Vitest: crossings (head, hand, around the frame, dead band), placement, state machine, stencil with a fake stage. |
| `evidence/` | Emulator screenshots (600 px previews). |

## Needs from others

- `iwsdk.config.json` `world.render.stencil: true` and a stage that, when `stencilRef` is set,
  uses `stencilWrite: true` (this is what turns the stencil test on in three.js),
  `stencilWriteMask: 0`, `stencilFunc: Equal`. Both are on main since 41fdee5 (mock stage).
  **Track B's real stage must do the same.**
- Something has to start portal mode from the street: Track G's button emitting
  `mode:requested {mode:'portal'}`, or `index.ts` calling the returned `open()`.

## Verified (2026-11-10, IWER emulator, Meta Quest 3 profile, immersive-ar)

- Seen: living room around a window showing Times Square (`evidence/1-portal-open-ar.jpg`).
- Seen: headset moved through the window, mode `portal -> street`, street fills the view
  (`2-stepped-through.jpg`, log `reason=head`).
- Seen: ray + select on BACK TO ROOM (`Hovered` confirmed first), mode `portal -> table`,
  room back with no window (`3-back-in-room.jpg`).
- Seen: distance grab with trigger: `Grabbed` while held, frame moved from
  (0, 1.45, -1.3) to (0.45, 1.45, -1.01), `Grabbed` cleared on release, mode unchanged
  (`4-after-grab.jpg`).
- Seen: controller pushed through the moved window, mode `portal -> street`, log `reason=hand`.
- Seen: desktop (no XR) click on the glass, mode `portal -> street`, log `reason=press`
  (`5-desktop.jpg`).
- State: renderer context `stencil=true`; `stage.stencilRef` logged `1` in portal mode and
  `null` after every exit.
- Tests only: hysteresis edge cases, the duplicate-request block and its timeout.

## Not verified (needs a headset)

- Real passthrough with the stencilled sphere on Quest Browser, and the stencil buffer on the
  Quest GPU / XR layer (the emulator proves only desktop Chrome).
- Hand-tracking push-through (only the emulated controller was pushed through), reach and
  feel of the distance grab, and whether the 12 cm push depth and 8 cm frame inset feel right.
- Comfort of stepping through a window into a full street, window size (1.0 x 1.2 m) and
  opening distance (1.3 m), and whether an infinitely distant street through a near window
  reads well in stereo.
