# Street View Time Machine — Initial Plan (v1)

## Status and corrections (2026-11-10, after scaffolding)

Done so far: project scaffolded (AR target, TypeScript, grabbing on, hand tracking on),
dependencies installed, this plan and `ORCHESTRATOR_PROMPT.md` saved, project rules added
to `CLAUDE.md`, first drafts of the three skills written in `.claude/skills/`.

Still to do in Phase 0: steps 4 (contracts, config, stubs, vitest), 5 (the three spikes)
and the skill updates that depend on the spikes. The starter demo files (`src/robot*.ts`,
`src/panel.ts`, demo scene assets and UI) are still in place and should be removed in step 4.

The generator installed **IWSDK 1.1.0-rc.2**, not the v0.5.3 the docs describe. Where this
plan and the generated `AGENTS.md` disagree about how IWSDK works, `AGENTS.md` wins. What changes:

- `iwsdk.config.json` is the project authority (XR mode, features). `src/index.ts` passes
  `virtual:iwsdk-project` to `World.create()` and registers systems.
- More files are shared than the plan assumed. `src/components.ts`, `src/assets.ts`,
  `iwsdk.config.json`, `vite.config.ts` and `public/scenes/` are **Phase 0 only**, like
  `index.ts`. Phase 0 must pre-register each track's components, assets and UI panels there,
  so tracks never need to touch them.
- UIKitML sources live in `public/ui/`; Track G owns `public/ui/` as well as `src/ui/`.
- Import Three.js from `@iwsdk/core`, never from `three`.
- The dev server is CLI-managed (`npm run dev`), on port 8081. Parallel worktrees need a
  port each; the orchestrator assigns them.
- The project ships IWSDK skills (`iwsdk-dev`, `iwsdk-ray`, `iwsdk-grab`, `iwsdk-debug`,
  `iwsdk-ui`, `iwsdk-hosting`). `xr-test-loop` builds on them and does not repeat them.
- Each worktree needs its own `npm install` and a copy of `.env.local`.

## Context

A Meta Quest WebXR app: pick a place on a flat map lying on a table, dive into a 360° street
view, then press **TIME MACHINE** to get a magical circular lens on your hand that shows the
same street in an earlier year. It must cost nothing to run, have a minimal UI, and be
testable on desktop because there is no headset available.

Decisions already made in the debate:

- **No Google.** Its official APIs have no historical imagery and need a billing account.
- **Mapillary** supplies 360° imagery with capture dates (free, client token).
- **Flat map on a table** only. 3D buildings, ocean and ambient sound are out of v1.
- The project folder `/Users/mayank/Developer/TIME_machine` is empty and not a git repo.

Facts checked today (Meta docs via `metavr`, Mapillary API docs):

- IWSDK v0.5.3: `npm create @iwsdk@latest`, Node ≥ 20.19 (machine has v26.13). `npm run dev`
  serves HTTPS with the IWER desktop emulator. The generator writes `AGENTS.md`, a `CLAUDE.md`
  shim, IWSDK skills and `.mcp.json` (`npx iwsdk adapter sync` re-syncs MCP config).
- Mapillary: `GET https://graph.mapillary.com/images` with `access_token`.
  - Radius search: `lat`, `lng`, `radius` (max 50 m), `limit` (max 100) — used for "same spot, other years".
  - Bbox search: bbox must be under 0.01° square; filters `is_pano`, `start_captured_at`, `end_captured_at`.
  - Fields: `captured_at`, `computed_compass_angle`, `computed_geometry`, `is_pano`, `sequence`,
    `thumb_2048_url`, `thumb_original_url`, `width`, `height`, `creator`.
  - Coverage vector tiles: `https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}`
    (layers `sequence` z6–14, `image` z14, each with `is_pano`, `captured_at`).
- **Not verified, so Phase 0 must prove them:** image URL CORS and expiry, Mapillary rate limits
  and licence wording, MapLibre redrawing during an XR session, AR (passthrough) session in the emulator.

## Scope

| In v1 | Out of v1 |
|---|---|
| 2D landing page with place search | Ocean / swimming |
| Flat tabletop map with Mapillary coverage highlighted | 3D buildings |
| Dive into a 360° street, hop along the street | Ambient sound |
| TIME MACHINE button → magical time lens | Google imagery |
| Wrist dial to scrub years, "push through" to commit | Typing inside VR |
| Passthrough portal (window in your room) | |
| Archive-photo windows for pre-2014 | |
| Curated launch spots, attribution, comfort and memory rules | |
| Desktop (non-VR) mode: drag to look, lens follows the mouse | |

## User action needed before Phase 0

Create a free Mapillary account and a **client token** at
`mapillary.com/dashboard/developers`. It goes in `.env.local` as `VITE_MAPILLARY_TOKEN`.

## Architecture: built so agents cannot collide

