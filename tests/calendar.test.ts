import { describe, expect, it, beforeEach } from 'vitest';
import { db } from '../server/db.js';
import { calendarBriefing, seasonCalendar } from '../server/valuation.js';
import { IDS } from './fixture.js';

/**
 * The dates that govern the season.
 *
 * Asked whether to wait a fortnight before selling, the assistant answered
 * that nothing in its tools pinned down the trade deadline and it would not
 * guess at a date. Honest, and needless: the save carries the deadline, the
 * draft, the All-Star game and the rest. Every voice in the building now gets
 * them outright, rather than behind a tool somebody has to think to call.
 *
 * Dates already gone are kept and marked. Whether the deadline has passed is
 * exactly as useful as when it falls.
 */

const setDates = (today: string, deadline: string | null) => {
  db.prepare(`UPDATE leagues SET "current_date" = ?, trade_deadline_date = ? WHERE league_id = ?`)
    .run(today, deadline, IDS.league);
};

beforeEach(() => setDates('2030-06-01', '2030-07-31'));

describe('the season calendar', () => {
  it('finds the dates the save carries', () => {
    const dates = seasonCalendar(IDS.league);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.map((d) => d.what)).toContain('Trade deadline');
  });

  it('says how far off each one is', () => {
    const deadline = seasonCalendar(IDS.league).find((d) => d.what === 'Trade deadline')!;
    expect(deadline.date).toBe('2030-07-31');
    expect(deadline.daysAway).toBe(60);
    expect(deadline.passed).toBe(false);
  });

  it('keeps a date that has gone, and marks it', () => {
    setDates('2030-09-01', '2030-07-31');
    const deadline = seasonCalendar(IDS.league).find((d) => d.what === 'Trade deadline')!;
    expect(deadline.passed).toBe(true);
    expect(deadline.daysAway).toBeLessThan(0);
    expect(calendarBriefing(IDS.league)).toMatch(/days ago/);
  });

  it('calls today today', () => {
    setDates('2030-07-31', '2030-07-31');
    expect(calendarBriefing(IDS.league)).toMatch(/Trade deadline 2030-07-31 \(today\)/);
  });

  it('reads OOTP’s loose date format as readily as a padded one', () => {
    setDates('2030-6-1', '2030-8-3');
    const deadline = seasonCalendar(IDS.league).find((d) => d.what === 'Trade deadline')!;
    expect(deadline.daysAway).toBe(63);
  });

  it('puts the nearest date first, so the pressing one leads', () => {
    const days = seasonCalendar(IDS.league).map((d) => d.daysAway ?? 0);
    expect(days).toEqual([...days].sort((a, b) => a - b));
  });

  it('tells the model to use these rather than the real-world calendar', () => {
    const said = calendarBriefing(IDS.league);
    expect(said).toMatch(/come from the save/i);
    expect(said).toMatch(/never tell the reader you do not know/i);
  });

  it('says nothing at all rather than something wrong when there are no dates', () => {
    setDates('2030-06-01', null);
    const dates = seasonCalendar(IDS.league);
    expect(dates.some((d) => d.what === 'Trade deadline')).toBe(false);
  });
});
