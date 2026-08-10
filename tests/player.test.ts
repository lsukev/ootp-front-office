import { describe, expect, it } from 'vitest';
import request from './request';
import { IDS, SEASON } from './fixture';

/**
 * The hover card reads a player's current line straight off this list, so the
 * order is a contract, not an implementation detail. Taking the wrong end of it
 * showed a veteran his A-ball season from a decade earlier.
 */
describe('career rows', () => {
  it('come back newest first', async () => {
    const d = await request(`/api/player/${IDS.starter}`);
    expect(d.battingYears.length).toBeGreaterThan(1);
    expect(d.battingYears[0].year).toBe(SEASON);
    expect(d.battingYears[d.battingYears.length - 1].year).toBe(SEASON - 6);
  });

  it('name the level each line was compiled at', async () => {
    const d = await request(`/api/player/${IDS.starter}`);
    // Rate stats mean different things by level, and the card puts them beside
    // ratings that are on a major-league scale
    expect(d.battingYears[0].levelName).toBe('MLB');
    expect(d.battingYears[d.battingYears.length - 1].levelName).toBe('A');
  });
});
