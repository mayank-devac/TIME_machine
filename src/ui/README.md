# Track G: UI (HUD)

Five world-space UIKitML panels (`public/ui/*.uikitml`, kit `horizon`, dark), created by
`entry.ts` with `world.assets.instantiate(<manifest id>)` and
`world.createTransformEntity(panel, { persistent: true })`, each tagged `HudTag { slot }`.

| Slot | Manifest id | Shown when |
| --- | --- | --- |
| credits | `hud-credits` | always |
| status | `hud-status` | a toast, loading, or "No earlier imagery here" is active |
| time | `hud-time-button` | mode `street` or `portal`; greyed unless years >= 2 |
| year | `hud-year-label` | mode `street` or `portal`; present year, dialled year when the lens is on |
| portal | `hud-portal-button` | mode `street` (PORTAL) or `portal` (BACK) |

Status priority: error toast, then loading spinner, then "No earlier imagery here".

## Events
Emits `time:toggled {on}` (TIME MACHINE button, ignored while disabled) and
`mode:requested {mode:'portal'|'street'}` (portal button). Listens to `spot:selected`,
`pano:shown`, `time:yearsKnown`, `time:toggled`, `time:yearChanged`, `time:committed`,
`archive:visible`, `mode:changed`, `loading`, `error`. App state comes from `ctx.state.get()`.
"No earlier imagery" needs `time:yearsKnown` to have arrived since the last `spot:selected`.
Recoverable errors dismiss after 4 s; `recoverable: false` stays until the next `spot:selected`.

## Comfort and placement
Panels never follow the head. `recentre()` hard-snaps all five to the head's position and
yaw (credits 1.5 m ahead, 0.75 m below the eye line; button 32 degrees left, year and portal 32
degrees right). It runs once at start, on every `mode:changed`, 0.7 s after an XR session
starts, and when the user presses `C` on desktop. `Track.recentre()` is also exposed.
Pure maths is in `hud-logic.ts` (`SLOTS`, `slotPosition`).

## Input
Only the time and portal panels carry `RayInteractable`. Clicks reach the UIKit elements from
XR rays and from desktop canvas pointer events (`canvasPointerEvents` is on).

## Files
`hud-logic.ts` + `hud-logic.test.ts` (credits, derived view, busy scopes, toast queue, placement),
`entry.ts` (scene wiring), `evidence/` (emulator screenshots).

## Evidence (emulator, Times Square fixtures)
`evidence/`: table, street, time-lens-on (also with archive credits), loading, error toast,
no-earlier-imagery, portal, sticky error, and one inside an emulated XR session. The credit
line is visible in each. Screenshots were driven by a temporary DEV key driver (keys 1-9 emitting
bus events) that was removed; it exists in git history (`src/ui/demo.ts`, commit "polish, demo driver").
Logged during the run: desktop click on the button gave `time:toggled {"on":true}` then
`{"on":false}`; desktop click on PORTAL gave `mode:requested {"mode":"portal"}`; an emulated
right-controller ray aimed at the button plus `xr select` gave `time:toggled {"on":true}`.

## Not verified
Legibility and reach on a headset, comfort of the layout, and the table-mode credits position
relative to the real map table (Track D's table sits near the same spot; the credits float 1.5 m
away at about 0.85 m height). See `docs/untested-on-device.md`.
