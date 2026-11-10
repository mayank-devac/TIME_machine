---
name: xr-test-loop
description: How to prove a change works in this project when there is no headset - starting the IWSDK managed dev server and emulator, what to check for each feature (map table, street hop, time lens, wrist dial, push-through, portal, archive windows, credits), what evidence counts, and how to report what could not be tested. Use this before saying any feature works, when finishing a track, when running the acceptance pass, or when the emulator or dev server will not start or respond.
---

# XR test loop (no headset)

The developer has no Meta Quest. Everything is checked in the desktop browser and in IWER,
the IWSDK emulator that fakes a headset, controllers and hands inside a managed browser
window. That makes it easy to claim more than was shown, so this skill is mostly about
what counts as evidence.

This project was generated with IWSDK 1.1.0-rc.2, which ships its own skills. Use them for
the mechanics, and this skill for what to verify:

| Need | Use |
|---|---|
| Any IWSDK implementation work | `iwsdk-dev` (invoke first) |
| Point and click, press spatial UI, distance grab | `iwsdk-ray` |
| Pick up and move with a hand or controller | `iwsdk-grab` |
| State that a screenshot cannot prove (pause, query, step, diff) | `iwsdk-debug` |
| Building or changing UIKitML panels | `iwsdk-ui` |

## Start and stop

- `npm run dev` starts the CLI-managed server and opens the managed browser. Do not run
  `vite` directly; the emulator and the command bridge would be missing.
- `npx @iwsdk/cli dev status` reports the URL and state. Wait for
  `browserCommandReady: true` before sending any browser command.
- `npm run dev:down` stops it. Editing `iwsdk.config.json` restarts the server in place.
- If the scene goes black after a hot reload, do a full reload before debugging anything.
- When several agents work in separate worktrees, each needs its own port, because the
  default (8081 in `vite.config.ts`) is shared. Do not edit `vite.config.ts` in a track;
  ask the orchestrator how ports are assigned.

The exact command names of the runtime tools were not exercised when this skill was
written. Read the `iwsdk-dev` skill and the tool list of the `iwsdk-runtime` MCP server
for the current ones, and add the ones you end up using to the section below.

## Commands that worked here

- `npx @iwsdk/cli dev up`, then poll `npx @iwsdk/cli dev status` until `browserCommandReady`
  is true (first run downloads Chromium, about two minutes).
- `xr_accept_session` enters the emulated immersive-ar session; `xr_get_session_status`
  confirms `sessionMode: immersive-ar`; `xr_look_at` with `{x,y,z}` metres aims the headset
  (head is at y 1.6); `xr_end_session` leaves.
- `browser_screenshot` then Read the returned `screenshotPath`. A shot right after a reload is
  black until the panorama loads; wait or retake.
- `npx @iwsdk/cli browser reload` reloads; `npx @iwsdk/cli browser logs --count N` reads console
  output (pipe through grep; the JSON is long). Dev-only hook: `window.__tm` holds
  `{world, bus, state, services}`, but there is no eval tool, so log from code instead.
- The managed browser cannot navigate to a URL with a query string. Switch debug modes with a
  constant in a file (see `src/spikes/active.ts`), save, wait, then reload.
- Do all file edits before reloading and entering XR: a late hot-reload ends the session.
- The managed app tab can have a 0x0 window (`innerWidth` 0): `requestAnimationFrame` and
  layout-dependent code behave oddly there. The editor tab is a different page and its console
  lines are mixed into the same log; tag your logs with `location.hash`.
- `npm run dev:down` (or `npx @iwsdk/cli dev down`) stops everything.

## What to check, per feature

A screenshot proves how one frame looked. Behaviour over time needs a state check as well.

| Feature | Evidence that counts |
|---|---|
| Map table | Screenshot with tiles and the coverage layer drawn; pan it, screenshot again, and the image changed. Do this inside an emulated XR session, not only on the 2D page, because the page's normal animation loop pauses in XR and the map may silently stop redrawing. |
| Pick a street | The `spot:selected` event fired with a position on a covered street; the mode became `street`. |
| Hop | A frame mid-hop is black; the camera position did not interpolate; texture count is unchanged after 20 hops. |
| Time lens | With TIME MACHINE on, a screenshot shows a different year inside the circle only; move the hand or mouse and the circle follows; a landmark is in the same direction inside and outside the rim. |
| Wrist dial | Turning it changes the year label and the lens content together. |
| Push-through | Afterwards the whole view is the past year and only two panorama textures exist. |
| Archive windows | Below the earliest year, framed photos appear, each with a year and a credit. |
| Portal | In AR mode the emulator room is visible around a window showing the street; stepping through fills the view. |
| Empty state | A spot with one year shows "no earlier imagery here", and no lens. |
| Credits | Visible in every screenshot above. |

Also run the same checks in plain desktop mode (no XR session): drag to look, lens on the mouse.

## Always run

- `npm run typecheck`
- `npm run build`
- `npm test` (once vitest is added in Phase 0)

## Honest reporting

Say plainly which of these each claim rests on:

1. **Seen in the emulator** - you ran it and have the screenshot or state output.
2. **Tests only** - logic is covered, nothing was seen running.
3. **Not verified** - say why.

The emulator cannot tell you about comfort, real frame rate, GPU memory limits, text
legibility at headset resolution, or how hand tracking feels (pinch detection on a real
device is noisier than the emulator's clean input). Never write that something "works on
Quest". Add anything in that category to `docs/untested-on-device.md` so it is ready for
the first hour with a borrowed headset.
