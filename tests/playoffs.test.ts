import { describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { playoffPicture } from '../server/playoffs.js';
import { IDS } from './fixture.js';

/**
 * The wild-card race, which the export does not contain.
 *
 * team_record carries games back in the division and OOTP's magic number and
 * nothing else, so the dashboard could only ever say how far off first place
 * the club was — the wrong question for the eleven clubs in fifteen who are
 * not going to win their division.
 *
 * Two things here are worth pinning. A club holding the last place must read
 * as clear of the first club outside it rather than nought games back of
 * itself, which is what measuring everyone against the same team produces.
 * And the number of places is read from the save: it runs from none to eight
 * across the leagues of a single export, so a hard-coded three would be wrong
 * in most of them.
 */

const LEAGUE = 900;
const CONFERENCE = 0;

/** A conference of six, two divisions of three, and one wild card on offer. */
function buildRace(wildCards: number): number[] {
  db.prepare(`DELETE FROM team_record`).run();
  db.prepare(`DELETE FROM teams WHERE league_id = ?`).run(LEAGUE);
  db.prepare(`DELETE FROM league_playoffs WHERE league_id = ?`).run(LEAGUE);
  db.prepare(`INSERT INTO league_playoffs (league_id, num_wild_cards) VALUES (?, ?)`)
    .run(LEAGUE, wildCards);

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, 'C', ?, ?, 1, ?, ?, ?, 0, 0, 0)`
  );
  const record = db.prepare(
    `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, 1000)`
  );
  // division, wins, losses, position in division
  const clubs: Array<[number, number, number, number]> = [
    [0, 60, 40, 1], // leads division 0
    [0, 55, 45, 2], // best of the rest — takes the only wild card
    [0, 50, 50, 3],
    [1, 58, 42, 1], // leads division 1
    [1, 55, 46, 2], // same wins, one more loss — half a game outside
    [1, 40, 60, 3],
  ];
  const ids: number[] = [];
  clubs.forEach(([division, w, l, pos], i) => {
    const id = 9100 + i;
    ids.push(id);
    team.run(id, `T${i}`, `T${i}`, LEAGUE, CONFERENCE, division);
    record.run(id, w + l, w, l, pos, w / (w + l), pos === 1 ? 0 : 5);
  });
  return ids;
}

describe('a one-wild-card race', () => {
  const [leaderA, holder, alsoRan, leaderB, firstOut] = buildRace(1);

  it('has a club leading its division read as in by that route', () => {
    const p = playoffPicture(leaderA)!;
    expect(p.route).toBe('division');
    expect(p.wildcardGb).toBeNull();
  });

  it('does not put a division leader in the wild-card queue', () => {
    // 58-42 is the second-best record here and would top the queue on merit
    expect(playoffPicture(leaderB)!.route).toBe('division');
    expect(playoffPicture(leaderB)!.wildcardRank).toBeNull();
  });

  it('gives the place to the best club that is not leading one', () => {
    const p = playoffPicture(holder)!;
    expect(p.route).toBe('wildcard');
    expect(p.wildcardRank).toBe(1);
  });

  it('reads a club in a place as clear of the field, not level with itself', () => {
    // 55-45 against 55-46 is half a game, and it is a cushion rather than a deficit
    const p = playoffPicture(holder)!;
    expect(p.wildcardGb).toBe(-0.5);
    expect(p.summary).toMatch(/clear/);
    expect(p.summary).not.toMatch(/back/);
  });

  it('measures the club outside against the one holding the place', () => {
    const p = playoffPicture(firstOut)!;
    expect(p.route).toBe('out');
    expect(p.wildcardGb).toBe(0.5);
    expect(p.wildcardRank).toBe(2);
    expect(p.summary).toMatch(/back of the last wild card/);
  });

  it('ranks the rest of the queue behind them', () => {
    expect(playoffPicture(alsoRan)!.wildcardRank).toBe(3);
  });
});

describe('a league with no wild card at all', () => {
  it('says so rather than inventing a race', () => {
    const [leader, second] = buildRace(0);
    expect(playoffPicture(leader)!.route).toBe('division');
    const p = playoffPicture(second)!;
    expect(p.spots).toBe(0);
    expect(p.wildcardGb).toBeNull();
    expect(p.summary).toMatch(/no wild card/);
  });
});

describe('a league that hands out more places than it has contenders', () => {
  it('does not fall over when everybody is in', () => {
    const [, holder] = buildRace(8);
    const p = playoffPicture(holder)!;
    expect(p.route).toBe('wildcard');
    // Nobody is on the outside to be clear of, and that is not an error
    expect(p.wildcardGb).toBeNull();
    expect(p.summary).toMatch(/Holding the 1st wild card/);
  });
});
