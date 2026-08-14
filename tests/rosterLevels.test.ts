import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A roster line is what the man did on that roster.
 *
 * A reader watched the trade desk put forward an opposing outfielder as "the
 * best position-player season on that roster — .313/.372/.552, 155 wRC+" and
 * asked the obvious question: are those Triple-A numbers? They were. He had
 * shuttled, and his lines at each level had been added together and served as
 * one major-league season.
 *
 * The scaling made it worse rather than exposing it. wRC+ and OPS+ are worked
 * out against the club's own league, so a Triple-A line arriving on a
 * major-league roster was measured against major-league pitching — which is
 * how an ordinary Triple-A season came out at 155 and got itself recommended.
 *
 * The roster endpoint feeds the Rosters page, the staff chat's get_roster and
 * the trade desk, so all three were being told the same thing.
 */

const SHUTTLED = 8600;
const MLB = 1;
const AAA = 2;

beforeAll(() => {
  const year = (db.prepare(
    `SELECT MAX(year) AS y FROM players_career_batting_stats`
  ).get() as { y: number }).y;

  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Up', 'Down', 25, 8, 0, 1, 1, 55, ?, ?, 0, 0, 0, 0)`
  ).run(SHUTTLED, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, SHUTTLED);
  db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 0, 1.0, 172, 40)`
  ).run(SHUTTLED);

  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, 30, 0, 0, 25, 30, ?)`
  );
  // Triple-A, where he spent most of the year and hit everything in sight
  bat.run(SHUTTLED, year, IDS.aaaTeam, IDS.league, AAA, 300, 270, 95, 20, 18, 28, 3.5);
  // And the major-league season the roster page is actually reporting on:
  // six hits in thirty-eight tries, one walk, nothing for extra bases
  bat.run(SHUTTLED, year, IDS.mlbTeam, IDS.league, MLB, 40, 38, 6, 0, 0, 1, -0.2);
});

interface Batting { pa: number | null; h: number | null; hr: number | null; wrcPlus: number | null }
interface RosterPlayer { player_id: number; last_name: string; batting?: Batting | null }

const rosterOf = async (teamId: number): Promise<RosterPlayer[]> => {
  const body = await request(`/api/roster/${teamId}`);
  return (Array.isArray(body) ? body : body.players) as RosterPlayer[];
};

const him = async (teamId: number): Promise<RosterPlayer | undefined> =>
  (await rosterOf(teamId)).find((p) => p.player_id === SHUTTLED);

describe('a shuttling player on a major-league roster', () => {
  it('is listed there', async () => {
    expect(await him(IDS.mlbTeam)).toBeDefined();
  });

  it('carries only his major-league plate appearances', async () => {
    const p = await him(IDS.mlbTeam);
    // 40 in the majors, 300 in Triple-A. The summed line said 340.
    expect(p?.batting?.pa, 'Triple-A trips were counted as major-league ones').toBe(40);
  });

  it('is not credited with the home runs he hit in Triple-A', async () => {
    const p = await him(IDS.mlbTeam);
    expect(p?.batting?.hr).toBe(0);
  });

  it('is not made to look good by scaling a Triple-A line against the majors', async () => {
    const p = await him(IDS.mlbTeam);
    /*
     * .158/.179/.158. Combined with the Triple-A season he was over .300 with
     * eighteen home runs, and that is the line which came out at 155 against
     * major-league pitching and got the reader's man recommended.
     */
    // The exact figure moves with the fixture league's own baseline, so what
    // is pinned here is the direction: well below average, not well above
    expect(p?.batting?.wrcPlus ?? 999).toBeLessThan(70);
  });
});

describe('the affiliate roster', () => {
  it('still carries its own players and their own lines', async () => {
    const list = await rosterOf(IDS.aaaTeam);
    expect(list.length, 'scoping to the level emptied the affiliate page').toBeGreaterThan(0);
  });
});
