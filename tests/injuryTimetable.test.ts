import { describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { daysLeftSql, healthOf, NO_TIMETABLE, standingOf } from '../server/health.js';
import { daysCell, daysLong, daysShort } from '../src/injury.js';

/**
 * The thousand-day injury.
 *
 * "I think in a previous post you explained that the 1000 days injury is what
 * OOTP exports if the number of days is unknown... Right now, players with
 * 1000 days are treated as if they aren't coming back."
 *
 * He is right on both counts, and the save proves the first: injury lengths run
 * continuously from 1 to 597 and then stop dead — nobody at all between 598 and
 * 999 — with thirty-nine players parked on exactly 1000 and none of them
 * carrying the career-ending flag. Fernando Tatis Jr. is one of them and has
 * played fifty-eight games this season, the last a week before the export. The
 * number is not days.
 *
 * The app already knew OOTP does this: a magic number of 1000 has been read as
 * "no value" on the standings page since long before anybody noticed it in the
 * injury column.
 */

const hurt = (injury_left: number, extra: Record<string, number> = {}) => ({
  is_active: 0,
  is_on_dl: 1,
  injury_is_injured: 1,
  injury_left,
  ...extra,
});

describe('a day count that is really a placeholder', () => {
  /*
   * Asserted as the literal OOTP writes rather than through the constant:
   * every case below uses 1000 directly, so setting the constant wrong fails
   * the suite instead of quietly moving the tests with it.
   */
  it('is the thousand OOTP writes', () => {
    expect(NO_TIMETABLE).toBe(1000);
  });

  it('is not reported as days remaining', () => {
    expect(healthOf(hurt(1000))?.daysLeft).toBeNull();
  });

  it('says instead that there is no date on it', () => {
    expect(healthOf(hurt(1000))?.durationUnknown).toBe(true);
  });

  /*
   * The one value in the save above the placeholder. Whether it is a second
   * placeholder or a genuine six-year absence, "about 2250 more days" is not
   * something to put in front of a manager.
   */
  it('treats the lone 2250 the same way', () => {
    expect(healthOf(hurt(2250))?.daysLeft).toBeNull();
    expect(healthOf(hurt(2250))?.durationUnknown).toBe(true);
  });

  it('leaves a real duration alone, including a long one', () => {
    expect(healthOf(hurt(45))?.daysLeft).toBe(45);
    expect(healthOf(hurt(45))?.durationUnknown).toBe(false);
    // The longest genuine injury in the sample save
    expect(healthOf(hurt(597))?.daysLeft).toBe(597);
    expect(healthOf(hurt(597))?.durationUnknown).toBe(false);
  });

  it('does not call a plain zero unknown — that is an export saying nothing', () => {
    const h = healthOf(hurt(0));
    expect(h?.daysLeft).toBeNull();
    expect(h?.durationUnknown).toBe(false);
  });

  /*
   * Twenty-one of the thirty-nine are flagged day-to-day, which is what makes
   * the old reading absurd: a man listed as available tonight was also listed
   * as out for the better part of three years.
   */
  it('keeps a day-to-day man available, as he always was', () => {
    const h = healthOf({ is_active: 1, injury_dtd_injury: 1, injury_is_injured: 1, injury_left: 1000 });
    expect(h?.status).toBe('Day-to-day');
    expect(h?.playable).toBe(true);
    expect(h?.daysLeft).toBeNull();
    expect(h?.durationUnknown).toBe(true);
  });

  it('carries the same answer into where he stands with the club', () => {
    const s = standingOf(hurt(1000));
    expect(s.daysLeft).toBeNull();
    expect(s.durationUnknown).toBe(true);
  });

  /*
   * A DFA clock is a real countdown from a different column. Nothing about the
   * injury rule should touch it.
   */
  it('leaves the DFA clock alone', () => {
    const s = standingOf({ designated_for_assignment: 1, days_on_dfa_left: 5 });
    expect(s.label).toBe('DFA');
    expect(s.daysLeft).toBe(5);
    expect(s.durationUnknown).toBe(false);
  });
});

/**
 * The SQL half. Two queries read the column without going through healthOf —
 * the dashboard's ordering and the context handed to the AI — and the model
 * writing "out for a thousand days" would be the same fault with a byline.
 */
describe('the same rule in SQL', () => {
  // Named rather than positional: the column appears three times in the CASE,
  // so a `?` would want the value bound three times
  const evaluate = (value: number | null): number | null =>
    (db.prepare(`SELECT ${daysLeftSql(':days')} AS d`).get({ days: value }) as { d: number | null }).d;

  it('nulls the placeholder', () => {
    expect(evaluate(NO_TIMETABLE)).toBeNull();
    expect(evaluate(2250)).toBeNull();
  });

  it('passes a real duration through', () => {
    expect(evaluate(45)).toBe(45);
    expect(evaluate(597)).toBe(597);
  });

  it('agrees with the JavaScript rule on every case', () => {
    for (const value of [0, 1, 45, 597, 999, 1000, 1001, 2250]) {
      expect(evaluate(value), `SQL and healthOf disagree on ${value}`)
        .toBe(healthOf(hurt(value))?.daysLeft ?? null);
    }
  });
});

/** The words the screens use, in one place because eight of them needed them. */
describe('how it reads', () => {
  it('gives a real duration as a duration', () => {
    expect(daysCell({ daysLeft: 14, durationUnknown: false })).toBe('~14 days');
    expect(daysShort({ daysLeft: 14, durationUnknown: false })).toBe('~14d');
    expect(daysLong({ daysLeft: 14, durationUnknown: false })).toBe('about 14 days remaining');
  });

  it('says there is no timetable rather than printing a placeholder', () => {
    const unknown = { daysLeft: null, durationUnknown: true };
    expect(daysCell(unknown)).toBe('No timetable');
    expect(daysShort(unknown)).toBe('no date');
    expect(daysLong(unknown)).toBe('no return date given');
    for (const rendered of [daysCell(unknown), daysShort(unknown), daysLong(unknown)]) {
      expect(rendered).not.toContain('1000');
    }
  });

  it('says nothing at all when the export said nothing', () => {
    const silent = { daysLeft: null, durationUnknown: false };
    expect(daysCell(silent)).toBe('—');
    expect(daysShort(silent)).toBe('');
    expect(daysLong(silent)).toBe('');
  });

  it('survives a missing injury rather than throwing on it', () => {
    expect(daysCell(null)).toBe('—');
    expect(daysShort(undefined)).toBe('');
    expect(daysLong(null)).toBe('');
  });
});
