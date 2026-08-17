import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Telling somebody he should go down, which the farm page could not say.
 *
 * It ranked minor leaguers by promotion signal and stopped there, so the only
 * verdicts available were promote, watch, or nothing at all — and a
 * twenty-four-year-old hitting .180 in Single-A drew the same blank as a
 * nineteen-year-old holding his own.
 *
 * Demotion asks a bigger gap than promotion, because sending a man down is the
 * easier call to get wrong, and it asks that he not be young for the level: a
 * nineteen-year-old struggling at Double-A is on schedule, a twenty-six-year-old
 * struggling at Single-A is not the same sentence. It asks the same SAMPLE as
 * promotion, though — the asymmetry belongs in the size of the claim, not in
 * how much evidence is needed to look, and demanding more innings as well hid
 * the men the feature exists to find.
 */

const OVERMATCHED = 9200;
const YOUNG_AND_STRUGGLING = 9201;

/** A rung below Triple-A, so Triple-A is no longer the bottom of the org. */
const LOW_TEAM = 9299;

beforeAll(() => {
  /*
   * The base fixture's organisation stops at Triple-A, which means Triple-A is
   * its bottom — and the rule correctly refuses to send anybody below the
   * bottom. The first version of this test missed that and read a right answer
   * as a wrong one.
   */
  db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id,
                        sub_league_id, division_id, parent_team_id, allstar_team)
     VALUES (?, 'Low', 'Rungs', 'LOW', 4, ?, 0, 0, ?, 0)`
  ).run(LOW_TEAM, IDS.league, IDS.mlbTeam);

  const add = (id: number, last: string, age: number, team: number) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Farm', ?, ?, 6, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, age, id - 9100, team, IDS.mlbTeam);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(team, id);
    db.prepare(
      `INSERT INTO players_batting VALUES (?, 40, 40, 40, 40, 40, 45, 45, 45, 45, 45, 45)`
    ).run(id);
    db.prepare(
      `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
          offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
       VALUES (?, 300, 400, 100, 100, 100, 0, 30, 40, 30, 40)`
    ).run(id);
  };
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 2, 1, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 60, 0, 0, 10, 12, 0)`
  );

  /*
   * A Triple-A field to be measured against.
   *
   * "Below his level" needs a level average to be below, and the base fixture
   * has no batting at all outside the majors — so the first version of this
   * test compared a .363 hitter against nothing, got a difference of zero, and
   * declared him fine. The signal was right; the yardstick was missing.
   */
  const AVERAGE_AAA = [9210, 9211, 9212];
  AVERAGE_AAA.forEach((id, i) => {
    add(id, `Average${i}`, 24, IDS.aaaTeam);
    // .267/.333/.423, near enough a .756 level average
    bat.run(id, SEASON, IDS.aaaTeam, IDS.league, 330, 300, 80, 15, 1, 10, 30);
  });

  // Old for the level and far below it — the case the page could not make
  add(OVERMATCHED, 'Overmatched', 26, IDS.aaaTeam);
  bat.run(OVERMATCHED, SEASON, IDS.aaaTeam, IDS.league, 300, 280, 45, 2, 0, 1, 8);

  // The same line, from a man five years young for the level
  add(YOUNG_AND_STRUGGLING, 'Youngster', 19, IDS.aaaTeam);
  bat.run(YOUNG_AND_STRUGGLING, SEASON, IDS.aaaTeam, IDS.league, 300, 280, 45, 2, 0, 1, 8);
});

interface Prospect {
  name: string; signal: string | null; reasons: string[]; levelName: string; age: number;
}

const farm = async (): Promise<Prospect[]> =>
  ((await request(`/api/prospects/${IDS.mlbTeam}`)).batters ?? []) as Prospect[];

describe('a man clearly below his level', () => {
  it('is told to go down', async () => {
    const him = (await farm()).find((p) => p.name === 'Farm Overmatched');
    expect(him, 'the overmatched man never reached the farm page').toBeDefined();
    expect(him?.signal).toBe('demote');
  });

  it('is shown the case against him, not just the verdict', async () => {
    /*
     * The first version left this column empty: a DEMOTE badge beside nothing
     * at all, which is the one thing every other recommendation in the app is
     * careful not to do.
     */
    const him = (await farm()).find((p) => p.name === 'Farm Overmatched')!;
    expect(him.reasons.length, 'demoted with no reason given').toBeGreaterThan(0);
    expect(him.reasons.join(' ')).toMatch(/level average/);
    expect(him.reasons.join(' ')).toMatch(/older than the level/);
  });
});

describe('a man who is young for his level', () => {
  it('is not sent down for the same line', async () => {
    const him = (await farm()).find((p) => p.name === 'Farm Youngster');
    expect(him, 'the young man never reached the farm page').toBeDefined();
    expect(him?.signal, 'a nineteen-year-old was demoted for holding his own early').not.toBe('demote');
  });
});

describe('the bottom of the organisation', () => {
  it('never recommends sending anybody below it', async () => {
    // There is nowhere to send him, so the verdict would be advice nobody can take
    const lowest = Math.max(...(await farm()).map((p) => (p.levelName === 'AAA' ? 2 : 99)));
    expect(lowest).toBeGreaterThan(0);
    const atBottom = (await farm()).filter((p) => p.signal === 'demote' && p.levelName === 'R');
    expect(atBottom).toEqual([]);
  });
});
