import { describe, expect, it } from 'vitest';
import { controlAfterThisSeason } from '../server/contracts.js';

/**
 * Telling a deal ending from a player leaving.
 *
 * The payroll page counted both as money coming off the books, and a reader
 * pointed out that they are not the same thing: a man with arbitration years
 * left is still yours, and his salary is about to rise rather than vanish. On
 * the club this was checked against, the old single figure was 36 players and
 * $74M of supposed relief, of which only 8 players and $33M actually leave.
 *
 * The reasoning already existed on the Contracts page and was written a second
 * time, differently, on the payroll one. It now lives in one place, because
 * two pages disagreeing about the same player is the worse failure.
 */

const RULES = { faMinYears: 6, arbMinYears: 3, hasFreeAgency: true, hasArbitration: true };
const ask = (over: Partial<Parameters<typeof controlAfterThisSeason>[0]>) =>
  controlAfterThisSeason({
    yearsAfterThis: 0,
    hasExtension: false,
    serviceDays: null,
    serviceYears: null,
    serviceLeft: 0,
    rules: RULES,
    ...over,
  });

describe('what happens when a deal runs out', () => {
  it('calls a six-year man leaving', () => {
    expect(ask({ serviceYears: 6 }).status).toBe('leaving');
  });

  it('does not call an arbitration case leaving', () => {
    const r = ask({ serviceYears: 4 });
    expect(r.status).toBe('arbitration');
    expect(r.arbYear).toBe(2);
  });

  it('counts the arbitration trips from the threshold', () => {
    expect(ask({ serviceYears: 3 }).arbYear).toBe(1);
    expect(ask({ serviceYears: 5 }).arbYear).toBe(3);
  });

  it('calls a first-year man pre-arbitration', () => {
    expect(ask({ serviceYears: 1 }).status).toBe('pre-arbitration');
  });

  it('prefers service days, which are exact, over truncated years', () => {
    // 175 days past five years is six, just; the truncated column still says 5
    const days = 5 * 172 + 175;
    expect(ask({ serviceDays: days, serviceYears: 5 }).status).toBe('leaving');
    expect(ask({ serviceDays: 3 * 172, serviceYears: 5 }).status).toBe('arbitration');
  });

  it('counts only the season still to be played, not a whole extra year', () => {
    // Adding a full year to banked days pushed players over the line months early
    const nearlyFive = { serviceDays: 4 * 172 + 100, serviceYears: 4 };
    expect(ask({ ...nearlyFive, serviceLeft: 0.4 }).status).toBe('arbitration');
    expect(ask({ ...nearlyFive, serviceLeft: 1.5 }).status).toBe('leaving');
  });

  it('leaves a man under contract alone', () => {
    expect(ask({ yearsAfterThis: 2, serviceYears: 8 }).status).toBe('signed');
  });

  it('treats an extension as the club keeping him', () => {
    expect(ask({ hasExtension: true, serviceYears: 8 }).status).toBe('extended');
  });

  it('has nobody leaving in a league with no free agency', () => {
    const noFa = { ...RULES, hasFreeAgency: false };
    expect(ask({ serviceYears: 12, rules: noFa }).status).toBe('reserve clause');
  });

  it('skips arbitration where the league has none', () => {
    const noArb = { ...RULES, hasArbitration: false };
    expect(ask({ serviceYears: 4, rules: noArb }).status).toBe('pre-arbitration');
  });
});
