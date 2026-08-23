import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * The other half of a call-up.
 *
 * The farm page ranked minor leaguers against their own level and stopped
 * there. A reader wrote in: "the app suggests I call up 3 players, but does
 * not realise I have better players on my MLB roster." He was right — nothing
 * in it had ever looked at the major-league club. A promotion is a swap, and
 * naming only half of it is naming none of it.
 *
 * The comparison runs on OOTP's Overall grade, not the season lines, and that
 * is the only reason it can be made at all: a .900 OPS in Double-A and a .900
 * OPS in the majors are not the same achievement. The grade is scouted current
 * ability and means the same thing at every level.
 */

/** Triple-A men with a case at their own level, differing only in grade. */
const BLOCKED_BAT = 9700;
const BETTER_BAT = 9701;
/** Plays a position the big club has nobody at. */
const UNCONTESTED = 9702;
/** No grade at all, so no verdict is available either way. */
const UNGRADED = 9703;

const RF = 9;
/**
 * The one spot the fixture's big club fills with a single man, so emptying it
 * takes one deletion — and the man left behind, still on the club's team_id
 * with no roster row, is exactly the unassigned signing the rule has to ignore.
 */
const DH = 10;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Farm', ?, 22, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const grade = db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, 500, 600, 100, 100, 100, 0, ?, ?, ?, ?)`
  );
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 2, 1, 400, 350, 130, 30, 3, 20, 45, 0, 3, 2, 70, 5, 1, 60, 70, 2.5)`
  );

  // A Triple-A field to be measured against, so the level average is real
  for (let i = 0; i < 3; i++) {
    const id = 9710 + i;
    player.run(id, `Average${i}`, 7, id - 9600, IDS.aaaTeam, IDS.mlbTeam);
    grade.run(id, 40, 45, 40, 45);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, id);
    db.prepare(
      `INSERT INTO players_career_batting_stats
         (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
          bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
       VALUES (?, ?, ?, ?, 2, 1, 400, 370, 90, 15, 1, 6, 25, 0, 2, 2, 90, 3, 2, 40, 45, 0.5)`
    ).run(id, SEASON, IDS.aaaTeam, IDS.league);
  }

  /*
   * The fixture's own right fielders carry grades set for other tests, so they
   * are pinned here: every one of them clearly good, leaving exactly one weak
   * link for a call-up to displace. The question this file asks is whether the
   * app looks at the big club at all, not where the threshold sits.
   */
  db.prepare(
    `UPDATE players_value SET oa = 70, pot = 70
     WHERE player_id IN (SELECT player_id FROM players WHERE team_id = ? AND position = ?)`
  ).run(IDS.mlbTeam, RF);

  const incumbent = 9720;
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Big', 'League', 29, ?, 0, 1, 1, 55, ?, ?, 0, 0, 0, 0)`
  ).run(incumbent, RF, IDS.mlbTeam, IDS.mlbTeam);
  grade.run(incumbent, 70, 70, 70, 70);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, incumbent);

  // A weaker man at the same spot: the one a call-up would actually displace
  const weakLink = 9721;
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Weak', 'Link', 33, ?, 0, 1, 1, 56, ?, ?, 0, 0, 0, 0)`
  ).run(weakLink, RF, IDS.mlbTeam, IDS.mlbTeam);
  grade.run(weakLink, 45, 45, 45, 45);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, weakLink);

  /*
   * Empty the designated hitter's spot on the big club by taking away his
   * roster row, not the man. What is left is precisely what OOTP produces for
   * an unassigned signing: somebody carrying the parent club's team_id with no
   * place on any roster. A sixteen-year-old out of the international complex
   * is not somebody a call-up displaces, and a dozen of them once turned up
   * listed among the major-league pitchers on another page for this reason.
   */
  db.prepare(
    `DELETE FROM team_roster WHERE team_id = ? AND player_id IN
       (SELECT player_id FROM players WHERE team_id = ? AND position = ?)`
  ).run(IDS.mlbTeam, IDS.mlbTeam, DH);

  // Below both men at his spot, with a Triple-A season that earns the look
  player.run(BLOCKED_BAT, 'Blocked', RF, 71, IDS.aaaTeam, IDS.mlbTeam);
  grade.run(BLOCKED_BAT, 40, 65, 40, 65);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, BLOCKED_BAT);
  bat.run(BLOCKED_BAT, SEASON, IDS.aaaTeam, IDS.league);

  // The same season, from a man graded above the weaker of the two
  player.run(BETTER_BAT, 'Better', RF, 72, IDS.aaaTeam, IDS.mlbTeam);
  grade.run(BETTER_BAT, 55, 70, 55, 70);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, BETTER_BAT);
  bat.run(BETTER_BAT, SEASON, IDS.aaaTeam, IDS.league);

  // Plays the spot just emptied
  player.run(UNCONTESTED, 'Unblocked', DH, 73, IDS.aaaTeam, IDS.mlbTeam);
  grade.run(UNCONTESTED, 45, 60, 45, 60);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, UNCONTESTED);
  bat.run(UNCONTESTED, SEASON, IDS.aaaTeam, IDS.league);

  // Never scouted: no grade, so no comparison is possible
  player.run(UNGRADED, 'Ungraded', RF, 74, IDS.aaaTeam, IDS.mlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, UNGRADED);
  bat.run(UNGRADED, SEASON, IDS.aaaTeam, IDS.league);
});

