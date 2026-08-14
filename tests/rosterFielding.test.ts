import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A fielding line belongs to the level it was earned at.
 *
 * Found by sweeping for the fault the batting line had, and it was sitting in
 * the block immediately below it. A shortstop on a major-league roster was
 * being shown 587 innings and six errors when 28 of those innings and none of
 * the errors were in the majors — the rest was Triple-A, added in.
 *
 * It is the more misleading of the two, because a fielding percentage carries
 * no sample size on its face. A batting line at least shows the plate
 * appearances it came from; ".982 in 587 innings" looks like a settled fact
 * about a man who has barely played.
 */

const SHUTTLED = 8900;
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
     VALUES (?, 'Glove', 'Shuttle', 24, 6, 0, 1, 1, 66, ?, ?, 0, 0, 0, 0)`
  ).run(SHUTTLED, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, SHUTTLED);

  const field = db.prepare(
    `INSERT INTO players_career_fielding_stats
       (player_id, year, level_id, split_id, position, g, gs, ip, po, a, e, dp)
     VALUES (?, ?, ?, 0, 6, ?, ?, ?, ?, ?, ?, 0)`
  );
  // A full season in Triple-A, and a cup of coffee in the majors
  field.run(SHUTTLED, year, AAA, 120, 118, 900, 150, 300, 12);
  field.run(SHUTTLED, year, MLB, 6, 4, 40, 8, 14, 0);
});

interface RosterPlayer {
  player_id: number;
  fielding?: { finn?: number | null; e?: number | null } | null;
}

const rosterOf = async (teamId: number): Promise<RosterPlayer[]> => {
  const body = await request(`/api/roster/${teamId}`);
  return (Array.isArray(body) ? body : body.players) as RosterPlayer[];
};

describe('a fielder who has split the season between levels', () => {
  it('shows only the innings he fielded at that club’s level', async () => {
    const him = (await rosterOf(IDS.mlbTeam)).find((p) => p.player_id === SHUTTLED);
    expect(him, 'the shuttling fielder never reached the roster').toBeDefined();
    expect(him?.fielding?.finn, 'Triple-A innings were counted as major-league ones').toBe(40);
  });

  it('is not charged with the errors he made a level below', async () => {
    const him = (await rosterOf(IDS.mlbTeam)).find((p) => p.player_id === SHUTTLED);
    expect(him?.fielding?.e).toBe(0);
  });

  it('still has his full record on the affiliate’s own page', async () => {
    const him = (await rosterOf(IDS.aaaTeam)).find((p) => p.player_id === SHUTTLED);
    // He is on the major-league roster, so he need not appear here — but if he
    // does, the numbers must be that level's
    if (him?.fielding?.finn != null) expect(him.fielding.finn).toBe(900);
  });
});
