import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who belongs on the draft board.
 *
 * A reader running a fictional universe with its own high-school and college
 * leagues found the board listing 123 players, not one of whom was in the pool
 * his game had published that day, while none of his 296 appeared on it. The
 * eligibility flag was doing all the work and it is not enough for either
 * half of the question.
 *
 * It stays set after a man is taken: in the major-league save this was checked
 * against, 185 players carried both draft_eligible and picked_in_draft, every
 * one stamped with the current year as his draft year, and the board was
 * offering all 185 as though they were still there.
 *
 * And a universe with feeder leagues runs more than one draft. The export says
 * which one a man belongs to, and nothing was reading it.
 */

const AVAILABLE = 8800;
const ALREADY_TAKEN = 8801;
const OTHER_LEAGUES_DRAFT = 8802;
const OTHER_LEAGUE_ID = 999;

beforeAll(() => {
  // OOTP's own switch for a published class, which the board waits on
  db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);

  const add = (id: number, last: string, picked: number, draftLeague: number) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college, picked_in_draft, draft_league_id)
       VALUES (?, 'Class', ?, 19, 6, 0, 1, 1, 0, 0, 0, 0, 0, 1, 0, ?, ?)`
    ).run(id, last, picked, draftLeague);
    // A scouted ceiling, or there is nothing to rank him on
    db.prepare(
      `INSERT INTO players_batting VALUES (?, 45, 45, 45, 45, 45, 45, 60, 60, 60, 60, 60)`
    ).run(id);
  };

  add(AVAILABLE, 'Available', 0, IDS.league);
  add(ALREADY_TAKEN, 'Taken', 1, IDS.league);
  add(OTHER_LEAGUES_DRAFT, 'Elsewhere', 0, OTHER_LEAGUE_ID);
});

interface Board {
  total: number;
  excluded?: { alreadyPicked: number; otherDraft: number; unrated: number };
  prospects: Array<{ player_id: number; name: string }>;
}

const board = async (): Promise<Board> => await request(`/api/draft/${IDS.mlbTeam}`) as Board;

describe('the draft board', () => {
  it('offers a man who is eligible and still there', async () => {
    const names = (await board()).prospects.map((p) => p.name);
    expect(names).toContain('Class Available');
  });

  it('does not offer a man who has already been drafted', async () => {
    const names = (await board()).prospects.map((p) => p.name);
    expect(names, 'a player already taken was still on the board').not.toContain('Class Taken');
  });

  it("does not offer a man who belongs to another league's draft", async () => {
    const names = (await board()).prospects.map((p) => p.name);
    expect(names, "another league's class was mixed into this one").not.toContain('Class Elsewhere');
  });
});

describe('what the board says it left out', () => {
  it('counts the men already drafted', async () => {
    expect((await board()).excluded?.alreadyPicked).toBeGreaterThanOrEqual(1);
  });

  it('counts the men in another draft', async () => {
    expect((await board()).excluded?.otherDraft).toBeGreaterThanOrEqual(1);
  });

  it('is there so a wrong-looking board can be told from an empty one', async () => {
    // The whole point: the reader could not tell whether the app had missed his
    // class or ruled it out, and neither could anybody helping him
    const x = (await board()).excluded;
    expect(x).toBeDefined();
    expect(typeof x?.unrated).toBe('number');
  });
});
