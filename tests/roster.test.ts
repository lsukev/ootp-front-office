import { describe, expect, it } from 'vitest';
import request from './request';
import { IDS } from './fixture';

/**
 * players.team_id is not a roster: OOTP parks people on a club without giving
 * them a spot. Reported as complex-league signings appearing among the major
 * leaguers.
 */
describe('roster membership', () => {
  it('lists only players on the club roster list', async () => {
    const { players } = await request(`/api/roster/${IDS.mlbTeam}`);
    const names = players.map((p: { last_name: string }) => p.last_name);
    expect(names).toContain('Ular');
    expect(names).toContain('Up');
    // Parked on the club with no roster spot
    expect(names).not.toContain('Spot');
  });

  it('does not empty the affiliate, whose players are not MLB-active', async () => {
    const { players } = await request(`/api/roster/${IDS.aaaTeam}`);
    // The naive fix — reusing the is_active guard — would return nothing here
    expect(players.length).toBe(3);
    expect(players.map((p: { last_name: string }) => p.last_name).sort()).toEqual([
      'Deal', 'Draftee', 'Tioned',
    ]);
  });

  it('carries OOTP’s own 20-80 grades', async () => {
    const { players } = await request(`/api/roster/${IDS.mlbTeam}`);
    const reg = players.find((p: { last_name: string }) => p.last_name === 'Ular');
    expect(reg.oaRating).toBe(60);
  });
});

/**
 * OOTP exports the grade twice: `oa` as printed on the player's page, and
 * `oa_rating` as that grade rounded to fives. The app read the rounded one for
 * a long time and so disagreed with the game about most of the league — a 57
 * appeared as a 55. The fixture's injured star is a deliberate 62 whose
 * rounded column says 60.
 */
describe('which grade the app quotes', () => {
  it('uses the exact one OOTP prints, not the rounded one', async () => {
    const { players } = await request(`/api/roster/${IDS.mlbTeam}`);
    const him = players.find((p: { player_id: number }) => p.player_id === IDS.injured);
    expect(him.oaRating).toBe(62);
    expect(him.oaRating).not.toBe(60);
  });
});
