import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { clearTwoWayCache, twoWayBatters, twoWayPitchers } from '../server/twoway.js';
import { IDS } from './fixture.js';

/**
 * Players who belong in both halves of the club.
 *
 * The roster was split on a man's one listed position, so a two-way player
 * vanished from one side: Ohtani is listed at designated hitter, and eighty-six
 * innings of his never reached the Pitching Staff page.
 *
 * Judged on what he has done rather than on his ratings, because the scale
 * ratings sit on is the user's setting — a threshold that reads well at 20-80
 * is nonsense at 1-5. Innings and plate appearances mean the same thing in
 * every save.
 *
 * The threshold matters more than it looks. Asking merely whether a man had
 * done a little of the other thing swept up seventy-three players in a real
 * league: outfielders who mopped up an innings of a blowout, and every pitcher
 * in the minors, where there is often no designated hitter and they all bat.
 */

const REAL_TWO_WAY = 8400;   // does both, properly
const MOP_UP = 8401;         // an outfielder who threw an innings in a rout
const PITCHER_WHO_BATS = 8402; // a pitcher in a league without the DH
const YEAR = 2030;

const addPlayer = (id: number, position: number, last: string) =>
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Two', ?, 27, ?, 0, 1, 1, 0, ?, ?, 0, 0, 0, 0)`
  ).run(id, last, position, IDS.mlbTeam, IDS.mlbTeam);

const bat = (id: number, pa: number) =>
  db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, 0,0,0,0, 0,0,0,0,0,0,0,0,0, 0)`
  ).run(id, YEAR, IDS.mlbTeam, IDS.league, pa, pa);

const pitch = (id: number, outs: number) =>
  db.prepare(
    `INSERT INTO players_career_pitching_stats
       (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k,
        hra, hp, bf, g, gs, w, l, s, hld, war)
     VALUES (?, ?, ?, ?, 1, 1, ?, 0,0,0,0,0, 0,0,0,0,0,0,0,0,0, 0)`
  ).run(id, YEAR, IDS.mlbTeam, IDS.league, outs);

beforeAll(() => {
  addPlayer(REAL_TWO_WAY, 10, 'Ways');       // listed at DH
  bat(REAL_TWO_WAY, 340); pitch(REAL_TWO_WAY, 258);   // 340 PA, 86 IP

  addPlayer(MOP_UP, 9, 'Mopup');             // an outfielder
  bat(MOP_UP, 240); pitch(MOP_UP, 6);        // 240 PA, 2 IP

  addPlayer(PITCHER_WHO_BATS, 1, 'Hurler');  // a pitcher
  bat(PITCHER_WHO_BATS, 40); pitch(PITCHER_WHO_BATS, 300); // bats a little, as pitchers do
  clearTwoWayCache();
});

describe('spotting a two-way player', () => {
  it('counts the man who genuinely does both', () => {
    expect(twoWayPitchers().has(REAL_TWO_WAY)).toBe(true);
  });

  it('does not count an outfielder who mopped up an innings', () => {
    expect(twoWayPitchers().has(MOP_UP)).toBe(false);
  });

  it('does not count a pitcher merely for taking his turns at bat', () => {
    // Otherwise every pitcher in a league without the DH becomes two-way
    expect(twoWayBatters().has(PITCHER_WHO_BATS)).toBe(false);
  });

  it('sorts a man by the side the app would otherwise miss him on', () => {
    // Listed at DH, so it is the pitching half that needs telling
    expect(twoWayPitchers().has(REAL_TWO_WAY)).toBe(true);
    expect(twoWayBatters().has(REAL_TWO_WAY)).toBe(false);
  });
});