One rule: **each track owns one folder and edits nothing else.** Tracks talk only through
`src/contracts.ts` (types plus a typed event bus), which is frozen after Phase 0.
`src/index.ts` registers every track's entry point once in Phase 0, as stubs, so no track
ever edits it.

```
src/
  index.ts            Phase 0 only: World.create, registers all track entry points
  contracts.ts        Phase 0 only: types, AppState, typed event bus (frozen)
  config.ts           Phase 0 only: budgets and constants
  data/      Track A  Mapillary client, year grouping, cache, curated spots
  pano/      Track B  pano sphere, load/dispose, heading alignment, hops, fades
  time/      Track C  time lens, wrist dial, push-through transition
  map/       Track D  tabletop map (MapLibre → canvas texture), landing page search
  portal/    Track E  passthrough portal window
  archive/   Track F  Wikimedia Commons old-photo windows
  ui/        Track G  TIME MACHINE button, year label, credits, empty/error states
public/dev/           Phase 0: two fixture panoramas (different years) for offline work
initial plan.md       copy of this plan
ORCHESTRATOR_PROMPT.md
CLAUDE.md             project rules (appended to the generated shim)
.claude/skills/       mapillary-api, pano-rendering, xr-test-loop
```

Contract sketch (Phase 0 finalises it):

- `Pano { id, lat, lng, capturedAt, heading, imageUrl, width, height, creator, sequenceId }`
- `PanoSource`: `panosNear(lat,lng)`, `yearsAt(lat,lng) → Map<year, Pano>`, `neighbours(pano)`
- `PanoStage`: `show(pano)`, `currentTexture`, `loadPast(pano) → texture`, `commitPast()`
- Events: `spot:selected`, `pano:shown`, `time:toggled`, `time:yearChanged`,
  `time:committed`, `mode:changed` (`table | street | portal`), `error`
- Every track gets a mock of the interfaces it consumes, so it runs alone against `public/dev/` fixtures.

**Session decision:** request one AR session and stay in it. "Full VR" is the opaque pano
sphere covering passthrough; the portal is the same sphere seen through a masked window.
This avoids switching sessions. Fall back to a VR session if AR is refused.

## Phase 0 — Foundation (one agent, serial, strongest model)

1. Scaffold IWSDK into the project root (generate in a temp folder name, then move up, since
   the generator makes a subfolder). `git init`, first commit.
2. Save this plan as `initial plan.md` and the prompt below as `ORCHESTRATOR_PROMPT.md`.
3. Append project rules to `CLAUDE.md` (do not overwrite the generated shim):
   zero running cost, no Google, no server, folder ownership, fade to black between hops,
   never move the camera smoothly, attribution always visible, at most two panoramas in
   memory, textures capped at 8192 px wide or the device limit, `.env.local` never committed.
4. Write `contracts.ts`, `config.ts`, stub every track folder with a working no-op entry
   point and mocks, register all in `index.ts`. Add `vitest`. `npm run build` must pass.
5. **Spikes, each with a written result in `docs/spikes.md`:**
   - Load a Mapillary `thumb_original_url` as a WebGL texture (CORS, size, URL expiry).
   - MapLibre drawing into a canvas texture while an XR session runs (manual redraw).
     If it fails: the map lives only on the 2D landing page, and VR gets the curated list.
   - AR session with an opaque sphere in the IWER emulator.
6. Create the three skills with the `skill-creator` skill, in `.claude/skills/`:
   - `mapillary-api` — endpoints, filters, limits and fields above, plus spike findings and attribution.
   - `xr-test-loop` — start the dev server, drive the emulator through the IWSDK MCP tools,
     take screenshots, and what "verified" means with no headset.
   - `pano-rendering` — memory budget, load/dispose order, heading alignment, fade rules,
     lens shader approach. Marked v1; updated in Phase 2 with what was learned.
7. Commit. This commit is the base for every track.

## Phase 1 — Seven parallel tracks (one agent each, own git worktree and branch)

| Track | Folder | Delivers | Model |
|---|---|---|---|
| A Data | `src/data/` | Mapillary client; `yearsAt` groups radius-search results by year, picks the closest pano per year; in-memory cache and request throttling; `spots.json` of 20–30 curated places, each checked by script to have ≥ 3 years of panoramas; vitest with mocked fetch | sonnet |
| B Pano stage | `src/pano/` | Inside-out sphere; downscale to texture cap; rotate by `heading` so north is consistent between years; dispose on swap; fade-to-black hops; arrows to neighbours on the same street | opus |
| C Time machine | `src/time/` | **Time lens**: circular portal on the hand (controller or mouse on desktop) that samples the past pano with a shimmering rim and a ripple when it opens; wrist dial (pinch and twist) to change year; pinch-hold "push through" grows the lens until the past surrounds you, then commits | fable |
| D Map table | `src/map/` | MapLibre + OpenFreeMap into a canvas texture on a table surface; pinch-drag pan, two-hand zoom; Mapillary coverage layer (panoramas only); pinch a street → `spot:selected`; 2D landing page search with Photon and the curated list | opus |
| E Portal | `src/portal/` | Framed window placed in the room showing the street through a stencil mask; grab to move; step or push through to enter the street; exit returns to the room | opus |
| F Archive | `src/archive/` | Wikimedia Commons geosearch for old photos near the spot; floating framed photos with year and credit, shown when the dial goes below the earliest Mapillary year | sonnet |
| G UI | `src/ui/` and `ui/` | TIME MACHINE button, large year label, persistent credit line (Mapillary, OpenStreetMap, photo creator), loading state, "no earlier imagery here" state, error toasts | sonnet |

