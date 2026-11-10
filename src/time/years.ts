/**
 * Year ladder: the list of years the dial can stop at. Pure, no allocation after building.
 *
 * The ladder holds every year that has a panorama here EXCEPT the one on screen (the lens
 * always shows a different year), plus "archive stops" below the earliest panorama year.
 * Archive stops have no panorama: they are Track F's cue to show old photos.
 */

/** Ascending, de-duplicated copy. */
export function sortedYears(years: Iterable<number>): number[] {
  return [...new Set(years)].sort((a, b) => a - b);
}

/**
 * Stops below the earliest panorama year, ascending: decades down to `floor`, then the year
 * just before `earliest`. Example: earliest 2016, floor 1990 gives [1990, 2000, 2010, 2015].
 */
export function archiveStops(earliest: number, floor: number): number[] {
  const stops: number[] = [];
  const top = earliest - 1;
  if (top < floor) return stops;
  for (let y = Math.ceil(floor / 10) * 10; y < top; y += 10) stops.push(y);
  stops.push(top);
  return stops;
}

/** Every year the dial can stop at, ascending. */
export function buildLadder(panoYears: readonly number[], currentYear: number | null, floor: number): number[] {
  const years = sortedYears(panoYears);
  if (years.length === 0) return [];
  const others = years.filter((y) => y !== currentYear);
  return [...archiveStops(years[0], floor), ...others];
}

/**
 * The year the lens opens on: the latest panorama year before the current one. If there is
 * none (the user already pushed through to the earliest year), the nearest later year.
 * Null means there is nothing else to show, so the lens must not open.
 */
export function defaultYear(panoYears: readonly number[], currentYear: number | null): number | null {
  let earlier: number | null = null;
  let later: number | null = null;
  for (const y of panoYears) {
    if (currentYear === null || y < currentYear) {
      if (earlier === null || y > earlier) earlier = y;
    } else if (y > currentYear) {
      if (later === null || y < later) later = y;
    }
  }
  return earlier ?? later;
}

/** Index of `year` in the ladder, or of the closest stop when it is not on it. */
export function ladderIndex(ladder: readonly number[], year: number): number {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < ladder.length; i++) {
    const gap = Math.abs(ladder[i] - year);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

/** Move `delta` stops along the ladder (negative is earlier), clamped at both ends. */
export function stepYear(ladder: readonly number[], year: number, delta: number): number {
  if (ladder.length === 0) return year;
  const i = ladderIndex(ladder, year);
  const next = Math.min(ladder.length - 1, Math.max(0, i + Math.trunc(delta)));
  return ladder[next];
}

export function isPanoYear(panoYears: readonly number[], year: number | null): boolean {
  return year !== null && panoYears.includes(year);
}
