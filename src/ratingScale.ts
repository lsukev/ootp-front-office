/**
 * How overall and potential are written on screen.
 *
 * OOTP's 20-80 grades come out of the save as exact numbers, but scouting has
 * always talked in fives — a man is a 55 or a 60, not a 57 — and a user asked
 * to read them that way. It is a display choice and nothing else: sorting,
 * ranking and every calculation keep the exact value, so a 57 still sorts above
 * a 56 even when both are shown as 55.
 *
 * Kept in a module rather than passed down because the two places these appear
 * most — the player card and the hover card — render outside the page tree.
 */

let roundToFive = false;

/*
 * The top of the scale this save uses. OOTP lets the user pick 20-80, 1-20,
 * 1-10, 2-8 or 1-5, and the export carries whichever they chose — so a bar
 * that divided by eighty regardless drew a best-in-class 5 as a sliver.
 */
let scaleMax = 80;

export function setRatingScaleMax(max: number | undefined): void {
  scaleMax = typeof max === 'number' && max > 0 ? max : 80;
}

export function ratingScaleMax(): number {
  return scaleMax;
}

/** How full a bar should be for this rating, 0-1. */
export function ratingFraction(value: number): number {
  return Math.max(0, Math.min(1, value / scaleMax));
}

/** Set from the app root as settings load, before anything renders with them. */
export function setRatingRounding(on: boolean): void {
  roundToFive = on;
}

export function ratingRounding(): boolean {
  return roundToFive;
}

/** A single grade, as it should be written. */
export function formatRating(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  /*
   * Rounding to fives is a habit of the 20-80 scale and nonsense anywhere
   * else: on the 1-to-5 scale it would turn a 3 into a 5 and a 2 into
   * nothing at all. The setting stays available and simply does not apply
   * where the scale cannot carry it.
   */
  const round = roundToFive && scaleMax === 80;
  return String(round ? Math.round(value / 5) * 5 : Math.round(value));
}

/**
 * The "60 → 70" pair, with the arrow dropped when there is no growth left to
 * show. Rounding can make a real gap vanish — a 58 with 61 potential is 60 and
 * 60 — and showing "60 → 60" would imply a distinction the scale cannot carry.
 */
export function formatRatingPair(
  overall: number | null | undefined,
  potential: number | null | undefined,
  arrow = '→'
): string {
  const oa = formatRating(overall);
  if (potential === null || potential === undefined) return oa;
  const pot = formatRating(potential);
  return pot === oa ? oa : `${oa}${arrow}${pot}`;
}
