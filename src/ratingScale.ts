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
  return String(roundToFive ? Math.round(value / 5) * 5 : Math.round(value));
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
