import { beforeAll, describe, expect, it } from 'vitest';
import { db as leagueDb } from '../server/db.js';
import { historyDb } from '../server/history.js';
import request from './request.js';
import { loadConfig } from '../server/config.js';
import { IDS } from './fixture.js';

/**
 * What a man is worth, beside what he gained.
 *
 * "Would be appropriate and convenient to have Value and Talent columns shown
 * on the Development page."
 *
 * It is the obvious pairing, and the page was the one place a rating change
 * was shown without it: a gain of four on potential reads completely
 * differently on a man already in the top decile and on one who is nowhere
 * near it. The numbers are the same percentiles the Prospects and Free Agents
 * pages show, from the same percentiler, so a reader comparing two screens is
 * comparing the same thing.
 */

const SAVE = loadConfig().saveName ?? 'unknown';
// Dates of their own, so this file's snapshots cannot be confused with another's
const EARLIER = '2031-4-1';
const LATER = '2031-9-1';
/** A man the export gave no value row at all, which happens. */
const UNVALUED = 7711;

beforeAll(() => {
  leagueDb.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'No', 'Value', 24, 6, 0, 1, 1, 71, ?, ?, 0, 0, 0, 0)`
  ).run(UNVALUED, IDS.mlbTeam, IDS.mlbTeam);

  const snap = historyDb.prepare(
    `INSERT INTO rating_snapshots
       (save_name, game_date, player_id, name, team_id, org_id, level, position, age, con, pot, cur)
     VALUES (?, ?, ?, ?, ?, ?, 1, 6, 24, ?, ?, ?)`
  );
  // The fixture's starter carries a players_value row; this one does not
  snap.run(SAVE, EARLIER, IDS.starter, 'Valued Man', IDS.mlbTeam, IDS.mlbTeam, 30, 40, 40);
  snap.run(SAVE, LATER, IDS.starter, 'Valued Man', IDS.mlbTeam, IDS.mlbTeam, 48, 55, 52);
  snap.run(SAVE, EARLIER, UNVALUED, 'No Value', IDS.mlbTeam, IDS.mlbTeam, 30, 40, 40);
  snap.run(SAVE, LATER, UNVALUED, 'No Value', IDS.mlbTeam, IDS.mlbTeam, 45, 50, 48);
});

interface Change {
  player_id: number; curDelta: number; potDelta: number;
  overallPct: number | null; talentPct: number | null;
}

const changes = async (): Promise<Change[]> =>
  ((await request(`/api/development/${IDS.mlbTeam}?from=${EARLIER}&to=${LATER}`)).changes ??
    []) as Change[];

describe('the development page', () => {
  it('reports what a man is worth alongside what he gained', async () => {
    const him = (await changes()).find((c) => c.player_id === IDS.starter);
    expect(him, 'the improving player never reached the page').toBeDefined();
    expect(him!.overallPct).not.toBeUndefined();
    expect(him!.talentPct).not.toBeUndefined();
  });

  it('still reports the change itself', async () => {
    const him = (await changes()).find((c) => c.player_id === IDS.starter)!;
    expect(him.curDelta).toBeGreaterThan(0);
  });

  /*
   * A percentile the export cannot support is null, never a zero — zero is a
   * real percentile and means the worst man in the league, which is a
   * different statement from "no value row for him".
   */
  it('says nothing rather than zero for a man with no value row', async () => {
    const him = (await changes()).find((c) => c.player_id === UNVALUED);
    expect(him, 'the unvalued player was dropped from the page').toBeDefined();
    expect(him!.overallPct).toBeNull();
    expect(him!.talentPct).toBeNull();
  });
});
