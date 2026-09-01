import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { nextGames } from '../server/dashboard.js';
import { assembleDay, lastPlayedDate } from '../server/recap.js';
import { competitiveGamesSql, postseason, regularSeasonEnd } from '../server/postseason.js';
import { IDS } from './fixture.js';

/**
 * October.
 *
 * "Wild Card games are over, Division Series are about to start today. On
 * Dashboard page 'Up Next' table is empty, League's Daily Recap doesn't
 * generate anything new after last game day of the regular season, there is no
 * mention of Wild Card games anywhere, The Paper hasn't generated any new
 * content past regular season end."
 *
 * Four symptoms and one cause: every screen that asked the schedule a question
 * filtered on `game_type = 0`, so the app's year ended with the regular
 * season. The tests below put a save in exactly the state he described — wild
 * card round finished, division series about to begin — and hold each of the
 * four.
 *
 * The postseason is found by when it happens rather than by a game type,
 * because no save I have here carries a playoff game to learn the type from,
 * and a number guessed at would be a number wrong in somebody else's save.
 */

const REG_END = '2027-10-1';
const WILDCARD_DAY = '2027-10-3';
const DIVISION_DAY = '2027-10-5';
/** Two clubs beyond the fixture's own, to fill a bracket. */
const EXTRA = [7301, 7302];

