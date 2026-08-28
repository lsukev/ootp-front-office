import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db as leagueDb } from '../server/db.js';
import { historyDb, takeSnapshot } from '../server/history.js';
import request from './request.js';
import { loadConfig } from '../server/config.js';
import { IDS } from './fixture.js';

/**
 * A sixteen-year-old is not a major leaguer.
 *
 * "On the Development page 16-17 y.o. International Complex players are
 * labeled MLB level."
 *
 * OOTP parks a signing nobody has assigned yet on the parent club's team_id,
 * so joining teams for the level hands him the major-league one. The snapshot
 * did exactly that and had done since the first one was ever taken — in my own
 * save forty-three men in one organisation are recorded at MLB with no roster
 * spot anywhere, the youngest of them sixteen.
 *
 * This is the fourth thing to be caught by that same parking spot: the depth
 * chart had a dozen of them standing among the major-league pitchers, the farm
 * page counted them as men a call-up would displace, and the streak strip
 * reported their runs in the complex league as news from the majors.
 */

const COMPLEX_KID = 9500;
const REAL_MAJOR = 9501;
const SAVE = loadConfig().saveName ?? 'unknown';

const EARLIER = '2030-4-1';
const LATER = '2030-9-1';

beforeAll(() => {
  const player = leagueDb.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Complex', ?, ?, 6, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  // Signed out of the international complex, sitting on the parent club with
  // no roster row — which is what OOTP does and what fooled the snapshot
  player.run(COMPLEX_KID, 'Kid', 16, 91, IDS.mlbTeam, IDS.mlbTeam);
  // A genuine major leaguer on the same club, for contrast
  player.run(REAL_MAJOR, 'Man', 28, 92, IDS.mlbTeam, IDS.mlbTeam);
  leagueDb.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, REAL_MAJOR);
  for (const id of [COMPLEX_KID, REAL_MAJOR]) {
    leagueDb.prepare(
      `INSERT INTO players_batting VALUES (?, 30, 30, 30, 30, 30, 40, 40, 40, 40, 40, 40)`
    ).run(id);
  }

  /*
   * Two snapshots with a rating change between them, recorded the way the old
   * code recorded them: at the club's level, which for an unassigned man is
   * the major-league one.
   */
  const snap = historyDb.prepare(
    `INSERT INTO rating_snapshots
       (save_name, game_date, player_id, name, team_id, org_id, level, position, age, con, pot, cur)
     VALUES (?, ?, ?, ?, ?, ?, 1, 6, ?, ?, 40, ?)`
  );
  snap.run(SAVE, EARLIER, COMPLEX_KID, 'Complex Kid', IDS.mlbTeam, IDS.mlbTeam, 16, 30, 30);
  snap.run(SAVE, LATER, COMPLEX_KID, 'Complex Kid', IDS.mlbTeam, IDS.mlbTeam, 16, 45, 45);
  snap.run(SAVE, EARLIER, REAL_MAJOR, 'Complex Man', IDS.mlbTeam, IDS.mlbTeam, 28, 30, 30);
  snap.run(SAVE, LATER, REAL_MAJOR, 'Complex Man', IDS.mlbTeam, IDS.mlbTeam, 28, 45, 45);
});

interface Change { player_id: number; name: string; age: number; level: number }

const changes = async (): Promise<Change[]> =>
  ((await request(`/api/development/${IDS.mlbTeam}?from=${EARLIER}&to=${LATER}`)).changes ??
    []) as Change[];

describe('a man on no club at all', () => {
  it('is not reported at the major-league level', async () => {
    const him = (await changes()).find((c) => c.player_id === COMPLEX_KID);
    expect(him, 'the complex signing never reached the page').toBeDefined();
    expect(him!.level, 'a sixteen-year-old was still labelled MLB').not.toBe(1);
  });

  it('is reported as belonging to the organisation instead', async () => {
    // Zero is the level for somebody on no club; the page draws it as ORG
    const him = (await changes()).find((c) => c.player_id === COMPLEX_KID);
    expect(him!.level).toBe(0);
  });

  it('is still shown rather than quietly dropped', async () => {
    /*
     * These are real prospects and every club carries some. Hiding them would
     * have been the easier fix and the wrong one — the depth chart gives them
     * a column of their own for the same reason.
     */
    expect((await changes()).some((c) => c.player_id === COMPLEX_KID)).toBe(true);
  });
});

describe('a man who really is on the major-league roster', () => {
  it('is left alone', async () => {
    // The repair must not empty the top level of the men who belong in it
    const him = (await changes()).find((c) => c.player_id === REAL_MAJOR);
    expect(him, 'the major leaguer vanished').toBeDefined();
    expect(him!.level).toBe(1);
  });
});

describe('the snapshot taken from now on', () => {
  it('records no level for a man on no roster', () => {
    /*
     * The repair above corrects what is already stored. This is the fault
     * itself: a snapshot taken today should not need correcting tomorrow.
     */
    takeSnapshot();
    const row = historyDb
      .prepare(`SELECT level FROM rating_snapshots WHERE player_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(COMPLEX_KID) as { level: number } | undefined;
    expect(row, 'no snapshot was taken at all').toBeDefined();
    expect(row!.level, 'the club\'s level was inherited again').toBe(0);
  });

  it('still records the level of a man who has one', () => {
    const row = historyDb
      .prepare(`SELECT level FROM rating_snapshots WHERE player_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(REAL_MAJOR) as { level: number } | undefined;
    expect(row!.level).toBe(1);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the page', () => {
  it('has a name for it', () => {
    expect(read('src/pages/Development.tsx')).toMatch(/0: 'ORG'/);
  });

  it('does not call an unknown level Rookie ball', () => {
    /*
     * The old fallback did, which would have hidden this very fault behind a
     * plausible answer had the level arrived as anything but one.
     */
    const dev = read('src/pages/Development.tsx');
    expect(dev).not.toMatch(/LEVEL_NAMES\[c\.level\] \?\? 'R'/);
    expect(dev).toMatch(/\?\? `L\$\{level\}`/);
  });
});
