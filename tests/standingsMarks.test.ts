import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { displayMagicNumber, raceMarks, type RaceRow } from '../server/playoffs.js';
import { IDS } from './fixture.js';

/**
 * The x beside a club that has reached the postseason, and the magic number
 * beside one still chasing it.
 *
 * "Negative magic numbers or zero in League Standings page at the end of
 * regular season remain. OOTP puts an x for every team that reached
 * postseason, worth replicating."
 *
 * The first was my own miss: the dashboard card stopped printing a settled
 * race's magic number and the standings page carried on doing it, because the
 * rule lived in one of the two files that needed it. It is shared now.
 *
 * The marks are conservative in one direction on purpose. Printing nothing
 * where a race is genuinely undecided costs a reader nothing; printing an e
 * beside a club that is still alive is a lie about their season.
 */

const club = (
  team_id: number, division_id: number, pos: number, w: number, l: number, gamesLeft: number
): RaceRow => ({ team_id, division_id, pos, w, l, gamesLeft });

describe('what OOTP prints beside a club', () => {
  it('takes a real magic number', () => {
    expect(displayMagicNumber(12)).toBe(12);
    expect(displayMagicNumber(1)).toBe(1);
  });

  /*
   * The reported case. OOTP counts the number down as a race tightens and past
   * zero once it is settled, so a club that had won its division was showing
   * "-1" — and a zero is no more meaningful.
   */
  it('prints neither a negative nor a zero', () => {
    expect(displayMagicNumber(-1)).toBeNull();
    expect(displayMagicNumber(0)).toBeNull();
  });

  it('prints nothing for the not-applicable thousand, or for a missing value', () => {
    expect(displayMagicNumber(1000)).toBeNull();
    expect(displayMagicNumber(null)).toBeNull();
    expect(displayMagicNumber(undefined)).toBeNull();
  });
});

/**
 * Two divisions of four, one wild card: five places, and every game played.
 */
describe('a season that has been played out', () => {
  const finished: RaceRow[] = [
    club(1, 1, 1, 100, 62, 0), club(2, 1, 2, 92, 70, 0),
    club(3, 1, 3, 80, 82, 0), club(4, 1, 4, 70, 92, 0),
    club(5, 2, 1, 95, 67, 0), club(6, 2, 2, 88, 74, 0),
    club(7, 2, 3, 79, 83, 0), club(8, 2, 4, 65, 97, 0),
  ];

  it('marks both division winners', () => {
    const marks = raceMarks(finished, 1);
    expect(marks.get(1)).toBe('x');
    expect(marks.get(5)).toBe('x');
  });

  it('marks the wild card, and only as many as there are', () => {
    const marks = raceMarks(finished, 1);
    // 92-70 is the best record among clubs that did not win a division
    expect(marks.get(2)).toBe('x');
    expect(marks.get(6)).toBeNull();
    expect([...marks.values()].filter((m) => m === 'x')).toHaveLength(3);
  });

  it('leaves the clubs that missed it unmarked rather than branding them', () => {
    const marks = raceMarks(finished, 1);
    for (const id of [3, 4, 7, 8]) expect(marks.get(id)).toBeNull();
  });

  it('marks every club that got in when the league takes more of them', () => {
    const marks = raceMarks(finished, 3);
    expect([...marks.values()].filter((m) => m === 'x')).toHaveLength(5);
  });
});

