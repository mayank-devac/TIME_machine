---
name: mapillary-api
description: How this project gets 360° street imagery and its capture dates from the Mapillary API - endpoints, search limits, fields, coverage tiles, attribution, and which facts are still unproven. Use this whenever you write or change code that fetches street imagery, finds "the same spot in other years", draws the coverage layer on the map, validates the curated spots list, or shows image credits, and whenever a Mapillary request fails or returns nothing, even if the task does not name Mapillary.
---

# Mapillary API (for Street View Time Machine)

Mapillary is the only imagery source in this project. It is free, its images carry capture
dates, and its client token is designed to be shipped in browser code. Google imagery is
ruled out (no historical imagery in official APIs, billing account required), so do not
reach for it when Mapillary coverage is thin; show the "no earlier imagery here" state instead.

Facts below were read from `https://www.mapillary.com/developer/api-documentation` on
2026-11-10. Items under "Not yet proven" were not confirmed. Re-read the docs page before
relying on anything not listed here, because this API changes (two search features used
here were added in 2026).

## Access

- Metadata base: `https://graph.mapillary.com`
- Tiles base: `https://tiles.mapillary.com`
- Token: `?access_token=<token>` (works everywhere, required form for tiles) or header
  `Authorization: OAuth <token>` (entity calls only).
- The token comes from `import.meta.env.VITE_MAPILLARY_TOKEN`, set in `.env.local`, which
  is git-ignored. It is a *client* token, so it is fine in the built bundle. Never use a
  user (OAuth) token in this app.

## Finding panoramas

`GET /images` with a `fields` list. Ask only for what you use:

```
fields=id,captured_at,computed_compass_angle,compass_angle,computed_geometry,geometry,
       is_pano,sequence,thumb_2048_url,thumb_original_url,width,height,creator
```

Two search shapes, which cannot be combined with each other:

| Shape | Parameters | Limits | Use for |
|---|---|---|---|
| Radius | `lat`, `lng`, `radius`, `limit` | radius max 50 m (also the default); limit default 1, max 100 | "Same spot, other years" and snapping a map pick to a real image |
| Bbox | `bbox=left,bottom,right,top`, `limit` | bbox under 0.01° square; limit default and max 2000 | Listing imagery in a small area |

Filters: `is_pano`, `start_captured_at`, `end_captured_at` (ISO 8601), `sequence_ids`,
`creator_username`, `make`, `model`, `organization_id`.

Things that bite:

- The docs say `is_pano` as a *filter* needs `bbox` or `creator_username`. With radius
  search, request the `is_pano` field and filter in code.
- Radius search cannot be combined with `bbox`, `tile`, `s2`, `image_ids` or `sequence_ids`.
- Paging only works together with `creator_username`. A busy spot can exceed 100 results
  in a radius search, so narrow by date range (one request per year band) rather than
  expecting a second page.
- `captured_at` is milliseconds since epoch. The entity field for the street run is
  `sequence` (a string id), while the filter is `sequence_ids`.
- Prefer `computed_geometry` and `computed_compass_angle` (corrected by Mapillary's
  reconstruction) and fall back to `geometry` and `compass_angle` when they are missing.
  Geometry is GeoJSON, so coordinates are `[lng, lat]`.
- `camera_type` can be `perspective`, `fisheye` or `equirectangular`. Only equirectangular
  panoramas (`is_pano: true`) can fill the sphere.

## "Same spot, other years"

1. Radius search at the current panorama's position (50 m, limit 100).
2. Keep `is_pano` images, group by the year of `captured_at`.
3. Per year, keep the image nearest to the current position. Skip a year whose nearest
   image is farther than `config.maxYearOffsetMetres`, because a view from across the
   junction breaks the illusion more than a missing year does.
4. Cache the result per spot; the answer does not change within a session.

## Images

- `thumb_original_url` is the full-size panorama; `thumb_2048_url`, `thumb_1024_url`,
  `thumb_512_url`, `thumb_256_url` are smaller. 2048 px across a full 360° looks soft in a
  headset, so use it as a fast first paint and for the lens preview, then load the original.
- Downscale the original to the texture cap in `src/config.ts` before upload (see the
  `pano-rendering` skill).

## Coverage tiles for the map

Mapbox vector tiles (`.pbf`), `access_token` required:

`https://tiles.mapillary.com/maps/vtp/mly1_public/2/{z}/{x}/{y}?access_token=<token>`

| Layer | Zooms | Geometry | Properties |
|---|---|---|---|
| `overview` | 0–5 | Point | `captured_at`, `id`, `is_pano` |
| `sequence` | 6–14 | LineString | `captured_at`, `id`, `image_id`, `is_pano`, `creator_id`, `organization_id`, `quality_score` |
| `image` | 14 | Point | `captured_at`, `compass_angle`, `id`, `is_pano`, `sequence_id`, `creator_id`, `quality_score` |

Filter the map layer to `is_pano == true` so users only see streets they can actually enter.

## Being a good client

- Throttle and de-duplicate requests in one place (`src/data/`). Pan and zoom on the map
  must not fire a metadata request per frame.
- On a throttle error (`"code": 4`), back off and retry once, then surface the `error` event.
- Show credit wherever an image is visible: "© Mapillary" plus the image's
  `creator.username`. The map also needs the OpenStreetMap credit.

## Proven in Phase 0 (see `docs/spikes.md`)

- Image URLs (`thumb_*_url`) are CORS-open (`access-control-allow-origin: *`), so a normal
  `fetch()` then `createImageBitmap` works. Tile, OpenFreeMap, Photon and Commons endpoints are
  CORS-open too.
- **Image URLs expire** after about 30 days (hex Unix time in the `oe` parameter). Store ids,
  never URLs; call `PanoSource.resolve(id)` for fresh ones.
- `camera_type` for panoramas is `spherical`. Filter on `is_pano`, not on camera type.
- Sizes seen: 5760x2880 and 7680x3840. Radius search at Times Square returned 34 panoramas
  from three different years.
- Rate limits (from the docs): entity 60,000/min, search 10,000/min, **tiles 50,000/day**.
  The tile quota is the one a map can burn through: do not redraw or refetch tiles needlessly.

## Not yet proven

- The licence wording for imagery (commonly described as CC-BY-SA; the API page does not say).
  Until confirmed, credit "© Mapillary" and the creator's username.
- The exact bbox rule: docs say "smaller than 0.01 degrees square" but show a wider sample.
  Stay under 0.01 degrees on each side.
- Whether any year other than the ones seen at Times Square is common elsewhere; Track A's
  spot validation script will find out.
