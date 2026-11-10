/**
 * Year ladder: the list of years the dial can stop at. Pure, no allocation after building.
 *
 * The ladder holds only years that have a panorama here, EXCEPT the one on screen.
 */

/** Ascending, de-duplicated copy. */
export function sortedYears(years: Iterable<number>): number[] {
  return [...new Set(years)].sort((a, b) => a - b);
}

/**
 * Every year the dial can stop at, ascending: each year that has a panorama here, except the
 * one on screen (the lens always shows a different year). No invented years: the dial only
 * visits what the imagery source actually returned.
 */
export function buildLadder(panoYears: readonly number[], currentYear: number | null): number[] {
  return sortedYears(panoYears).filter((y) => y !== currentYear);
}

/** Message for a dial push past either end of the ladder. */
export function limitMessage(direction: 'earlier' | 'later', edgeYear: number): string {
  return direction === 'earlier'
    ? `No earlier imagery here. Earliest is ${edgeYear}.`
    : `No later imagery here. Latest is ${edgeYear}.`;
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
