/**
 * How long a man is out for, said in words.
 *
 * OOTP writes 1000 in the days-remaining column when it has no duration to
 * write, and the app used to print that: "~1000 days", on players who were in
 * the lineup that week. Eight screens formatted this number for themselves,
 * which is the same copy-paste shape that has bitten this codebase before, so
 * the wording lives here and they all call it.
 *
 * The server decides what is real (`durationUnknown` in server/health.ts). This
 * only chooses the words.
 */

export interface Timetable {
  daysLeft: number | null;
  durationUnknown?: boolean;
}

/** Said plainly, because "unknown" is the honest answer and not a failure. */
const NO_DATE_CELL = 'No timetable';
const NO_DATE_SHORT = 'no date';
const NO_DATE_LONG = 'no return date given';

/** For a table cell of its own, where an em dash means "nothing to say". */
export function daysCell(i: Timetable | null | undefined): string {
  if (!i) return '—';
  if (i.daysLeft) return `~${i.daysLeft} days`;
  return i.durationUnknown ? NO_DATE_CELL : '—';
}

/** For a chip or a trailing clause, where empty means "add nothing". */
export function daysShort(i: Timetable | null | undefined): string {
  if (!i) return '';
  if (i.daysLeft) return `~${i.daysLeft}d`;
  return i.durationUnknown ? NO_DATE_SHORT : '';
}

/** For a sentence or a tooltip. */
export function daysLong(i: Timetable | null | undefined): string {
  if (!i) return '';
  if (i.daysLeft) return `about ${i.daysLeft} days remaining`;
  return i.durationUnknown ? NO_DATE_LONG : '';
}
