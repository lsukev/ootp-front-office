import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Hot and cold, with the pitchers in it.
 *
 * "The absence of pitchers on Hot/Cold in Front Office is very obvious, and
 * similarly OOTP list is almost void of positional players."
 *
 * Both halves of that were true. This panel read the batting logs and nothing
 * else, so a staff could be throwing the ball through a wall and it would not
 * know. He also asked why the game and the app disagree, and the answer is
 * that they are not measuring the same thing: this is the club's last seven
 * games, twelve plate appearances minimum, ranked on OPS. OOTP's own hot and
 * cold is its own reckoning over its own window, and the two were never going
 * to agree.
 *
 * They go in one list rather than two columns, because a table where half the
 * rows mean the opposite of the other half is not one table. A hitter is his
 * OPS; a pitcher is the OPS he allowed — the same arithmetic from the other
 * side, and both are in the game logs.
 *
 * Not ERA. Over a week a reliever throws three innings and one bad one owns
 * the number: on my own roster Clarke Schmidt sits at a 9.00 earned run
 * average having allowed .375, and Janson Junk at 7.36 having allowed .267.
 */

const RAKING = 9980;
const SLUMPING = 9981;
const DEALING = 9982;
const SHELLED = 9983;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Form', ?, 27, ?, ?, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  player.run(RAKING, 'Raking', 7, 0, 41, IDS.mlbTeam, IDS.mlbTeam);
  player.run(SLUMPING, 'Slumping', 8, 0, 42, IDS.mlbTeam, IDS.mlbTeam);
  player.run(DEALING, 'Dealing', 1, 11, 43, IDS.mlbTeam, IDS.mlbTeam);
  player.run(SHELLED, 'Shelled', 1, 12, 44, IDS.mlbTeam, IDS.mlbTeam);

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 1, ?, 0)`
  );
  const bat = db.prepare(
    `INSERT INTO players_game_batting
       (player_id, year, team_id, game_id, league_id, level_id, split_id, position,
        ab, h, d, t, hr, bb, hp, sf, pa, g)
     VALUES (?, ?, ?, ?, ?, 1, 0, 7, 4, ?, 0, 0, ?, 0, 0, 0, 4, 1)`
  );
  const arm = db.prepare(
    `INSERT INTO players_game_pitching_stats
       (player_id, year, team_id, game_id, league_id, level_id, split_id,
        outs, er, ha, bb, k, g, ab, tb, hp, sf)
     VALUES (?, ?, ?, ?, ?, 1, 0, 6, ?, ?, 0, 2, 1, ?, ?, 0, 0)`
  );

  db.prepare(`DELETE FROM games WHERE home_team = ? OR away_team = ?`).run(IDS.mlbTeam, IDS.mlbTeam);
  for (let i = 0; i < 7; i++) {
    const id = 8300 + i;
    game.run(id, IDS.mlbTeam, IDS.otherMlbTeam, `${SEASON}-7-${i + 1}`, IDS.league);
    // Three hits including a homer every night, and nothing at all
    bat.run(RAKING, SEASON, IDS.mlbTeam, id, IDS.league, 3, 1);
    bat.run(SLUMPING, SEASON, IDS.mlbTeam, id, IDS.league, 0, 0);
    // Two innings each: one man allows almost nothing, the other is hit hard
    arm.run(DEALING, SEASON, IDS.mlbTeam, id, IDS.league, 0, 0, 6, 0);
    arm.run(SHELLED, SEASON, IDS.mlbTeam, id, IDS.league, 4, 5, 6, 9);
  }
});

interface Row {
  player_id: number; name: string; pitcher?: boolean; ops: number; ip?: number; pa?: number;
}

const board = async (): Promise<{ hot: Row[]; cold: Row[] }> => {
  const d = await request(`/api/dashboard/${IDS.mlbTeam}`);
  return { hot: d.hot as Row[], cold: d.cold as Row[] };
};

describe('a pitcher having a good week', () => {
  it('appears among the hot, which he never could before', async () => {
    const { hot } = await board();
    const him = hot.find((p) => p.player_id === DEALING);
    expect(him, 'the staff is still invisible to this panel').toBeDefined();
    expect(him!.pitcher).toBe(true);
  });

  it('is measured on what he allowed', async () => {
    // Nothing at all off him in fourteen innings
    const him = (await board()).hot.find((p) => p.player_id === DEALING)!;
    expect(him.ops).toBe(0);
    expect(him.ip).toBeGreaterThan(0);
  });
});

describe('a pitcher being hit hard', () => {
  it('appears among the cold', async () => {
    const him = (await board()).cold.find((p) => p.player_id === SHELLED);
    expect(him, 'a man allowing an OPS over 1.000 was not called cold').toBeDefined();
    expect(him!.ops).toBeGreaterThan(0.8);
  });
});

describe('hitters and pitchers in the same list', () => {
  it('keeps both, rather than one crowding out the other', async () => {
    /*
     * The point of one table. Ranked on how far past the line a man is, so a
     * hitter and a pitcher can share it without their numbers pretending to
     * mean the same thing.
     */
    const { hot, cold } = await board();
    expect(hot.some((p) => p.pitcher), 'no pitcher made the hot list').toBe(true);
    expect(hot.some((p) => !p.pitcher), 'no hitter made the hot list').toBe(true);
    expect(cold.some((p) => p.pitcher)).toBe(true);
    expect(cold.some((p) => !p.pitcher)).toBe(true);
  });

  it('marks which is which, since the same number means the opposite', async () => {
    // .200 is a fine week for a pitcher and a dreadful one for a hitter
    const { hot } = await board();
    for (const p of hot) expect(typeof p.pitcher).toBe('boolean');
  });

  it('puts the raking hitter and the untouchable arm both at the top', async () => {
    const { hot } = await board();
    expect(hot.map((p) => p.player_id)).toContain(RAKING);
    expect(hot.map((p) => p.player_id)).toContain(DEALING);
  });
});

describe('a man with barely any week behind him', () => {
  it('is left out rather than ranked on one inning', async () => {
    /*
     * Three innings is the floor for a pitcher, because that is a reliever's
     * whole week; below it there is nothing to read.
     */
    const CAMEO = 9984;
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Form', 'Cameo', 27, 1, 12, 1, 1, 45, ?, ?, 0, 0, 0, 0)`
    ).run(CAMEO, IDS.mlbTeam, IDS.mlbTeam);
    db.prepare(
      `INSERT INTO players_game_pitching_stats
         (player_id, year, team_id, game_id, league_id, level_id, split_id,
          outs, er, ha, bb, k, g, ab, tb, hp, sf)
       VALUES (?, ?, ?, 8300, ?, 1, 0, 3, 0, 0, 0, 1, 1, 3, 0, 0, 0)`
    ).run(CAMEO, SEASON, IDS.mlbTeam, IDS.league);
    try {
      const { hot } = await board();
      expect(hot.some((p) => p.player_id === CAMEO), 'one clean inning made him hot').toBe(false);
    } finally {
      db.prepare(`DELETE FROM players_game_pitching_stats WHERE player_id = ?`).run(CAMEO);
      db.prepare(`DELETE FROM players WHERE player_id = ?`).run(CAMEO);
    }
  });
});
