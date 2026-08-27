import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Who actually holds a place on the big club.
 *
 * A reader was told to promote four Triple-A pitchers, every one of them
 * measured against the same man: "Chad Russell, a first-rounder from the just
 * completed amateur draft, accepted signing bonus plus a 3-year contract
 * yesterday (game time) and is currently on DFA list, because I forgot to
 * assign him to my lowest minor level team... comparing them to a DFAed guy,
 * who hasn't thrown a single professional pitch yet."
 *
 * The corresponding move asks who the weakest man at a position is, and takes
 * beating him as the bar. That is a fair bar against somebody holding a
 * roster spot and a nonsense one against somebody already on his way out of
 * the organisation — and being the weakest is exactly what a man like that
 * will be, so he was not an unlucky pick, he was the inevitable one.
 *
 * "On a roster somewhere" was the old test. It did not ask which club's roster,
 * and it did not ask whether he was staying on it.
 */

const DFA_ROOKIE = 9400;
const REAL_ARM = 9401;
const FARM_ARM = 9402;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, ?, 1, 11, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const grade = db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, 500, 600, 0, 0, 0, 500, ?, ?, ?, ?)`
  );
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year,
        designated_for_assignment, is_on_waivers)
     VALUES (?, ?, 0, 0, 0, 0.0, 0, 0, ?, ?)`
  );

  /*
   * The draftee: on the parent club because nobody assigned him, on the active
   * list, and designated for assignment. Graded well below everybody.
   */
  player.run(DFA_ROOKIE, 'Chad', 'Russell', 22, 41, IDS.mlbTeam, IDS.mlbTeam);
  grade.run(DFA_ROOKIE, 36, 55, 36, 55);
  status.run(DFA_ROOKIE, 1, 1, 0);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, DFA_ROOKIE);

  // A genuine major-league arm, and the man a promotion really has to beat
  player.run(REAL_ARM, 'Real', 'Arm', 29, 42, IDS.mlbTeam, IDS.mlbTeam);
  grade.run(REAL_ARM, 48, 50, 48, 50);
  status.run(REAL_ARM, 1, 0, 0);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, REAL_ARM);

  /*
   * The Triple-A pitcher. Graded between the two: clear of the man on his way
   * out, short of the man actually pitching.
   */
  player.run(FARM_ARM, 'Hayami', 'Kawamura', 29, 43, IDS.aaaTeam, IDS.mlbTeam);
  grade.run(FARM_ARM, 41, 42, 41, 42);
  status.run(FARM_ARM, 0, 0, 0);
  db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, FARM_ARM);
  db.prepare(
    `INSERT INTO players_career_pitching_stats
       (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k,
        hra, hp, bf, g, gs, w, l, s, hld, war)
     VALUES (?, ?, ?, ?, 2, 1, 145, 13, 15, 30, 10, 60, 1, 2, 190, 20, 0, 5, 1, 3, 2, 1.5)`
  ).run(FARM_ARM, SEASON, IDS.aaaTeam, IDS.league);
});

interface Prospect {
  player_id: number; name: string; signal: string | null;
  move: { replaces: { name: string } | null; blocked: boolean; note: string } | null;
}

const farm = async (): Promise<Prospect[]> => {
  const d = await request(`/api/prospects/${IDS.mlbTeam}`);
  return [...(d.batters ?? []), ...(d.pitchers ?? [])] as Prospect[];
};

describe('a man designated for assignment', () => {
  it('is not treated as somebody a call-up would displace', async () => {
    // The whole of the report: four promotions, all measured against him
    const him = (await farm()).find((p) => p.player_id === FARM_ARM);
    expect(him, 'the Triple-A arm never reached the farm page').toBeDefined();
    expect(him!.move?.replaces?.name, 'a DFA\'d man was named as the incumbent')
      .not.toBe('Chad Russell');
    expect(him!.move?.note ?? '').not.toMatch(/Chad Russell/);
  });

  it('leaves the verdict resting on the men actually on the staff', async () => {
    /*
     * Graded 41 against a staff whose weakest genuine arm is 48, he is short —
     * which is the answer the reader expected and could not get while the bar
     * was a man on his way out of the organisation.
     */
    const him = (await farm()).find((p) => p.player_id === FARM_ARM);
    expect(him!.move?.blocked, 'still clear of the men actually on the staff').toBe(true);
    expect(him!.move?.note, 'the note named nobody at all').toMatch(/graded above him|grades \d+/);
  });

  it('would have been clear of the DFA\'d man, which is the whole point', async () => {
    /*
     * He beats 36 and loses to 48. Under the old test the first of those was
     * the bar, and the page said promote; under this one the second is, and it
     * says blocked. The change of verdict is the fix.
     */
    const him = (await farm()).find((p) => p.player_id === FARM_ARM);
    expect(him!.move?.replaces, 'somebody was named as displaceable').toBeNull();
  });
});

describe('a man on waivers', () => {
  it('is not counted either', async () => {
    // Same reasoning: claimed tomorrow, he is not the club's problem or asset
    db.prepare(`UPDATE players_roster_status SET designated_for_assignment = 0, is_on_waivers = 1
                WHERE player_id = ?`).run(DFA_ROOKIE);
    try {
      const him = (await farm()).find((p) => p.player_id === FARM_ARM);
      expect(him!.move?.note ?? '').not.toMatch(/Chad Russell/);
    } finally {
      db.prepare(`UPDATE players_roster_status SET designated_for_assignment = 1, is_on_waivers = 0
                  WHERE player_id = ?`).run(DFA_ROOKIE);
    }
  });
});

describe('a man on the club but not on its active list', () => {
  it('is not counted as holding a place', async () => {
    /*
     * OOTP parks an unassigned signing on the parent club's team_id. The old
     * test asked only whether he was on a roster anywhere, which a man on his
     * farm club's list satisfies.
     */
    db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND team_id = ?`)
      .run(DFA_ROOKIE, IDS.mlbTeam);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, DFA_ROOKIE);
    try {
      const him = (await farm()).find((p) => p.player_id === FARM_ARM);
      expect(him!.move?.note ?? '').not.toMatch(/Chad Russell/);
    } finally {
      db.prepare(`DELETE FROM team_roster WHERE player_id = ? AND team_id = ?`)
        .run(DFA_ROOKIE, IDS.aaaTeam);
      db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, DFA_ROOKIE);
    }
  });
});
