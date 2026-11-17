import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { computeBatting, leagueBaseline } from '../server/stats.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * The card is built for one hand of pitching. The numbers beside it were not.
 *
 * "On the Lineup page, Off Value correctly changes when switching between vs
 * RHP and vs LHP, but PA, OPS, OPS+ and wRC+ appear to remain full-season
 * stats. Would it make sense for those columns to follow the selected platoon
 * split as well? ... Keeping split PA visible would also provide useful
 * sample-size context. WAR could probably remain full-season."
 *
 * Right on every count. Off Value came from `offensive_value_vsl/_vsr` and
 * moved with the toggle; the production columns came from `split_id = 1` and
 * did not, so a reader checking a vs-LHP card against its own numbers was
 * reading a whole season of mostly right-handed pitching.
 *
 * OOTP's split ids were established from the export rather than assumed — 2 is
 * against left-handed pitching, 3 against right — by checking that the platoon
 * advantage falls where it must: across 537,000 plate appearances right-handed
 * batters hit .251/.319 in split 2 against .244/.307 in split 3, and
 * left-handed batters the other way round.
 */

/** A man who cannot hit right-handers and murders left-handers. */
const PLATOON = IDS.starter;

const line = db.prepare(
  `INSERT INTO players_career_batting_stats
     (player_id, year, team_id, league_id, level_id, split_id,
      pa, ab, h, d, t, hr, bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
   VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, ?, 0, 0, ?, ?, ?)`
);

