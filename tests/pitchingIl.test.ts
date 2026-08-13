import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Relievers on the injured list, on the page that asks who can throw tonight.
 *
 * A user sent a screenshot of his bullpen with two men on the injured list in
 * it, one tagged IL-60 with six weeks to run — and beside that tag, in green,
 * "Rested 18d". He was right twice over. The availability column was reading
 * days since his last appearance and finding a man who had not pitched in
 * weeks beautifully fresh, which is the opposite of the answer; and the
 * heading's count of who is limited or unavailable was leaving him out of it
 * on the same reasoning.
 *
 * Day-to-day men stay put and keep their workload line: OOTP will let a
 * manager use them, so whether to is his call and not the app's.
 */

const HEALTHY = 8200;
const ON_IL = 8201;
const DAY_TO_DAY = 8202;

beforeAll(() => {
  // Today, and a game eighteen days earlier — the last time the man now on the
  // injured list threw a pitch. That is the report reproduced: eighteen days of
  // rest, because he has been hurt for eighteen days.
  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id)
     VALUES (?, ?, ?, ?, 1, ?)`
  );
  game.run(1, IDS.mlbTeam, IDS.otherMlbTeam, '2026-7-16', IDS.league);
  game.run(2, IDS.mlbTeam, IDS.otherMlbTeam, '2026-8-3', IDS.league);

  const arm = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, 28, 1, 12, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const standing = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, ?, ?, ?, 0, 3.0, ?, 40)`
  );

  arm.run(HEALTHY, 'Fresh', 'Arm', 71, IDS.mlbTeam, IDS.mlbTeam);
  standing.run(HEALTHY, 1, 0, 0, 3 * 172);

  arm.run(ON_IL, 'Shelved', 'Arm', 72, IDS.mlbTeam, IDS.mlbTeam);
  standing.run(ON_IL, 0, 1, 1, 3 * 172);
  db.prepare(
    `UPDATE players SET injury_is_injured = 1, injury_left = 46 WHERE player_id = ?`
  ).run(ON_IL);
  db.prepare(
    `INSERT INTO players_game_pitching_stats (player_id, game_id, pi, outs, gs)
     VALUES (?, 1, 21, 3, 0)`
  ).run(ON_IL);

  arm.run(DAY_TO_DAY, 'Sore', 'Arm', 73, IDS.mlbTeam, IDS.mlbTeam);
  standing.run(DAY_TO_DAY, 1, 0, 0, 3 * 172);
  db.prepare(
    `UPDATE players SET injury_dtd_injury = 1, injury_left = 2 WHERE player_id = ?`
  ).run(DAY_TO_DAY);
});

interface Reliever {
  player_id: number;
  status: string;
  tone: string;
  injury: { status: string; playable: boolean } | null;
}

const bullpen = async (): Promise<Reliever[]> =>
  (await request(`/api/pitching/${IDS.mlbTeam}`)).bullpen as Reliever[];

const find = (pen: Reliever[], id: number): Reliever => {
  const man = pen.find((p) => p.player_id === id);
  expect(man, `reliever ${id} missing from the bullpen`).toBeDefined();
  return man as Reliever;
};

describe('a reliever on the injured list', () => {
  it('is not described as rested', async () => {
    const man = find(await bullpen(), ON_IL);
    expect(man.status).not.toMatch(/rested|available/i);
  });

  it('says he is out, and for roughly how long', async () => {
    const man = find(await bullpen(), ON_IL);
    expect(man.status).toMatch(/out/i);
    expect(man.status).toContain('46');
  });

  it('is coloured as unavailable rather than as fine', async () => {
    expect(find(await bullpen(), ON_IL).tone).toBe('bad');
  });

  it('carries the flag the page filters on', async () => {
    // The show/hide control keys off playable, not off the status text
    expect(find(await bullpen(), ON_IL).injury?.playable).toBe(false);
  });
});

describe('the arms who can pitch', () => {
  it('leaves a healthy reliever reading as available', async () => {
    const man = find(await bullpen(), HEALTHY);
    expect(man.tone).toBe('ok');
    expect(man.injury).toBeNull();
  });

  it('keeps a day-to-day man in the pen and on his workload line', async () => {
    const man = find(await bullpen(), DAY_TO_DAY);
    expect(man.injury?.status).toBe('Day-to-day');
    expect(man.injury?.playable).toBe(true);
    expect(man.status).not.toMatch(/out/i);
  });
});