Each track finishes with: `npm run build` and `npm test` passing, a screenshot from the
emulator showing its feature against mocks, and a short `README.md` in its folder.

## Phase 2 — Integration (one agent, serial, strongest model)

1. Merge the seven branches. Folder ownership means no conflicts are expected; any conflict
   is a rule violation to investigate, not to paper over.
2. Replace mocks with real implementations in `index.ts`.
3. Run the full acceptance pass below in the emulator and in desktop mode.
4. Performance pass against the budget: ≤ 100 draw calls, two panoramas in memory, 72 Hz target.
5. Update the three skills with what was learned. Write `docs/untested-on-device.md`
   (comfort, real frame rate, hand-tracking feel, text legibility).
6. Deploy a static build to Cloudflare Pages or GitHub Pages — **only after asking the user**,
   since it is public. Restrict nothing else; the Mapillary client token is meant to be public.

## Verification

- `npm run build` and `npm test` pass at the end of every phase.
- Acceptance pass in the IWER emulator (driven through the IWSDK MCP tools, with screenshots):
  1. Landing page: search "Times Square", press Enter XR.
  2. Table map shows the area with coverage lines; pinch a street → fade → inside the pano.
  3. Hop to a neighbour: fade to black, no camera slide.
  4. Press TIME MACHINE: lens appears with the ripple; an earlier year is visible only inside it.
  5. Turn the wrist dial: year label and lens content change; headings stay aligned.
  6. Push through: the past year becomes the whole view.
  7. Dial below the earliest year: archive photo windows appear with credits.
  8. Switch to portal mode: window in the room shows the street; step through.
  9. A spot with one year only shows "no earlier imagery here".
  10. Credit line is visible in every state.
- Desktop mode: the same pass with mouse drag and mouse-following lens.
- Memory check: after 20 hops, texture count in `renderer.info` has not grown.

## Orchestrator prompt (saved as `ORCHESTRATOR_PROMPT.md`)

```
You are the orchestrator for the Street View Time Machine project in this folder.

Read first, in full: `initial plan.md`, `CLAUDE.md`, `AGENTS.md`, `src/contracts.ts`,
`docs/spikes.md`, and every skill in `.claude/skills/`. The plan is the source of truth.
If Phase 0 is not complete (no `src/contracts.ts`, or `npm run build` fails), do Phase 0
yourself, serially, before anything else, and commit it.

Then run Phase 1 as seven parallel subagents, one per track (A–G in the plan). Launch them
together. For each one:
- Give it its own git worktree and branch named `track-<letter>-<name>`.
- Use the model named for that track in the plan: fable for C; opus for B, D, E; sonnet for
  A, F, G. Use haiku only for mechanical sub-jobs such as checking the curated spots list.
- Its brief must contain: the goal and what it is for, its section of the plan copied in
  full, the one folder it owns, the interfaces it consumes and provides from
  `src/contracts.ts`, which skills to load, and the finish criteria.

Rules every subagent must be given word for word:
1. Edit only files inside your own folder. Never edit `src/index.ts`, `src/contracts.ts`,
   `src/config.ts`, `package.json`, `CLAUDE.md`, or another track's folder.
2. If you need a contract change or a new dependency, stop and report it. Do not work around it.
3. Develop against the mocks and the fixtures in `public/dev/`; do not wait for another track.
4. Zero running cost: no paid API, no Google service, no server.
5. Check Meta and IWSDK APIs with `metavr docs search` before using them. Check Mapillary
   usage against the `mapillary-api` skill.
6. Finish with `npm run build` and `npm test` passing, an emulator screenshot of your
   feature, and a README in your folder. Report what you verified and what you could not.

Your own job while they run: you alone decide contract or dependency change requests. Apply
an approved change on the main branch, then tell every affected track to rebase.

When all seven report, do Phase 2 yourself: merge, wire the real implementations, run the
full acceptance pass from the plan, do the performance pass, update the skills. Treat any
merge conflict as a broken ownership rule and find out why.

Do not deploy, publish or push anywhere without asking the user first. Finish with a report:
what works and was verified in the emulator, what failed, and what is untested without a headset.
```
