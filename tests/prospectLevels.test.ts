import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A promotion case has to be made where the man is standing.
 *
 * A reader was told his Triple-A outfielder was "a statistical outlier at
 * Tacoma, posting a 1.120 OPS and 21 HR in just 181 PAs" and should be
 * considered for a call-up. Every one of the 21 was struck at Double-A; at
 * Triple-A he was hitting a flat .200. The two seasons had been added together
 * and then labelled with whichever club he happened to be on that day.
 *
 * The error was counted twice in his favour, because the same summed line was
 * then compared against the Triple-A average — so a Double-A season was being
 * measured against Triple-A pitching and called exceptional.
 *
 * The rule is now the plain one: the line he produced at the level he is at.
 * A man who has just moved up has to earn the case again there, and until he
 * has played enough to make it, no case is made for him at all.
 */

const CALLED_UP = 8500;
const AAA = 2;
const AA = 3;

beforeAll(() => {
  const year = (db.prepare(
    `SELECT MAX(year) AS y FROM players_career_batting_stats`
  ).get() as { y: number }).y;

  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Two', 'Levels', 21, 7, 0, 1, 1, 44, ?, ?, 0, 0, 0, 0)`
  ).run(CALLED_UP, IDS.aaaTeam, IDS.mlbTeam);
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, 800, 1200, 100, 100, 100, 0, 45, 60, 45, 60)`
  ).run(CALLED_UP);

  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, 8, 0, 1, 1, 30, 0, 0, 20, 25, ?)`
  );
  // The gaudy season, one level down: 120 trips, 20 home runs
  bat.run(CALLED_UP, year, IDS.aaaTeam, IDS.league, AA, 120, 110, 40, 8, 20, 3.0);
  // And what he has actually done since arriving: 80 trips, hitting .200, none
  bat.run(CALLED_UP, year, IDS.aaaTeam, IDS.league, AAA, 80, 75, 15, 2, 0, 0.0);
});

interface Prospect {
  name: string; level: number; levelName: string;
  pa: number; hr: number; opsVal: number; signal: string | null;
}

const batters = async (): Promise<Prospect[]> =>
  (await request(`/api/prospects/${IDS.mlbTeam}`)).batters as Prospect[];

describe('a prospect who has played at two levels this season', () => {
  it('is reported at the level he is playing at now', async () => {
    const him = (await batters()).find((b) => b.name === 'Two Levels');
    expect(him, 'the promoted man never appeared among the prospects').toBeDefined();
    expect(him!.levelName).toBe('AAA');
  });

  it('is not credited with the home runs he hit a level below', async () => {
    const him = (await batters()).find((b) => b.name === 'Two Levels')!;
    // Twenty at Double-A, none since arriving. The summed line said twenty.
    expect(him.hr, 'home runs from the level below were counted').toBe(0);
  });

  it('is not credited with the trips he took a level below', async () => {
    const him = (await batters()).find((b) => b.name === 'Two Levels')!;
    expect(him.pa, 'plate appearances from the level below were counted').toBe(80);
  });

  it('carries the OPS he has actually managed since arriving', async () => {
    const him = (await batters()).find((b) => b.name === 'Two Levels')!;
    /*
     * .200 with two doubles and eight walks. The combined line was over .900,
     * which is what turned into "statistical outlier" and a call-up.
     */
    expect(him.opsVal).toBeLessThan(0.6);
  });

  it('is not put forward for promotion on it', async () => {
    const him = (await batters()).find((b) => b.name === 'Two Levels')!;
    expect(him.signal).not.toBe('promote');
  });
});
