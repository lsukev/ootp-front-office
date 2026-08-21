import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * The batting order in a league where the pitcher hits.
 *
 * A reader on such a league pressed Plan and got "Cannot read properties of
 * undefined (reading 'out')" — not a lineup, not an explanation, a JavaScript
 * sentence. The run search added in 0.24.0 counted to nine flat, and the card
 * it is handed holds only EIGHT men in a no-DH league: the pitcher is appended
 * afterwards, because he bats ninth for where he stands in the field and not
 * for how the bats sorted. The ninth read came back undefined.
 *
 * Leaving him out of the model was not the fix. Eight men cycling means every
 * hitter comes up oftener than he really will, and the three outs an inning
 * that go through the pitcher never appear at all — the search would have been
 * optimising a game nobody is playing. He is the ninth line in the model now,
 * and held in the ninth slot while the eight ahead of him move.
 *
 * The fixture's league uses the DH, so `dh=off` is the same override a manager
 * has to compare the two cards — and the same code path a no-DH league takes
 * every time.
 */

/** Enough season on the club that the search is willing to run at all. */
const PA_EACH = 600;

beforeAll(() => {
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, 2, ?, 40, 0, 3, 4, 90, 5, 2, 70, 75, 2.0)`
  );
  const clear = db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ?`);

  /*
   * A season for everyone on the club, of visibly different quality, so the
   * search has something to find — a card that never moves would mean the
   * search stood down and the crash could not have recurred either way.
   */
  const roster = db
    .prepare(
      `SELECT p.player_id FROM players p
       WHERE p.team_id = ? AND p.position != 1 AND p.retired = 0
       ORDER BY p.player_id`
    )
    .all(IDS.mlbTeam) as Array<{ player_id: number }>;
  roster.forEach((r, i) => {
    clear.run(r.player_id);
    // Hits climb steeply down the list, so the order is not a coin toss
    bat.run(r.player_id, SEASON, IDS.mlbTeam, IDS.league, PA_EACH, PA_EACH - 60,
            120 + i * 10, 20 + i * 3, 4 + i * 3);
  });

  /*
   * The pitcher's own line. Without it there is nothing honest to model him
   * with, and the search stands down rather than invent one — so a test that
   * wants to see the search run has to give him a season.
   */
  clear.run(IDS.extended);
  bat.run(IDS.extended, SEASON, IDS.mlbTeam, IDS.league, 70, 65, 8, 1, 0);
});

interface Card {
  lineup: Array<{ slot: number; positionName: string; name: string; player_id: number }>;
  usesDH: boolean;
  runSearch: { gain: number; moved: boolean; evaluations: number } | null;
}

const card = (dh: string): Promise<Card> =>
  request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=saber&dh=${dh}`);

describe('a card with the pitcher batting', () => {
  it('comes back at all', async () => {
    // The exact request that returned "Cannot read properties of undefined"
    const d = await card('off');
    expect(d.usesDH).toBe(false);
    expect(d.lineup.length).toBe(9);
  });

  it('runs the search rather than quietly standing down', async () => {
    const d = await card('off');
    expect(d.runSearch, 'the search never ran, so the crash could not recur').not.toBeNull();
    expect(d.runSearch!.evaluations).toBeGreaterThan(1);
  });

  it('leaves the pitcher ninth', async () => {
    /*
     * The one thing the search must not do. He is in the model — his outs are
     * three of the twenty-seven — but nobody is moving the pitcher up to bat
     * second on the strength of a run estimate.
     */
    const d = await card('off');
    const last = d.lineup[d.lineup.length - 1];
    expect(last.positionName).toBe('P');
    expect(last.slot).toBe(9);
    expect(d.lineup.filter((l) => l.positionName === 'P').length).toBe(1);
  });

  it('bats nine different men', async () => {
    // A re-seating that runs off the end of the card drops somebody or doubles
    // him, which is how an earlier version of this search flattered itself
    const d = await card('off');
    expect(new Set(d.lineup.map((l) => l.player_id)).size).toBe(9);
  });
});

describe('a pitcher who has never batted', () => {
  it('leaves the card as the rule wrote it, and still answers', async () => {
    /*
     * A DH league's pitchers have no batting line at all, which is the usual
     * case for anybody flipping the override on to see the other card. An
     * invented line would be an invented input to a model whose only output is
     * a number of runs.
     */
    db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ?`).run(IDS.extended);
    try {
      const d = await card('off');
      expect(d.lineup.length).toBe(9);
      expect(d.runSearch, 'the search ran on a pitcher it knew nothing about').toBeNull();
    } finally {
      db.prepare(
        `INSERT INTO players_career_batting_stats
           (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
            bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
         VALUES (?, ?, ?, ?, 1, 1, 70, 65, 8, 1, 0, 2, 3, 0, 3, 4, 90, 5, 2, 70, 75, 2.0)`
      ).run(IDS.extended, SEASON, IDS.mlbTeam, IDS.league);
    }
  });
});

describe('the DH card, for comparison', () => {
  it('is nine bats with no pitcher in it', async () => {
    const d = await card('on');
    expect(d.usesDH).toBe(true);
    expect(d.lineup.length).toBe(9);
    expect(d.lineup.some((l) => l.positionName === 'P'), 'a pitcher batting in a DH league').toBe(false);
  });
});
