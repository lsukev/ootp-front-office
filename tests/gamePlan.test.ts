import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The game plan, on exports that are not shaped like mine.
 *
 * A reader updated, opened the schedule, pressed Plan, and got "500 Internal
 * Server Error" on every game in it. The endpoint asked games.csv for
 * `starter0` and `starter1` — the pitchers a PLAYED game recorded — without
 * checking they were there, and OOTP does not put them in every export. One
 * missing column, and the whole feature was dead for that save.
 *
 * The endpoint had no test at all, which is how a query could name a column
 * nobody had confirmed was universal. These cover the shapes an export can
 * come in rather than only the one on this machine: the fixture's `games`
 * table has no starter columns, so simply asking for a plan is the regression
 * test for the fault that was reported.
 */

const OPP_BAT = 9400;
const OPP_ARM = 9401;
const GAME = 7700;

beforeAll(() => {
  db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id)
     VALUES (?, ?, ?, '2026-05-01', 0, ?)`
  ).run(GAME, IDS.mlbTeam, IDS.otherMlbTeam, IDS.league);

  // Somebody for the opponent, so the scouting half has a roster to read
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Opp', 'Slugger', 27, 7, 0, 1, 1, 44, ?, ?, 0, 0, 0, 0)`
  ).run(OPP_BAT, IDS.otherMlbTeam, IDS.otherMlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.otherMlbTeam, OPP_BAT);

  // The man they have lined up for this one. Only the projected rotation names
  // him, since the game has not been played and games.csv names nobody.
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Opp', 'Ace', 29, 1, 11, 1, 2, 31, ?, ?, 0, 0, 0, 0)`
  ).run(OPP_ARM, IDS.otherMlbTeam, IDS.otherMlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.otherMlbTeam, OPP_ARM);
  db.prepare(`INSERT INTO projected_starting_pitchers VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0)`)
    .run(IDS.otherMlbTeam, OPP_ARM);
});

interface Plan {
  game: { game_id: number; date: string; isHome: boolean; opponent: { label: string } };
  starter: { name: string; confirmed: boolean } | null;
  lineupVs: string;
  matchups: { vsPitcher: unknown[]; vsTeam: unknown[] };
  opponent: { dangerous: unknown[] };
  missing: string[];
}

const plan = (): Promise<Plan> => request(`/api/game-plan/${IDS.mlbTeam}/${GAME}`);

describe('an export with no named starters in games.csv', () => {
  it('still produces a plan', async () => {
    // The exact shape that returned a 500 on every game in the schedule
    const p = await plan();
    expect(p.game.game_id).toBe(GAME);
    expect(p.game.opponent.label).toBe('Other Club');
  });

  it('falls back to the projected rotation and says it is a projection', async () => {
    /*
     * No loss: the named starter is only filled in for a game already played,
     * and a plan is for a game that has not been.
     */
    const p = await plan();
    expect(p.starter, 'no starter found for an upcoming game').not.toBeNull();
    expect(p.starter?.name).toBe('Opp Ace');
    expect(p.starter?.confirmed, 'a projected starter was presented as confirmed').toBe(false);
    // He throws left, so the card is built against a lefty
    expect(p.lineupVs).toBe('l');
  });
});

describe('an export missing the head-to-head tables', () => {
  it('answers with empty matchups rather than failing', async () => {
    // The fixture has neither, which is the point — they are optional exports
    const p = await plan();
    expect(p.matchups.vsPitcher).toEqual([]);
    expect(p.matchups.vsTeam).toEqual([]);
  });
});

describe('at-bat rows without the ball-tracking columns', () => {
  it('does not read them as batted balls', async () => {
    /*
     * Exit velocity and launch angle are a newer addition to the export. The
     * table existing was taken as proof they were there, so a save with the
     * older shape threw "no such column" out of the scouting half.
     */
    db.exec(`CREATE TABLE players_at_bat_batting_stats (
               player_id INTEGER, game_id INTEGER, opponent_player_id INTEGER,
               team_id INTEGER, result INTEGER)`);
    db.prepare(`INSERT INTO players_at_bat_batting_stats VALUES (?, ?, ?, ?, 6)`)
      .run(OPP_BAT, GAME, IDS.extended, IDS.otherMlbTeam);
    try {
      const p = await plan();
      expect(p.opponent.dangerous).toEqual([]);
    } finally {
      db.exec('DROP TABLE players_at_bat_batting_stats');
    }
  });
});

describe('a save with no team_roster', () => {
  it('reads the club instead of refusing', async () => {
    // Better a plan built from everyone on the club than no plan at all
    const saved = db.prepare(`SELECT team_id, player_id, list_id FROM team_roster`).all() as Array<{
      team_id: number; player_id: number; list_id: number;
    }>;
    db.exec('DROP TABLE team_roster');
    try {
      const p = await plan();
      expect(p.game.game_id).toBe(GAME);
    } finally {
      db.exec('CREATE TABLE team_roster (team_id INTEGER, player_id INTEGER, list_id INTEGER)');
      const put = db.prepare('INSERT INTO team_roster VALUES (?, ?, ?)');
      for (const r of saved) put.run(r.team_id, r.player_id, r.list_id);
    }
  });
});

describe('when something does go wrong', () => {
  it('says what, instead of an HTML page the reader cannot report', async () => {
    /*
     * The whole reason this bug took a round-trip to diagnose. Express answers
     * a thrown error with HTML; the client looks for JSON and fell back to
     * printing the status line, so the reader had "500 Internal Server Error"
     * and the actual message went to a log nobody opens.
     */
    await plan(); // publishes the port
    const base = `http://127.0.0.1:${process.env.OOTP_FO_PORT}`;
    db.exec('ALTER TABLE players RENAME TO players_hidden_for_test');
    try {
      const res = await fetch(`${base}/api/game-plan/${IDS.mlbTeam}/${GAME}`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type')).toMatch(/json/);
      const body = (await res.json()) as { error?: string };
      expect(body.error, 'a 500 with nothing in it').toBeTruthy();
      expect(body.error).toMatch(/players/);
    } finally {
      db.exec('ALTER TABLE players_hidden_for_test RENAME TO players');
    }
  });
});

describe('an optional half of the plan that cannot be read', () => {
  it('costs that half and not the page', async () => {
    /*
     * The history and the scouting read parts of the export that differ
     * between versions of the game. Before this, one unfamiliar column
     * anywhere in either meant no plan at all on every game in the schedule —
     * not a thinner plan, no plan. The core of it (who you are playing, who is
     * pitching, which hand to build the card against) depends on neither.
     *
     * `players.retired` stands in for that unfamiliar column here: both halves
     * read it to find the position players on a club, and nothing in the core
     * does.
     */
    db.exec('ALTER TABLE players DROP COLUMN retired');
    try {
      const p = await plan();
      expect(p.game.game_id, 'the whole plan died with one optional panel').toBe(GAME);
      expect(p.starter?.name, 'the starter went with it').toBe('Opp Ace');
      expect(p.matchups.vsPitcher).toEqual([]);
      expect(p.opponent.dangerous).toEqual([]);
      expect(p.missing.length, 'the blank panels were left unexplained').toBeGreaterThan(0);
    } finally {
      db.exec('ALTER TABLE players ADD COLUMN retired INTEGER DEFAULT 0');
    }
  });

  it('says nothing is missing when nothing is', async () => {
    const p = await plan();
    expect(p.missing).toEqual([]);
  });
});
