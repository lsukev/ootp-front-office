import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A season split between two clubs.
 *
 * Asked whether the assistants were missing what a player did for his previous
 * major-league club, the answer was no — the season line has always summed
 * every club he played for, which is the right total. What was missing was the
 * split. A bat picked up in July has a record before the trade and a record
 * since, "how is he hitting" usually means the second, and nothing was on
 * offer to answer it, so nobody could.
 *
 * The total must not change. Reporting only the new club would be a worse bug
 * than the one being fixed, so that is what these check first.
 */

const TRADED = 8300;
const YEAR = 2030;

beforeAll(() => {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Mid', 'Season', 29, 5, 0, 1, 1, 44, ?, ?, 0, 0, 0, 0)`
  ).run(TRADED, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, TRADED);

  const line = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1.0)`
  );
  // 200 plate appearances with the other club, 100 since arriving
  line.run(TRADED, YEAR, IDS.otherMlbTeam, IDS.league, 200, 180, 54, 9);
  line.run(TRADED, YEAR, IDS.mlbTeam, IDS.league, 100, 90, 30, 6);
});

const find = async () => {
  const r = await request(`/api/players?q=Season&group=batting&level=1&limit=300`);
  return r.players.find((p: { name: string }) => p.name === 'Mid Season');
};

describe('a player who changed clubs mid-season', () => {
  it('still counts his whole season, both clubs together', async () => {
    const him = await find();
    expect(him, 'the traded player is missing from search').toBeDefined();
    expect(him.stats.pa).toBe(300);
    expect(him.stats.h).toBe(84);
  });

  it('breaks the season out by club', async () => {
    const him = await find();
    expect(him.stints).toBeDefined();
    expect(him.stints).toHaveLength(2);
    const mine = him.stints.find((s: { team: string }) => s.team === 'TST');
    expect(mine.pa).toBe(100);
    expect(mine.hr).toBe(6);
  });

  it('says which level each stint was at', async () => {
    const him = await find();
    for (const s of him.stints) expect(s.level).toBe('MLB');
  });

  it('offers no breakdown for somebody who never moved', async () => {
    const r = await request(`/api/players?q=Ular&group=batting&level=1&limit=300`);
    const stayed = r.players.find((p: { name: string }) => p.name === 'Reg Ular');
    if (!stayed) return;
    // An empty list on every player would be noise in every answer
    expect(stayed.stints).toBeUndefined();
  });
});