function october(options: { divisionSeriesPlayed?: boolean } = {}) {
  db.prepare(`DELETE FROM games`).run();
  db.prepare(`DELETE FROM league_playoff_fixtures`).run();
  db.prepare(`DELETE FROM league_playoffs`).run();
  db.prepare(`INSERT INTO league_playoffs (league_id, num_wild_cards) VALUES (?, 1)`).run(IDS.league);

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, ?, ?, ?, 1, ?, 0, 1, 0, 0)`
  );
  for (const id of EXTRA) {
    try { team.run(id, `Club ${id}`, 'Nine', `C${id}`, IDS.league); } catch { /* already there */ }
  }

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, game_type, league_id,
                        runs0, runs1, innings, time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 9, 1300)`
  );
  // A regular season, played out
  let id = 30000;
  for (let i = 0; i < 5; i += 1) {
    game.run(id += 1, IDS.mlbTeam, IDS.otherMlbTeam, `2027-9-2${i}`, 1, 0, IDS.league, 4, 2);
  }
  game.run(id += 1, IDS.mlbTeam, IDS.otherMlbTeam, REG_END, 1, 0, IDS.league, 5, 3);
  // Spring training, played back in March and never a "next game"
  game.run(id += 1, IDS.mlbTeam, IDS.otherMlbTeam, '2027-3-2', 1, 2, IDS.league, 1, 0);

  /*
   * The postseason, which OOTP writes with a game type this app deliberately
   * does not name. Two days after the regular season ended.
   */
  game.run(id += 1, IDS.mlbTeam, IDS.otherMlbTeam, WILDCARD_DAY, 1, 9, IDS.league, 6, 2);
  game.run(id += 1, IDS.mlbTeam, EXTRA[0], DIVISION_DAY, options.divisionSeriesPlayed ? 1 : 0, 9,
           IDS.league, options.divisionSeriesPlayed ? 3 : 0, options.divisionSeriesPlayed ? 1 : 0);

  // The bracket: wild card round finished, division series under way
  const fixture = db.prepare(
    `INSERT INTO league_playoff_fixtures
       (league_id, team_id0, team_id1, winner, finished, best_of, played, round, result0, result1)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  fixture.run(IDS.league, IDS.mlbTeam, IDS.otherMlbTeam, IDS.mlbTeam, 1, 3, 3, 1, 2, 1);
  fixture.run(IDS.league, EXTRA[0], EXTRA[1], 0, 0, 5, 1, 2, 1, 0);
}

describe('what counts as a game', () => {
  beforeEach(() => october());

  it('knows when the regular season ended', () => {
    expect(regularSeasonEnd(IDS.league)).toBe(20271001);
  });

  it('counts the regular season and everything after it', () => {
    const sql = competitiveGamesSql('g', IDS.league);
    const count = (where: string) =>
      (db.prepare(`SELECT COUNT(*) AS n FROM games g WHERE ${where}`).get() as { n: number }).n;
    // Six regular-season games, two in October, and the March exhibition left out
    expect(count(sql)).toBe(8);
    expect(count(`${sql} AND g.game_type != 0`)).toBe(2);
  });

  it('falls back to the regular season alone when the last day cannot be found', () => {
    db.prepare(`DELETE FROM games`).run();
    expect(competitiveGamesSql('g', IDS.league)).toBe('g.game_type = 0');
  });
});

/** The reported symptom, one test each. */
describe('the four things that stopped in October', () => {
  beforeEach(() => october());

  it('has something in Up Next once the regular season is over', () => {
    const next = nextGames(IDS.mlbTeam, 5);
    expect(next.length).toBeGreaterThan(0);
    expect(next[0].date).toBe(DIVISION_DAY);
  });

  it('moves the recap on to the postseason day rather than stopping at the season', () => {
    expect(lastPlayedDate(IDS.league)).toBe('2027-10-03');
  });

  it('writes up the postseason games played that day', () => {
    const day = assembleDay(IDS.mlbTeam);
    expect(day.date).toBe('2027-10-03');
    expect(day.games.length).toBe(1);
    // runs0 is the away club's, which is OOTP's own order and not the obvious one
    expect(day.games[0].awayRuns).toBe(6);
    expect(day.games[0].homeRuns).toBe(2);
  });

  it('gives the recap and the paper the bracket to write from', () => {
    expect(assembleDay(IDS.mlbTeam).postseason).not.toBeNull();
  });
});

describe('the bracket', () => {
  beforeEach(() => october());

  it('names the rounds as the export names them', () => {
    const p = postseason(IDS.league)!;
    expect(p.rounds.map((r) => r.name)).toEqual(['Wildcard Series', 'Division Series']);
  });

  it('reports a finished series as won and a live one as led', () => {
    const p = postseason(IDS.league)!;
    expect(p.rounds[0].series[0].summary).toMatch(/won 2-1$/);
    expect(p.rounds[0].series[0].finished).toBe(true);
    expect(p.rounds[1].series[0].summary).toMatch(/lead 1-0$/);
    expect(p.rounds[1].series[0].finished).toBe(false);
  });

  it('is active while a series is still being played', () => {
    const p = postseason(IDS.league)!;
    expect(p.active).toBe(true);
    expect(p.currentRound).toBe('Division Series');
    expect(p.champion).toBeNull();
  });

  it('does not repeat the matchup as the line beneath it', () => {
    const yetToStart = postseason(IDS.league)!.rounds[1].series[0];
    db.prepare(`UPDATE league_playoff_fixtures SET result0 = 0, played = 0 WHERE round = 2`).run();
    expect(postseason(IDS.league)!.rounds[1].series[0].summary).toBe('Yet to begin');
    void yetToStart;
  });

  it('carries the best-of for each round', () => {
    const p = postseason(IDS.league)!;
    expect(p.rounds[0].bestOf).toBe(3);
    expect(p.rounds[1].bestOf).toBe(5);
  });

  /*
   * Whether OOTP numbers the first round 0 or 1 is not assumed — the earliest
   * round in the bracket is the first one, whatever it is called.
   */
  it('names the rounds right whichever number the bracket starts at', () => {
    db.prepare(`UPDATE league_playoff_fixtures SET round = round - 1`).run();
    expect(postseason(IDS.league)!.rounds.map((r) => r.name))
      .toEqual(['Wildcard Series', 'Division Series']);
  });

  it('crowns a champion when the last series is won, and only then', () => {
    db.prepare(`DELETE FROM league_playoff_fixtures WHERE round = 2`).run();
    db.prepare(
      `INSERT INTO league_playoff_fixtures
         (league_id, team_id0, team_id1, winner, finished, best_of, played, round, result0, result1)
       VALUES (?, ?, ?, ?, 1, 7, 5, 2, 4, 1)`
    ).run(IDS.league, IDS.mlbTeam, IDS.otherMlbTeam, IDS.mlbTeam);
    const p = postseason(IDS.league)!;
    expect(p.champion?.team_id).toBe(IDS.mlbTeam);
    expect(p.active).toBe(false);
  });

  it('says nothing at all for the eleven months there is no bracket', () => {
    db.prepare(`DELETE FROM league_playoff_fixtures`).run();
    expect(postseason(IDS.league)).toBeNull();
  });

  /*
   * A bracket can carry a round nobody has reached, with no clubs in it. That
   * is not a series between two teams called Unknown.
   */
  it('leaves out a round whose clubs are not decided yet', () => {
    db.prepare(
      `INSERT INTO league_playoff_fixtures
         (league_id, team_id0, team_id1, winner, finished, best_of, played, round, result0, result1)
       VALUES (?, 0, 0, 0, 0, 7, 0, 3, 0, 0)`
    ).run(IDS.league);
    const p = postseason(IDS.league)!;
    expect(p.rounds).toHaveLength(2);
  });
});
