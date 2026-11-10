# IWSDK project guidance

@AGENTS.md

# Street View Time Machine — project rules

The plan is `initial plan.md`. Project skills: `mapillary-api`, `pano-rendering`, `xr-test-loop`.

- **Zero running cost.** No paid API, no billing account, no server. The app is a static site.
- **No Google services.** Imagery is Mapillary; the map is MapLibre with OpenFreeMap tiles.
- **Folder ownership.** Each track edits only its own folder under `src/`. Shared files are
  changed only by the orchestrator: `src/index.ts`, `src/contracts.ts`, `src/config.ts`,
  `src/components.ts`, `src/track-components.ts`, `src/assets.ts`, `src/flow.ts`, `src/mocks/`,
  `src/spikes/`, `iwsdk.config.json`, `vite.config.ts`, `vitest.config.ts`, `package.json`,
  `public/scenes/`, `public/dev/`, `docs/spikes.md`, this file.
- **Comfort.** Never move or rotate the viewer's camera smoothly. Hops fade to black, switch, fade in.
- **Memory.** At most two panorama textures alive at once. Texture caps come from `src/config.ts`.
- **Attribution.** Mapillary, OpenStreetMap and the image creator are credited on screen in every state.
- **Secrets.** `VITE_MAPILLARY_TOKEN` lives in `.env.local`, which is never committed.
- **No headset is available.** Do not claim something works on Quest. Follow `xr-test-loop`
  and list what could not be judged in `docs/untested-on-device.md`.
- **Publishing.** Do not deploy or push anywhere without asking the user first.

- **Entry points.** Each track exports its entry from `src/<folder>/entry.ts` (see
  `src/contracts.ts`). Create app content with `createTransformEntity(obj, { persistent: true })`.