interface Row {
  player_id: number;
  name: string;
  signal: string | null;
  move: {
    replaces: { name: string; cur: number | null } | null;
    ahead: number;
    blocked: boolean;
    note: string;
  } | null;
}

const farm = async (): Promise<Row[]> =>
  ((await request(`/api/prospects/${IDS.mlbTeam}`)).batters ?? []) as Row[];

const find = async (id: number): Promise<Row> => {
  const row = (await farm()).find((r) => r.player_id === id);
  expect(row, `player ${id} never reached the farm page`).toBeDefined();
  return row!;
};

describe('a man the big club has no room for', () => {
  it('is not recommended for a call-up', async () => {
    // The reader's complaint, exactly: three call-ups, better men already up
    const him = await find(BLOCKED_BAT);
    expect(him.signal, 'told to call up a man worse than both men at his spot').toBe('blocked');
  });

  it('says who is in his way', async () => {
    const him = await find(BLOCKED_BAT);
    expect(him.move?.blocked).toBe(true);
    expect(him.move?.ahead, 'the men in his way were not counted').toBeGreaterThanOrEqual(2);
    expect(him.move?.note).toMatch(/Big League/);
    expect(him.move?.note).toMatch(/RF/);
  });

  it('is still on the page, because he has earned it where he is', async () => {
    // He is an injury or a trade away from mattering; hiding him would lose that
    const him = await find(BLOCKED_BAT);
    expect(him.name).toBe('Farm Blocked');
  });
});

describe('a man who would improve the club', () => {
  it('is recommended', async () => {
    const him = await find(BETTER_BAT);
    expect(him.signal).toBe('promote');
  });

  it('names the man he would displace, and it is the weakest one', async () => {
    /*
     * Beating the weakest man at the spot is the least that can be asked: he
     * is not being made a starter, he is being given a place on the roster.
     */
    const him = await find(BETTER_BAT);
    expect(him.move?.blocked).toBe(false);
    expect(him.move?.replaces?.name, 'displaced the wrong man').toBe('Weak Link');
    expect(him.move?.note).toMatch(/Weak Link/);
  });
});

describe('a spot the big club has nobody at', () => {
  it('is a promotion with nobody to displace', async () => {
    const him = await find(UNCONTESTED);
    expect(him.signal).toBe('promote');
    expect(him.move?.replaces).toBeNull();
    expect(him.move?.blocked).toBe(false);
    expect(him.move?.note).toMatch(/nobody at/);
  });

  it('does not count an unassigned signing as somebody in the way', async () => {
    /*
     * OOTP parks international amateurs on the parent club's team_id with no
     * roster row at all. A dozen sixteen-year-olds once turned up listed among
     * the major-league pitchers on another page for exactly this reason.
     */
    const him = await find(UNCONTESTED);
    expect(him.move?.ahead, 'a man with no roster spot was treated as an incumbent').toBe(0);
  });
});

describe('a man nobody has scouted', () => {
  it('gets no verdict rather than a guess', async () => {
    // A recommendation resting on a blank is worse than no recommendation
    const him = await find(UNGRADED);
    expect(him.move).toBeNull();
    expect(him.signal, 'a missing grade quietly blocked him').not.toBe('blocked');
  });
});
