# Track F: Archive

Shows old photographs from Wikimedia Commons as floating framed photos when the time dial
goes below the earliest Mapillary year.

## Files

- `commons.ts` data layer: one geosearch+imageinfo request (generator, 50 candidates, 1.5 km),
  year parsing, HTML stripping, selection (max 6, spread over years), in-memory cache per
  ~110 m cell. Implements `ArchiveService`.
- `controller.ts` pure show/hide logic and the `archive:visible` event.
- `frames.ts` 3D frames: one canvas texture per photo (photo, year, title, credit), plane meshes,
  fade-in/out by opacity in `ArchiveFadeSystem`, disposal.
- `entry.ts` `createTrack` (also returns `photosNear`). `dev-driver.ts` replays fixture events;
  switch on with `DEV_DRIVER` in `entry.ts` (left `false`).

## Behaviour

- Visible when: mode `street`, lens on, dialled year below `state.years[0]`.
- Hidden on: dial back up, `time:toggled` off, mode leaves `street`, place change.
- Photos are fetched (and cached) as soon as `spot:selected` / `pano:shown` fire, never per year step.
- `archive:visible` carries the photos actually on screen (images that fail to load are dropped);
  empty array when hidden. Only emitted on change.
- A photo is used only if it has a year (from `DateTimeOriginal`, not the upload date) and a licence.
  Missing author becomes "Unknown author". Frame text: `Photo: <creator> · <licence> · Wikimedia Commons`.
- Layout: 2 m from the head, eye level, 26 degree spacing on an arc around the gaze direction at the
  moment of showing; an odd middle frame is lifted 0.35 m. Frames turn to face the head. The camera
  is never moved. Text is drawn with a 2D canvas (no UIKit needed, no shared files touched).
- At most 6 textures alive; disposed after fade-out (`texture.dispose()`, `entity.dispose()`).

## Not verified on a headset (see report)

Text legibility (credit line is 26 px on an 800 px canvas, 0.8 m wide, about 0.5 degree tall at 2 m),
placement comfort, and the arc width on Quest FOV. Archive images come from
`upload.wikimedia.org` (CORS open, 1024 px thumbnails); lots of frames at once were not profiled.
Frames overlap neighbours slightly on very wide arcs; tune `LAYOUT` in `frames.ts`.
