import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { historyDb } from '../server/history.js';
import { loadConfig } from '../server/config.js';
import { assembleWindow, recapWindow } from '../server/recap.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Leagues that sim a week between exports.
 *
 * "Many OOTP online leagues use a 7-day schedule. So, rather than the
 * newspaper showing the last day's news/results, show the prior week's."
 *
 * The paper and the recap both wrote up `lastPlayedDate` and nothing else, so
 * a league that sims Monday to Sunday and exports once got an issue about
 * Sunday. Six days of its own season — the week's races, the week's deals, the
 * week's form — simply were not in the data the model was handed, and nothing
 * on the page said so.
 *
 * The window is worked out rather than configured. Every import stamps a
 * ratings snapshot with the save's game date, so the snapshot before the
 * current one is the day the reader last looked, and the gap between them is
 * the league's own cadence. The two cases that matter most are the ones where
 * nothing should change: a daily league, and a reader on his first import.
 */

const SAVE = loadConfig().saveName ?? 'unknown';

/** Dates as OOTP writes them — unpadded, which is how they arrive. */
const WEEK = ['2030-6-1', '2030-6-2', '2030-6-3', '2030-6-4', '2030-6-5', '2030-6-6', '2030-6-7'];
const LAST_WEEK = '2030-5-20';

function snapshots(...dates: string[]): void {
  historyDb.prepare(`DELETE FROM rating_snapshots WHERE save_name = ?`).run(SAVE);
  const ins = historyDb.prepare(
    `INSERT OR REPLACE INTO rating_snapshots (save_name, game_date, player_id, name)
     VALUES (?, ?, 1, 'Somebody')`
  );
  for (const d of dates) ins.run(SAVE, d);
}

beforeAll(() => {
  db.prepare(`INSERT INTO divisions VALUES (?, 0, 1, 'East Division', 0)`).run(IDS.league);
  db.prepare(`UPDATE teams SET division_id = 1 WHERE team_id IN (?, ?)`)
    .run(IDS.mlbTeam, IDS.otherMlbTeam);
  const rec = db.prepare(
    `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
     VALUES (?, 40, ?, ?, 0, ?, 0.5, 0, 1, 0)`
  );
  rec.run(IDS.mlbTeam, 25, 15, 1);
  rec.run(IDS.otherMlbTeam, 20, 20, 2);

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type,
                        runs0, runs1, innings)
     VALUES (?, ?, ?, ?, 1, ?, 0, ?, ?, 9)`
  );
  // The week that was just simmed, one game a day
  WEEK.forEach((d, i) => game.run(8900 + i, IDS.mlbTeam, IDS.otherMlbTeam, d, IDS.league, i, i + 1));
  // A game from before the reader's last export, which belongs to the last issue
  game.run(8890, IDS.mlbTeam, IDS.otherMlbTeam, LAST_WEEK, IDS.league, 1, 0);
});

beforeEach(() => snapshots('2030-5-31', '2030-6-7'));

describe('the stretch an issue covers', () => {
  it('is the whole week where a week was simmed', () => {
    const w = recapWindow(IDS.league)!;
    expect(w.from).toBe('2030-06-01');
    expect(w.to).toBe('2030-06-07');
    expect(w.days).toBe(7);
    expect(w.clipped).toBe(false);
  });

  it('opens the day after the last export, not on it', () => {
    // The 31st was in the last issue. Reopening on it would reprint a day.
    expect(recapWindow(IDS.league)!.from).not.toBe('2030-05-31');
  });

  /*
   * The case that must not change. Almost every save is simmed a day at a
   * time, and those readers should not suddenly find yesterday's games
   * reprinted in today's paper.
   */
  it('is a single day where a single day was simmed', () => {
    snapshots('2030-6-6', '2030-6-7');
    const w = recapWindow(IDS.league)!;
    expect(w.from).toBe('2030-06-07');
    expect(w.to).toBe('2030-06-07');
    expect(w.days).toBe(1);
  });

  it('is a single day on a first import, which has no previous issue', () => {
    snapshots('2030-6-7');
    expect(recapWindow(IDS.league)!.days).toBe(1);
  });

  it('is a single day when the app has never taken a snapshot at all', () => {
    snapshots();
    expect(recapWindow(IDS.league)!.days).toBe(1);
  });

  /*
   * An export taken before the day's games are simmed. The window would open
   * after the last day played, which is a negative stretch — it clamps to the
   * one day there is.
   */
  it('clamps shut rather than opening past the last day played', () => {
    snapshots('2030-6-7', '2030-6-30');
    const w = recapWindow(IDS.league)!;
    expect(w.from).toBe('2030-06-07');
    expect(w.to).toBe('2030-06-07');
    expect(w.days).toBe(1);
  });

  it('caps a long absence rather than writing up two months', () => {
    snapshots('2030-4-1', '2030-6-7');
    const w = recapWindow(IDS.league)!;
    expect(w.days).toBe(10);
    expect(w.from).toBe('2030-05-29');
    expect(w.clipped, 'a clipped window has to say so, or the paper writes as if it were all').toBe(true);
  });

  it('reads the unpadded dates OOTP actually writes', () => {
    // Every date above is unpadded, because that is the only kind in an export.
    // The window still opens in June rather than somewhere in May.
    snapshots('2030-5-31', '2030-6-7');
    expect(recapWindow(IDS.league)!.from).toBe('2030-06-01');
  });

  /*
   * A snapshot date the app cannot read at all. It should cost the reader the
   * week, not the page: a date that reaches the arithmetic unchecked produces
   * an invalid Date, and asking that for an ISO string throws — which would
   * take down the paper, the recap and the dashboard's briefing with it.
   */
  it('falls back to one day rather than throwing on a date it cannot read', () => {
    snapshots('not-a-date', '2030-6-7');
    expect(() => recapWindow(IDS.league)).not.toThrow();
    expect(recapWindow(IDS.league)!.days).toBe(1);
  });
});

describe('what the week hands the writer', () => {
  it('carries every game of the week, not just the last day', () => {
    const w = assembleWindow(IDS.mlbTeam);
    expect(w.games).toHaveLength(WEEK.length);
  });

  it('leaves out games from before the reader last looked', () => {
    const dates = assembleWindow(IDS.mlbTeam).games.map((g) => g.date);
    expect(dates).not.toContain('2030-05-20');
  });

  it('dates every game, so a week can be written in order', () => {
    const games = assembleWindow(IDS.mlbTeam).games;
    expect(games.map((g) => g.date)).toEqual([
      '2030-06-01', '2030-06-02', '2030-06-03', '2030-06-04',
      '2030-06-05', '2030-06-06', '2030-06-07',
    ]);
  });

  it('tells the writer how long a stretch it is', () => {
    const w = assembleWindow(IDS.mlbTeam);
    expect(w.days).toBe(7);
    expect(w.from).toBe('2030-06-01');
    expect(w.to).toBe('2030-06-07');
    // The last day stays where every caller already looks for it
    expect(w.date).toBe(w.to);
  });

  it('still hands over one day where one day was played', () => {
    snapshots('2030-6-6', '2030-6-7');
    const w = assembleWindow(IDS.mlbTeam);
    expect(w.days).toBe(1);
    expect(w.games).toHaveLength(1);
    expect(w.games[0].date).toBe('2030-06-07');
  });
});

describe('the season this is all in', () => {
  it('uses the fixture season, so the leaders are this year\'s', () => {
    expect(assembleWindow(IDS.mlbTeam).seasonYear).toBe(SEASON);
  });
});