beforeAll(() => {
  // The fixture already gives him a split-1 row; this file wants its own
  db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ? AND year = ?`)
    .run(PLATOON, SEASON);

  //         player    year    team          league      split  pa   ab   h   2b  hr  bb   k   r   rbi war
  // Whole season: the two halves below add back to exactly this
  line.run(PLATOON, SEASON, IDS.mlbTeam, IDS.league, 1, 500, 440, 110, 20, 15, 50, 90, 60, 55, 2.5);
  // vs LHP: 300 PA at .400, which is the card he should lead when facing one
  line.run(PLATOON, SEASON, IDS.mlbTeam, IDS.league, 2, 300, 265, 85, 15, 12, 30, 45, 45, 40, 1.9);
  // vs RHP: 200 PA at .125, which is a man who should be batting eighth
  line.run(PLATOON, SEASON, IDS.mlbTeam, IDS.league, 3, 200, 175, 25, 5, 3, 20, 45, 15, 15, 0.6);

  /*
   * The league in all three splits, and deliberately not the same league in
   * each: against left-handers it scores far less here. A batter's vs-LHP line
   * has to be measured against THAT environment — compared with the league as
   * a whole it would read low for no reason but the company it was keeping.
   */
  for (const [split, pa, h, hr] of [[1, 40000, 9500, 1100], [2, 13000, 3000, 300], [3, 27000, 6600, 800]]) {
    line.run(9500 + split, SEASON, IDS.otherMlbTeam, IDS.league, split,
      pa, Math.round(pa * 0.89), h, Math.round(h * 0.2), hr,
      Math.round(pa * 0.09), Math.round(pa * 0.22), Math.round(pa * 0.11), Math.round(pa * 0.1), 0);
  }
});

const card = async (vs: 'r' | 'l') =>
  (await request(`/api/lineup/${IDS.mlbTeam}?vs=${vs}&style=saber&dh=auto&sort=production`)) as {
    statsVs: string;
    lineup: Array<{
      player_id: number; slot: number;
      pa: number | null; ops: number | null; opsPlus: number | null;
      wrcPlus: number | null; war: number | null;
    }>;
  };

const him = async (vs: 'r' | 'l') => (await card(vs)).lineup.find((l) => l.player_id === PLATOON)!;

describe('the production columns and the hand on the mound', () => {
  it('counts only the plate appearances against that hand', async () => {
    expect((await him('l')).pa).toBe(300);
    expect((await him('r')).pa).toBe(200);
  });

  it('adds the two halves back to the season, which is the check that they are halves', async () => {
    expect((await him('l')).pa! + (await him('r')).pa!).toBe(500);
  });

  it('reads split 2 as left-handed pitching, not right', async () => {
    // The whole thing turns on this. Reversed, every card would be built for
    // the hand it is not facing, and nothing on the page would look wrong.
    const vsLeft = await him('l');
    const vsRight = await him('r');
    expect(vsLeft.ops!, 'the .400 half is the one marked vs L').toBeGreaterThan(vsRight.ops!);
  });

  it('moves OPS, OPS+ and wRC+ with it', async () => {
    const l = await him('l');
    const r = await him('r');
    expect(l.ops).not.toBe(r.ops);
    expect(l.opsPlus).not.toBe(r.opsPlus);
    expect(l.wrcPlus).not.toBe(r.wrcPlus);
    expect(l.opsPlus!).toBeGreaterThan(r.opsPlus!);
    expect(l.wrcPlus!).toBeGreaterThan(r.wrcPlus!);
  });

  /*
   * The one column he asked to leave alone, and he was right to. WAR counts a
   * whole year's value; a third of a year is not a smaller version of it.
   */
  it('leaves WAR whole-season whichever hand is selected', async () => {
    expect((await him('l')).war).toBe(2.5);
    expect((await him('r')).war).toBe(2.5);
  });

  it('says which hand the columns are, so WAR is not read as one of them', async () => {
    expect((await card('l')).statsVs).toBe('l');
    expect((await card('r')).statsVs).toBe('r');
  });
});

describe('the league a split is measured against', () => {
  const base = () => leagueBaseline(IDS.league, SEASON, 1);
  const vsL = () => leagueBaseline(IDS.league, SEASON, 1, 2);
  const vsR = () => leagueBaseline(IDS.league, SEASON, 1, 3);

  it('is a different league in each split', () => {
    expect(vsL().lgSLG).not.toBe(vsR().lgSLG);
    expect(vsL().lgWOBA).not.toBe(base().lgWOBA);
  });

  it('does not hand back one split\'s league for another', () => {
    // The cache is keyed by league, year, level — and now split. Without the
    // last of those the first call answers every later one, and every split
    // would be measured against whichever was asked for first.
    const first = base().lgWOBA;
    expect(vsL().lgWOBA).not.toBe(first);
    expect(base().lgWOBA, 'and the overall baseline is still itself afterwards').toBe(first);
  });

  it('is the one the card actually uses', async () => {
    /*
     * Computed both ways here rather than asserted as a number, because the
     * point is which league the rate was taken against. Measured against the
     * whole league — where left-handers are not the hard company they are in
     * this save — the same line reads differently, and that difference is the
     * whole of the bug this guards.
     */
    const row = db
      .prepare(
        `SELECT SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3,
                SUM(hr) AS hr, SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf,
                SUM(k) AS k, SUM(r) AS r, SUM(rbi) AS rbi, SUM(war) AS war
         FROM players_career_batting_stats
         WHERE player_id = ? AND year = ? AND split_id = 2`
      )
      .get(PLATOON, SEASON) as Record<string, number>;
    const againstSplit = computeBatting(row, vsL(), IDS.mlbTeam).wrcPlus;
    const againstWhole = computeBatting(row, base(), IDS.mlbTeam).wrcPlus;
    expect(againstSplit, 'the fixture must make the two leagues differ, or this proves nothing')
      .not.toBe(againstWhole);
    expect((await him('l')).wrcPlus).toBe(againstSplit);
  });
});

describe('the order the production sort writes', () => {
  /*
   * These use men the fixture already has on the roster. A player invented
   * here would need a roster row, a value row, ratings and a glove before the
   * card would look at him, and the first version of this test quietly
   * asserted nothing because he had none of them.
   */
  const SLUGGER = 24; // Fill Leftie, LF
  const ORDINARY = 26; // Fill Rightie, RF

  it('bats a left-handed-pitching specialist higher against one', async () => {
    const vsLeft = (await card('l')).lineup.find((l) => l.player_id === PLATOON)!;
    const vsRight = (await card('r')).lineup.find((l) => l.player_id === PLATOON)!;
    expect(vsLeft.slot, 'the .400 vs LHP bat should not sit where the .125 vs RHP bat does')
      .toBeLessThan(vsRight.slot);
  });

  it("reads a star's thin bad split as the star, not as an average hitter", async () => {
    /*
     * The case that settles which prior is right. The slugger has fifteen poor
     * trips against left-handers; the ordinary man has two hundred and fifty
     * slightly good ones. Regressed toward league average the slugger lands
     * near 100 and the ordinary man a shade above it, so the ordinary man bats
     * higher — on the strength of fifteen at-bats. Regressed toward the
     * slugger's own season he stays a slugger, which is what fifteen at-bats
     * against him are worth.
     */
    line.run(SLUGGER, SEASON, IDS.mlbTeam, IDS.league, 1, 515, 440, 150, 35, 45, 70, 80, 110, 130, 7.0);
    line.run(SLUGGER, SEASON, IDS.mlbTeam, IDS.league, 2, 15, 14, 2, 0, 0, 1, 6, 1, 1, 0.0);
    line.run(SLUGGER, SEASON, IDS.mlbTeam, IDS.league, 3, 500, 426, 148, 35, 45, 69, 74, 109, 129, 7.0);

    line.run(ORDINARY, SEASON, IDS.mlbTeam, IDS.league, 1, 500, 450, 111, 18, 8, 45, 100, 50, 46, 1.0);
    line.run(ORDINARY, SEASON, IDS.mlbTeam, IDS.league, 2, 250, 225, 58, 9, 4, 22, 48, 25, 23, 0.5);
    line.run(ORDINARY, SEASON, IDS.mlbTeam, IDS.league, 3, 250, 225, 53, 9, 4, 23, 52, 25, 23, 0.5);

    const vsLeft = (await card('l')).lineup;
    const big = vsLeft.find((l) => l.player_id === SLUGGER);
    const plain = vsLeft.find((l) => l.player_id === ORDINARY);
    expect(big, 'the slugger is on the roster and must be on the card').toBeDefined();
    expect(plain, 'the ordinary man is on the roster and must be on the card').toBeDefined();
    expect(big!.slot, 'fifteen at-bats must not demote a 7-WAR bat below an average one')
      .toBeLessThan(plain!.slot);
  });
});
