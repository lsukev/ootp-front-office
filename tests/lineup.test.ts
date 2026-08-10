import { describe, expect, it } from 'vitest';
import request from './request';
import { IDS } from './fixture';

describe('designated hitter rule', () => {
  it('follows the league by default', async () => {
    const d = await request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=trad&dh=auto`);
    expect(d.leagueUsesDH).toBe(true);
    expect(d.usesDH).toBe(true);
    expect(d.dhOverridden).toBe(false);
  });

  it('can be overridden without touching the league rule', async () => {
    const d = await request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=trad&dh=off`);
    expect(d.usesDH).toBe(false);
    expect(d.leagueUsesDH).toBe(true);
    expect(d.dhOverridden).toBe(true);
    // The pitcher takes the ninth slot himself
    expect(d.lineup[d.lineup.length - 1].positionName).toBe('P');
  });

  it('ignores an unrecognised value rather than erroring', async () => {
    const d = await request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=trad&dh=banana`);
    expect(d.usesDH).toBe(true);
    expect(d.dhOverridden).toBe(false);
  });
});
