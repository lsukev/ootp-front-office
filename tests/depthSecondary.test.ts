import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { positionsFrom } from '../server/org.js';
import { IDS } from './fixture.js';

/**
 * Who can cover a position, which is not only who is listed at it.
 *
 * "The depth chart does not include players who play multiple positions. I
 * have only one player with a primary position of RF, but two others list it
 * as a secondary position. The app always says I only have one."
 *
 * players.position is the primary and nothing else. OOTP rates a man at every
 * position separately and leaves a zero where he does not play there, which is
 * its own way of saying so. In my own save fourteen men in one organisation
 * are primary right fielders and another forty-four are rated for it, so the
 * column was showing under a quarter of the cover a club actually has.
 */

const RIGHT_FIELD = 9;
const CENTRE_FIELD = 8;
const UTILITY = 8701;

beforeAll(() => {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Gets', 'Around', 27, ?, 0, 1, 1, 44, ?, ?, 0, 0, 0, 0)`
  ).run(UTILITY, CENTRE_FIELD, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, UTILITY);
  db.prepare(
    `INSERT INTO players_batting VALUES (?, 50, 50, 50, 50, 50, 60, 60, 60, 60, 60, 60)`
  ).run(UTILITY);
  // Rated in centre, where he is listed, and in right, where he is not
  const cols = Array.from({ length: 9 }, (_, i) => `fielding_rating_pos${i + 1}`);
  const values = cols.map((_, i) => (i + 1 === CENTRE_FIELD || i + 1 === RIGHT_FIELD ? 60 : 0));
  db.prepare(
    `INSERT INTO players_fielding (player_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`
  ).run(UTILITY, ...values);
});

const players = async (): Promise<Array<{ player_id: number; position: number; positions: number[] }>> =>
  (await request(`/api/depth-chart/${IDS.mlbTeam}`)).players;

describe('the positions a man covers', () => {
  it('reports the one on his card first', async () => {
    const him = (await players()).find((p) => p.player_id === UTILITY)!;
    expect(him.positions[0]).toBe(CENTRE_FIELD);
  });

  it('reports the one he is rated at but not listed at', async () => {
    const him = (await players()).find((p) => p.player_id === UTILITY)!;
    expect(him.positions, 'a secondary position was dropped').toContain(RIGHT_FIELD);
  });

  it('does not invent a position he is rated zero at', async () => {
    const him = (await players()).find((p) => p.player_id === UTILITY)!;
    expect(him.positions).not.toContain(2);
    expect(him.positions).not.toContain(6);
  });
});

/**
 * The primary always leads, so a fill-in can never be read as the man whose
 * position it is.
 */
describe('reading the packed list', () => {
  it('puts the primary first whatever order the ratings came in', () => {
    expect(positionsFrom('4,6,9,', 9)).toEqual([9, 4, 6]);
  });

  it('never repeats the primary', () => {
    expect(positionsFrom('8,9,', 8)).toEqual([8, 9]);
  });

  it('survives a save with no fielding table at all', () => {
    expect(positionsFrom('', 5)).toEqual([5]);
    expect(positionsFrom(null, 5)).toEqual([5]);
  });
});
