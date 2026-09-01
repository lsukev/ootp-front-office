import { describe, expect, it, beforeEach } from 'vitest';
import { db } from '../server/db.js';
import { deadlineRead } from '../server/posture.js';
import { IDS } from './fixture.js';

/**
 * Buy, hold or sell.
 *
 * The verdict comes from one number — the chance of reaching the postseason —
 * so the tests are about whether that number moves for the right reasons. The
 * one that matters most is time: five games out in May and five games out in
 * September are the same line in the standings and opposite answers, and a
 * tool that cannot tell them apart is worse than no tool.
 *
 * Talent is taken from run differential rather than won-lost record, so a club
 * outscoring its opponents while losing should read better than its record.
 */

const setSeason = (w: number, l: number, rs: number, ra: number, scheduled = 162) => {
  db.prepare(`DELETE FROM team_record WHERE team_id = ?`).run(IDS.mlbTeam);
  db.prepare(
    `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
     VALUES (?, ?, ?, ?, 0, 2, ?, 6, 0, 1000)`
  ).run(IDS.mlbTeam, w + l, w, l, w / (w + l));
  db.prepare(`DELETE FROM team_batting_stats WHERE team_id = ?`).run(IDS.mlbTeam);
  db.prepare(`DELETE FROM team_pitching_stats WHERE team_id = ?`).run(IDS.mlbTeam);
  db.prepare(`INSERT INTO team_batting_stats (team_id, year, split_id, level_id, g, r) VALUES (?,2026,0,1,?,?)`)
    .run(IDS.mlbTeam, w + l, rs);
  db.prepare(`INSERT INTO team_pitching_stats (team_id, year, split_id, level_id, g, r) VALUES (?,2026,0,1,?,?)`)
    .run(IDS.mlbTeam, w + l, ra);
  db.prepare(`DELETE FROM games`).run();
  /*
   * A real schedule marks the games already played, and the card now counts
   * what is left rather than subtracting the record from the schedule length.
   * Written the old way — every game unplayed — this helper described a state
   * OOTP never exports, and a club 154 games into its season had a full 162
   * still to play.
   */
  const g = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, game_type) VALUES (?,?,?,?,?,0)`
  );
  for (let i = 0; i < scheduled; i++) {
    g.run(9000 + i, IDS.mlbTeam, IDS.otherMlbTeam, '2026-6-1', i < w + l ? 1 : 0);
  }
  // The exhibition slate, which is exactly what used to be counted as games
  // still to play — 28 of them, on a club that had finished its season
  const ex = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, game_type) VALUES (?,?,?,?,1,5)`
  );
  for (let i = 0; i < 28; i++) ex.run(9500 + i, IDS.mlbTeam, IDS.otherMlbTeam, '2026-3-1');
};

describe('reading the season', () => {
  it('says the same record differently in May and in September', () => {
    // Six games back either way; the difference is only how much time is left
    setSeason(40, 45, 400, 410);          // 85 played, 77 to go
    const may = deadlineRead(IDS.mlbTeam)!;
    setSeason(72, 82, 720, 740);          // 154 played, 8 to go
    const september = deadlineRead(IDS.mlbTeam)!;
    expect(may.odds).toBeGreaterThan(september.odds);
    expect(september.gamesLeft).toBeLessThan(may.gamesLeft);
  });

  it('reads the runs, not the record', () => {
    // Identical 45-46 records; one is outscoring its opponents comfortably
    setSeason(45, 46, 500, 400);
    const good = deadlineRead(IDS.mlbTeam)!;
    setSeason(45, 46, 400, 500);
    const bad = deadlineRead(IDS.mlbTeam)!;
    expect(good.odds).toBeGreaterThan(bad.odds);
    expect(good.runDiff).toBe(100);
    expect(bad.runDiff).toBe(-100);
  });

  it('says so when the record flatters the runs, and when it hides them', () => {
    setSeason(60, 31, 400, 420);   // winning far more than the runs support
    expect(deadlineRead(IDS.mlbTeam)!.reasons.join(' ')).toMatch(/more than the runs support/);
    setSeason(31, 60, 420, 400);   // losing far more
    expect(deadlineRead(IDS.mlbTeam)!.reasons.join(' ')).toMatch(/better than the record looks/);
  });

  it('lands on a verdict that matches the odds it printed', () => {
    for (const [w, l, rs, ra] of [[70, 20, 600, 400], [45, 45, 450, 450], [25, 65, 350, 550]]) {
      const r = deadlineRead(IDS.mlbTeam) ?? (setSeason(w, l, rs, ra), deadlineRead(IDS.mlbTeam)!);
      setSeason(w, l, rs, ra);
      const read = deadlineRead(IDS.mlbTeam)!;
      if (read.posture === 'buy') expect(read.odds).toBeGreaterThanOrEqual(0.75);
      if (read.posture === 'sell') expect(read.odds).toBeLessThan(0.10);
      expect(read.headline).toContain(`${Math.round(read.odds * 100)}%`);
    }
  });

  it('is willing to say hold rather than invent a decision', () => {
    setSeason(45, 46, 455, 450);
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(['hold', 'lean-buy', 'lean-sell']).toContain(read.posture);
  });

  it('gives nothing at all before a game has been played', () => {
    setSeason(0, 0, 0, 0);
    expect(deadlineRead(IDS.mlbTeam)).toBeNull();
  });
});
