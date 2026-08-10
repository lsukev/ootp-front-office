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

describe('players who cannot play tonight', () => {
  it('leaves an injured man off the card', async () => {
    const d = await request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=saber&dh=auto`);
    // He is the best bat on the roster, so a builder that ignores injuries
    // would not merely include him — it would bat him near the top
    expect(d.lineup.map((l: { player_id: number }) => l.player_id)).not.toContain(IDS.injured);
    expect(d.bench.map((b: { player_id: number }) => b.player_id)).not.toContain(IDS.injured);
  });

  it('says why he is missing rather than dropping him silently', async () => {
    const d = await request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=saber&dh=auto`);
    const out = d.unavailable.find((u: { player_id: number }) => u.player_id === IDS.injured);
    expect(out).toBeDefined();
    expect(out.status).toBe('IL');
    expect(out.daysLeft).toBe(12);
    expect(out.name).toBe('Hurt Star');
  });

  it('still fills a full nine without him', async () => {
    const d = await request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=saber&dh=auto`);
    expect(d.lineup).toHaveLength(9);
    expect(new Set(d.lineup.map((l: { player_id: number }) => l.player_id)).size).toBe(9);
  });
});
