/**
 * What stretch of the season a page is about.
 *
 * "Many OOTP online leagues use a 7-day schedule. So, rather than the
 * newspaper showing the last day's news/results, show the prior week's."
 *
 * The server works the stretch out from how far apart the reader's exports
 * are, so a league simmed a day at a time still says one day and reads exactly
 * as it always has. These turn that into the line a reader sees, and they are
 * shared so the paper and the recap can never disagree about what they cover.
 */

/** OOTP writes dates unpadded, and they are the save's own, never the reader's clock. */
function parts(iso: string): [number, number, number] | null {
  const [y, m, d] = iso.split('-').map(Number);
  return y && m && d ? [y, m, d] : null;
}

/**
 * A date the way a paper prints it.
 *
 * Constructed as local rather than parsed as UTC — `new Date('2027-05-16')` is
 * midnight GMT, which is the day before for anybody west of London.
 */
export function printDate(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

/** The short form, for the second half of a range where the year is already given. */
function shortDate(iso: string): string {
  const p = parts(iso);
  if (!p) return iso;
  return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, {
    month: 'long', day: 'numeric',
  });
}

/**
 * The stretch, as one phrase.
 *
 * One day reads as that day and nothing else — the overwhelmingly common case,
 * and a reader simming a day at a time should never see a date range where
 * there was only ever a date.
 */
export function coveredSpan(
  to: string | null | undefined,
  from?: string | null,
  days?: number
): string {
  if (!to) return '';
  if (!from || !days || days <= 1 || from === to) return printDate(to);
  return `${shortDate(from)} – ${printDate(to)}`;
}

/** The same, compact, for a line of small print. */
export function coveredShort(
  to: string | null | undefined,
  from?: string | null,
  days?: number
): string {
  if (!to) return '';
  if (!from || !days || days <= 1 || from === to) return to;
  return `${from} – ${to}`;
}
