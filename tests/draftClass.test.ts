import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who is in this year's draft class.
 *
 * Two readers, the same wrong answer from opposite ends. "The draft feature
 * does not filter players by year of eligibility... many of the players listed
 * were not eligible for that draft, but were future draft prospects (i.e.,
 * 2028 or 2029 for the 2027 draft)." And: "the draft board function aren't
 * including the JuCo prospect."
 *
 * draft_eligible does not mean eligible this year. In my own save it is set on
 * every school class at once — all three hundred high-school freshmen carry
 * it, the youngest of them fourteen — so reading it put 2,177 men on a board
 * whose class is 908.
 *
 * The school class is what carries the year: seniors, junior college in either
 * year, and college juniors and seniors. Underclassmen age into it on their
 * own, so nothing has to know what year it is.
 */

const CLASS = {
  hsFreshman: 1, hsSenior: 4, jucoFirst: 5, jucoSecond: 6,
  collegeFreshman: 7, collegeJunior: 9, collegeSenior: 10,
} as const;

const P = {
  freshman: 8601, senior: 8602, jucoA: 8603, jucoB: 8604,
  collegeFrosh: 8605, junior: 8606, drafted: 8607,
};

beforeAll(() => {
  const add = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college, hsc_status, draft_league_id, picked_in_draft)
     VALUES (?, ?, 'Prospect', ?, 6, 0, 1, 1, 0, 0, 0, 0, 0, 1, ?, ?, ?, ?)`
  );
  // Every one of them flagged draft_eligible, which is what the save does
  add.run(P.freshman, 'Fourteen', 14, 0, CLASS.hsFreshman, IDS.league, 0);
  add.run(P.senior, 'Senior', 18, 0, CLASS.hsSenior, IDS.league, 0);
  add.run(P.jucoA, 'Juco', 19, 1, CLASS.jucoFirst, IDS.league, 0);
  add.run(P.jucoB, 'Juco', 20, 1, CLASS.jucoSecond, IDS.league, 0);
  add.run(P.collegeFrosh, 'Underclassman', 19, 1, CLASS.collegeFreshman, IDS.league, 0);
  add.run(P.junior, 'Junior', 21, 1, CLASS.collegeJunior, IDS.league, 0);
  // Already taken, flag still set — which OOTP leaves set after the pick
  add.run(P.drafted, 'Gone', 21, 1, CLASS.collegeJunior, IDS.league, 1);

  const bat = db.prepare(
    `INSERT INTO players_batting VALUES (?, 40, 40, 40, 40, 40, 50, 50, 50, 50, 50, 50)`
  );
  for (const id of Object.values(P)) bat.run(id);
});

const board = async (): Promise<Array<{ player_id: number; age: number }>> =>
  ((await request(`/api/draft/${IDS.mlbTeam}`)).prospects ?? []) as Array<{
    player_id: number; age: number;
  }>;

const on = async (id: number) => (await board()).some((p) => p.player_id === id);

describe('the class on the board', () => {
  it('has the high-school seniors', async () => {
    expect(await on(P.senior)).toBe(true);
  });

  it('has the college juniors', async () => {
    expect(await on(P.junior)).toBe(true);
  });

  /* The second of the two reports: JuCo men are draftable in either year. */
  it('has the junior-college men, in both their years', async () => {
    expect(await on(P.jucoA), 'a first-year JuCo prospect was missing').toBe(true);
    expect(await on(P.jucoB), 'a second-year JuCo prospect was missing').toBe(true);
  });

  /*
   * The first report. A fourteen-year-old is not a 2027 draft pick, he is a
   * 2031 one, and he carries the same eligibility flag as everybody else.
   */
  it('leaves out the schoolboys who are years away', async () => {
    expect(await on(P.freshman), 'a 14-year-old freshman was on the board').toBe(false);
  });

  it('leaves out college underclassmen, who are not eligible either', async () => {
    expect(await on(P.collegeFrosh)).toBe(false);
  });

  it('leaves out a man already taken', async () => {
    expect(await on(P.drafted)).toBe(false);
  });

  it('puts nobody on the board who is too young to be in the class', async () => {
    const ages = (await board()).map((p) => p.age);
    expect(Math.min(...ages)).toBeGreaterThan(16);
  });
});
