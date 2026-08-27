import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * What day it is, on a page headed "availability tonight".
 *
 * A reader: "Bullpen Availability Tonight is off by one day for every pitcher.
 * Where it says today, it should say yesterday; yesterday -> 2 days ago; 2d ->
 * 3d. Availability itself and number of pitches thrown is correct."
 *
 * He had it exactly. The page asked the games table for the newest date it
 * held and called that today — but he exports after simming, so the newest
 * games in the file are the ones just played and the league has already moved
 * on to the next morning. Every label was a day stale while the arithmetic
 * under them, done in whole days from the same rows, was right.
 *
 * Tonight's game is by definition the one that has not been played. Asking the
 * games table when now is could only ever answer with the past.
 */

/** The league has moved on to the seventeenth; the last games were the sixteenth. */
const LEAGUE_TODAY = '2030-5-17';
const THREW_YESTERDAY = 9900;
const THREW_TWO_DAYS_AGO = 9901;

beforeAll(() => {
  db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 1, ?, 0)`
  );
  game.run(8900, IDS.mlbTeam, IDS.otherMlbTeam, '2030-5-16', IDS.league);
  game.run(8901, IDS.mlbTeam, IDS.otherMlbTeam, '2030-5-15', IDS.league);

  const arm = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Relief', ?, 28, 1, 12, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 1, 0, 0, 0, 3.0, 516, 40)`
  );
  const threw = db.prepare(
    `INSERT INTO players_game_pitching_stats (player_id, game_id, pi, outs, gs) VALUES (?, ?, ?, 3, 0)`
  );

  arm.run(THREW_YESTERDAY, 'Yesterday', 61, IDS.mlbTeam, IDS.mlbTeam);
  status.run(THREW_YESTERDAY);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, THREW_YESTERDAY);
  threw.run(THREW_YESTERDAY, 8900, 15);

  arm.run(THREW_TWO_DAYS_AGO, 'Twodays', 62, IDS.mlbTeam, IDS.mlbTeam);
  status.run(THREW_TWO_DAYS_AGO);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, THREW_TWO_DAYS_AGO);
  threw.run(THREW_TWO_DAYS_AGO, 8901, 18);
});

interface Staff {
  today: number | null;
  bullpen: Array<{ player_id: number; name: string; status: string }>;
}

const staff = (): Promise<Staff> => request(`/api/pitching/${IDS.mlbTeam}`);
const find = async (id: number) => {
  const s = await staff();
  const p = s.bullpen.find((b) => b.player_id === id);
  expect(p, `pitcher ${id} never reached the bullpen table`).toBeDefined();
  return p!;
};

describe('the day the page thinks it is', () => {
  it('is the league\'s own date, not the last one played', async () => {
    // 2030-05-17, while the newest game in the file is the sixteenth
    expect((await staff()).today).toBe(20300517);
  });
});

describe('a man who threw in the last game played', () => {
  it('is described as having thrown yesterday, not today', async () => {
    /*
     * The heart of the report. He is not pitching back-to-back if he goes
     * tonight — he had a day off in between, and the page said otherwise.
     */
    const him = await find(THREW_YESTERDAY);
    expect(him.status).toMatch(/yesterday/);
    expect(him.status, 'the last game played was called today').not.toMatch(/today/);
  });

  it('still reports the pitches he actually threw', async () => {
    // What was right stayed right: only the naming of the day was wrong
    expect((await find(THREW_YESTERDAY)).status).toMatch(/15/);
  });
});

describe('a man who threw the game before that', () => {
  it('is two days rested rather than one', async () => {
    const him = await find(THREW_TWO_DAYS_AGO);
    expect(him.status).toMatch(/2d|two/i);
    expect(him.status).not.toMatch(/yesterday/);
  });
});

describe('an export with no league date in it', () => {
  it('falls back to the last day played rather than giving up', async () => {
    // A real day, and close; it is simply not this one
    db.prepare(`UPDATE leagues SET "current_date" = NULL WHERE league_id = ?`).run(IDS.league);
    try {
      expect((await staff()).today).toBe(20300516);
    } finally {
      db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);
    }
  });

  it('never reads a league date behind the last game as now', async () => {
    /*
     * Not something OOTP produces, but reading it would put appearances in the
     * future and turn every count negative.
     */
    db.prepare(`UPDATE leagues SET "current_date" = '2030-1-1' WHERE league_id = ?`).run(IDS.league);
    try {
      expect((await staff()).today).toBe(20300516);
    } finally {
      db.prepare(`UPDATE leagues SET "current_date" = ? WHERE league_id = ?`).run(LEAGUE_TODAY, IDS.league);
    }
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('a tooltip over a table of rating bars', () => {
  it('is painted above the rows, not under them', () => {
    /*
     * The same reader called this one semi-transparent, which is what it looks
     * like: the rating bars from the rows beneath showed straight through the
     * tooltip. It is not transparent. `position: sticky` creates a stacking
     * context whatever its z-index, and without one the header sat at the same
     * level as the positioned cells in the body — which come later in the
     * document and therefore paint on top. Proved by hit-testing a point
     * inside the tooltip: with no z-index the topmost element there is a
     * rating number; with one it is the tooltip.
     */
    const css = read('src/styles.css');
    const th = /th \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(th, 'the sticky header has no stacking level').toMatch(/z-index:\s*\d+/);
    expect(th).toMatch(/position:\s*sticky/);
  });

  it('still sits below the things that are meant to cover it', () => {
    // The import bar and the player modal both belong over a table header
    const css = read('src/styles.css');
    const level = (re: RegExp) => Number(re.exec(css)?.[1] ?? 0);
    const header = level(/th \{[^}]*z-index:\s*(\d+)/);
    expect(header).toBeLessThan(level(/\.import-bar \{[^}]*z-index:\s*(\d+)/));
    expect(header).toBeLessThan(level(/\.modal-backdrop \{[^}]*z-index:\s*(\d+)/));
  });
});
