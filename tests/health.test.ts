import { describe, expect, it } from 'vitest';
import { healthOf, standingOf } from '../server/health.js';

/**
 * OOTP does not reliably clear the injured-list flags when a player is
 * activated, so a healthy man can still be carrying is_on_dl60. Four pages
 * read those flags first and believed them; this is the shared rule that
 * replaced all four.
 *
 * The first case is a user's report, verbatim — his field values, his player,
 * healthy and playing while the app called him IL-60.
 */

describe('a healthy player carrying a stale injured-list flag', () => {
  const reported = {
    is_active: 1,
    is_on_dl: 0,
    is_on_dl60: 1,
    injury_is_injured: 0,
    injury_dtd_injury: 0,
    injury_left: 0,
  };

  it('is not on the injured list', () => {
    expect(healthOf(reported)).toBeNull();
  });

  it('is therefore not kept off the lineup card', () => {
    // The lineup treats anything healthOf reports as unplayable as unavailable,
    // so a null here is what keeps him in the order
    expect(healthOf(reported)?.playable ?? true).toBe(true);
  });
});

describe('a man genuinely on the injured list', () => {
  it('is IL-60 when the club has him there and he is not active', () => {
    const h = healthOf({ is_active: 0, is_on_dl60: 1, is_on_dl: 1, injury_is_injured: 1, injury_left: 40 });
    expect(h?.status).toBe('IL-60');
    expect(h?.daysLeft).toBe(40);
    expect(h?.playable).toBe(false);
  });

  it('is IL on the shorter list', () => {
    const h = healthOf({ is_active: 0, is_on_dl: 1, injury_is_injured: 1, injury_left: 6 });
    expect(h?.status).toBe('IL');
    expect(h?.playable).toBe(false);
  });

  it('is still listed when the club has shelved him with no injury recorded', () => {
    // Nine such rows exist in the sample save; the flag is the only evidence
    expect(healthOf({ is_active: 0, is_on_dl: 1 })?.status).toBe('IL');
  });
});

describe('a man who is active but nursing something', () => {
  it('is day-to-day and can still be played', () => {
    const h = healthOf({ is_active: 1, injury_dtd_injury: 1, injury_left: 2 });
    expect(h?.status).toBe('Day-to-day');
    expect(h?.playable).toBe(true);
  });

  it('is day-to-day even when only the general injury flag is set', () => {
    // Being on the active roster is what decides it, not which flag is lit
    expect(healthOf({ is_active: 1, injury_is_injured: 1 })?.playable).toBe(true);
  });
});

describe('a healthy player', () => {
  it('has no injury status at all', () => {
    expect(healthOf({ is_active: 1 })).toBeNull();
    expect(healthOf({})).toBeNull();
  });
});

/**
 * Where a man stands with the club, which OOTP's roster list does not say.
 * A designated player stays on that list while the clock runs, so the app saw
 * no difference between him and a starter — and the manager duly described one
 * as the starting third baseman on the day he was designated.
 */
describe('a designated player', () => {
  const riley = {
    is_active: 0,
    is_on_dl: 0,
    is_on_dl60: 0,
    designated_for_assignment: 1,
    days_on_dfa_left: 7,
    is_on_waivers: 0,
    injury_is_injured: 0,
  };

  it('is DFA with his clock, not active', () => {
    const s = standingOf(riley);
    expect(s.label).toBe('DFA');
    expect(s.daysLeft).toBe(7);
    expect(s.available).toBe(false);
  });

  it('stays DFA even while also on waivers, which is the commoner case', () => {
    expect(standingOf({ ...riley, is_on_waivers: 1 }).label).toBe('DFA');
  });

  it('outranks health: designated is unavailable whatever his body says', () => {
    expect(standingOf({ ...riley, is_active: 1, injury_is_injured: 0 }).available).toBe(false);
  });
});

describe('everyone else', () => {
  it('is plainly active when nothing is wrong', () => {
    const s = standingOf({ is_active: 1 });
    expect(s.label).toBe('Active');
    expect(s.available).toBe(true);
  });

  it('carries the injury status when hurt', () => {
    expect(standingOf({ is_active: 0, is_on_dl60: 1, injury_left: 40 }).label).toBe('IL-60');
  });

  it('is on waivers when waived without designation', () => {
    expect(standingOf({ is_active: 0, is_on_waivers: 1 }).label).toBe('Waivers');
  });
});
