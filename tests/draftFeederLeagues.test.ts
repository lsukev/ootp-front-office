import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A league whose amateurs play in high-school and college competitions of its
 * own never sets draft_eligible, and the board has to read the class instead.
 *
 * A reader with that setup opened his board to 123 players, not one of whom
 * was in the pool his game had published that day, while none of his 296
 * appeared. His export settled it: every one of his pool players carried
 * draft_eligible = 0, hsc_status 4, and his own league in draft_league_id —
 * and all 123 the flag did pick out belonged to a second league's draft.
 *
 * So OOTP works eligibility out from the school class at draft time in that
 * kind of league, and leaves the flag alone. The class rule reproduced his
 * published pool exactly, to the man: 298 in classes 4, 9 and 10, two of them
 * carrying a career-ending injury, and his screen read 296.
 *
 * The flag is still preferred wherever it says anything, so an ordinary league
 * is untouched — this is a fallback, not a replacement.
 */

const HS_SENIOR = 9100;
const COLLEGE_JUNIOR = 9101;
const COLLEGE_SENIOR = 9102;
const HS_FRESHMAN = 9103;
const CAREER_ENDED = 9104;
const OTHER_LEAGUES_CLASS = 9105;
const OTHER_LEAGUE_ID = 777;

beforeAll(() => {
  db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);

  const add = (id: number, last: string, hsc: number, opts: {
    league?: number; careerEnding?: number;
  } = {}) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college, picked_in_draft, draft_league_id,
                            hsc_status, injury_career_ending)
       VALUES (?, 'Class', ?, 19, 6, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`
    ).run(id, last, opts.league ?? IDS.league, hsc, opts.careerEnding ?? 0);
    db.prepare(
      `INSERT INTO players_batting VALUES (?, 45, 45, 45, 45, 45, 45, 60, 60, 60, 60, 60)`
    ).run(id);
  };

  add(HS_SENIOR, 'Hssenior', 4);
  add(COLLEGE_JUNIOR, 'Junior', 9);
  add(COLLEGE_SENIOR, 'Senior', 10);
  // Too young — three more years of school before anyone may take him
  add(HS_FRESHMAN, 'Freshman', 1);
  // In the right class, but OOTP keeps him out of the pool
  add(CAREER_ENDED, 'Finished', 4, { careerEnding: 1 });
  // Right class, wrong draft
  add(OTHER_LEAGUES_CLASS, 'Elsewhere', 4, { league: OTHER_LEAGUE_ID });
});

interface Board {
  total: number;
  poolRule?: string;
  prospects: Array<{ name: string }>;
}

const board = async (): Promise<Board> => await request(`/api/draft/${IDS.mlbTeam}`) as Board;

describe('a league that marks its class by school year', () => {
  it('is recognised as such', async () => {
    // Nothing in this fixture carries the flag, so the class is all there is
    expect((await board()).poolRule).toBe('class');
  });

  it('takes the high-school seniors', async () => {
    expect((await board()).prospects.map((p) => p.name)).toContain('Class Hssenior');
  });

  it('takes the college upperclassmen', async () => {
    const names = (await board()).prospects.map((p) => p.name);
    expect(names).toContain('Class Junior');
    expect(names).toContain('Class Senior');
  });

  it('leaves the underclassmen at school', async () => {
    expect((await board()).prospects.map((p) => p.name)).not.toContain('Class Freshman');
  });

  it('leaves out a man whose career has been ended by injury', async () => {
    // Two of this reader's 298 were in this position, and his game's own screen
    // said 296 — which is how the rule was confirmed rather than guessed
    expect((await board()).prospects.map((p) => p.name)).not.toContain('Class Finished');
  });

  it("leaves out a class belonging to another league's draft", async () => {
    expect((await board()).prospects.map((p) => p.name)).not.toContain('Class Elsewhere');
  });
});
