# Track A: data (Mapillary-backed `PanoSource`)

`entry.ts` exports `createPanoSource(): PanoSource`. It reads `import.meta.env.VITE_MAPILLARY_TOKEN`;
with no token it logs an error and returns the offline mock so the app still starts.

## Files

- `mapillary.ts`: `MapillaryClient` (the real source), plus `toPano`, `nearestPerYear`, `distanceM`.
- `mapillary.test.ts`: vitest with a mocked `fetch` (no network).
- `spots.json`: curated places `{name, lat, lng, panoId, years}`. Ids and years only, never URLs
  (image URLs expire after about 30 days; call `resolve(id)` for fresh ones).
- `build-spots.mjs`: regenerates `spots.json` from the live API.

## Behaviour

- `panosNear(lat, lng, radiusM=50)`: radius search (radius clamped to 50, limit 100), panoramas only, nearest first.
- `yearsAt(lat, lng)`: radius search of `config.maxYearOffsetMetres`; groups by capture year (UTC), keeps the
  nearest per year, drops years whose nearest is farther than the cutoff. If the search returns 100 results
  (saturated; paging does not work) it re-queries once per year from 2014 to now using
  `start_captured_at` / `end_captured_at`. A spot with one year returns a one-entry map. Cached per spot.
- `neighbours(pano)`: bbox search (about 90 m) restricted to the pano's capture year; returns the same
  sequence, nearest first, excluding itself. If the sequence has no other image, it falls back to any same-year
  panorama in the box.
- `resolve(id)`: `GET /{id}` for fresh URLs. Cached for the session (well under the 30-day expiry).
- Fields: position from `computed_geometry` then `geometry` (`[lng, lat]`); heading from
  `computed_compass_angle` then `compass_angle`; `previewUrl` = `thumb_2048_url`; `imageUrl` = `thumb_original_url`.
- One gate serialises request starts at `config.minRequestIntervalMs`; identical in-flight requests share one promise;
  Mapillary `code: 4` (or HTTP 429) waits 1.5 s and retries once, then throws "Mapillary is rate limiting this app".
  Failures are never cached. Other API errors throw without retry.

## Regenerating spots

```
node src/data/build-spots.mjs
```

Parses `VITE_MAPILLARY_TOKEN` from `.env.local` (never sourced, never printed), queries each candidate
year by year, keeps spots with at least 3 years of panoramas within 40 m, writes the first 30 that pass.
It takes a few minutes (about 13 requests per candidate at 120 ms apart).

## Tests

`npm test` covers year grouping, nearest-per-year, offset cutoff, cache hit, throttle spacing, in-flight dedup,
retry on code 4, field fallbacks, saturated search, one-year spot, and that every spot in `spots.json` has 3+ years.