describe('a race still being run', () => {
  /** Two divisions of four, twenty games left, one wild card. */
  const mid = (overrides: Partial<Record<number, Partial<RaceRow>>> = {}): RaceRow[] =>
    [
      club(1, 1, 1, 90, 52, 20), club(2, 1, 2, 70, 72, 20),
      club(3, 1, 3, 68, 74, 20), club(4, 1, 4, 60, 82, 20),
      club(5, 2, 1, 85, 57, 20), club(6, 2, 2, 84, 58, 20),
      club(7, 2, 3, 66, 76, 20), club(8, 2, 4, 55, 87, 20),
    ].map((c) => ({ ...c, ...(overrides[c.team_id] ?? {}) }));

  it('marks a club nobody in its division can still catch', () => {
    // 90 wins; the best chaser can finish with 70 + 20 = 90, which is a tie,
    // and a tie is not clinched
    expect(raceMarks(mid(), 1).get(1)).toBeNull();
    expect(raceMarks(mid({ 2: { w: 69 } }), 1).get(1)).toBe('x');
  });

  it('says nothing about a division still being contested', () => {
    const marks = raceMarks(mid(), 1);
    expect(marks.get(5)).toBeNull();
    expect(marks.get(6)).toBeNull();
  });

  /*
   * Out on both counts: cannot win the division, and five clubs have already
   * won more games than it can finish with — which is every place there is.
   */
  it('marks a club that can no longer reach any place', () => {
    expect(raceMarks(mid(), 1).get(8)).toBe('e');
  });

  it('leaves a club alive for a wild card unmarked', () => {
    // Cannot win its division, but 68 + 20 = 88 still beats most of the field
    expect(raceMarks(mid(), 1).get(3)).toBeNull();
  });

  /*
   * The trap in counting by wins alone: a club leading a weak division can
   * have more clubs above it than there are places and still be going to the
   * postseason. It must never be marked out.
   */
  it('does not call a division leader out because the other division is stronger', () => {
    const lopsided: RaceRow[] = [
      club(1, 1, 1, 60, 82, 20), club(2, 1, 2, 40, 102, 20),
      club(3, 1, 3, 38, 104, 20), club(4, 1, 4, 35, 107, 20),
      club(5, 2, 1, 100, 42, 20), club(6, 2, 2, 98, 44, 20),
      club(7, 2, 3, 95, 47, 20), club(8, 2, 4, 92, 50, 20),
    ];
    expect(raceMarks(lopsided, 1).get(1)).not.toBe('e');
  });

  /*
   * And the same trap the other way. A club is only marked in on a wild card
   * when it is clear of the wild-card field — counting against every place
   * would hand it one that a weak division can still take away.
   */
  it('does not hand a wild card to a club the field can still catch', () => {
    const marks = raceMarks(mid(), 1);
    expect(marks.get(2)).toBeNull();
  });

  it('says nothing at all in a league with no places to give', () => {
    const marks = raceMarks(mid(), 0);
    // One division apiece is still a place; a league with neither is the guard
    expect(raceMarks([club(1, 1, 1, 90, 52, 20)], 0).get(1)).toBeNull();
    expect(marks.get(8)).toBe('e');
  });
});


/**
 * Through the endpoint, because that is where this one actually went wrong.
 * The rule was written once, in the file the dashboard reads, and the
 * standings page has its own query — so the page carried on printing what the
 * card had stopped printing.
 */
describe('the standings page itself', () => {
  beforeAll(() => {
    // The fixture creates the standings tables and leaves them empty
    db.prepare(`INSERT INTO divisions VALUES (?, 0, 1, 'East Division', 0)`).run(IDS.league);
    db.prepare(`UPDATE teams SET division_id = 1 WHERE team_id IN (?, ?)`)
      .run(IDS.mlbTeam, IDS.otherMlbTeam);
    const record = db.prepare(
      `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
       VALUES (?, 41, ?, ?, 0, ?, ?, ?, 0, 1000)`
    );
    record.run(IDS.mlbTeam, 27, 14, 1, 0.659, 0);
    record.run(IDS.otherMlbTeam, 20, 21, 2, 0.488, 7);
  });

  it('does not send a settled race\'s magic number to the page', async () => {
    db.prepare(`UPDATE team_record SET magic_number = -1 WHERE team_id = ?`).run(IDS.mlbTeam);
    const data = await request(`/api/standings/${IDS.mlbTeam}`);
    const teams = data.subLeagues.flatMap((s: { divisions: Array<{ teams: unknown[] }> }) =>
      s.divisions.flatMap((d) => d.teams)
    ) as Array<{ team_id: number; magicNumber: number | null }>;
    const us = teams.find((t) => t.team_id === IDS.mlbTeam);
    expect(us).toBeDefined();
    expect(us!.magicNumber).toBeNull();
    db.prepare(`UPDATE team_record SET magic_number = 1000 WHERE team_id = ?`).run(IDS.mlbTeam);
  });

  it('carries a mark for every club, even when it is nothing yet', async () => {
    const data = await request(`/api/standings/${IDS.mlbTeam}`);
    const teams = data.subLeagues.flatMap((s: { divisions: Array<{ teams: unknown[] }> }) =>
      s.divisions.flatMap((d) => d.teams)
    ) as Array<{ mark: unknown }>;
    expect(teams.length).toBeGreaterThan(0);
    for (const t of teams) expect(['x', 'e', null]).toContain(t.mark);
  });
});
