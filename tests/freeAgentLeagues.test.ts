import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../server/db.js';
import { post } from './request.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who counts as a free agent this club could sign.
 *
 * "I am playing a 2026 real life sim, and am in the 2026-27 offseason. Yankee
 * Jasson Dominguez is a free agent I am interested in. He does not appear in
 * the OOTP Front Office no matter how many times I refresh and download."
 *
 * He had spent the previous season at Triple-A, so OOTP recorded his last
 * league as the International League, and the list asked for the major league
 * alone. In my own save that filter hid 2,515 of 4,689 free agents — and the
 * best of the hidden ones were Jordan Montgomery with nine years of
 * major-league service, Jon Gray with seven and Griffin Canning with seven,
 * all veterans who happened to finish the year on a Triple-A roster.
 *
 * The line is now professional service in this organisation's league tree.
 * Amateurs stay out: the fourteen-to-twenty-one-year-olds with no league at
 * all are the draft class and the international pool, and they have their own
 * page.
 */

const AAA = 9001;
const ROOKIE = 9002;
/** A level below the affiliate, to prove the walk does not stop at one. */
const DEEP = 9003;

const FA = { majors: 8801, aaa: 8802, amateur: 8803, deep: 8804, otherOrg: 8805 };
const OTHER_LEAGUE = 9100;

beforeAll(() => {
  const league = db.prepare(
    `INSERT INTO leagues (league_id, name, abbr, parent_league_id, league_level, season_year,
                          "current_date", rules_fa_minimum_years, rules_schedule_games_per_team)
     VALUES (?, ?, ?, ?, ?, 2030, '2030-06-01', 6, 162)`
  );
  league.run(AAA, 'International League', 'AAA', IDS.league, 2);
  league.run(ROOKIE, 'Complex League', 'CPX', IDS.league, 6);
  league.run(DEEP, 'Deeper League', 'DP', AAA, 3);
  // A league that belongs to nobody in this org's tree
  league.run(OTHER_LEAGUE, 'Some Other League', 'SOL', 0, 1);

  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, team_id,
                          organization_id, retired, free_agent, last_league_id)
     VALUES (?, ?, 'Freeman', 28, 3, 0, 0, 0, 1, ?)`
  );
  player.run(FA.majors, 'Topflight', IDS.league);
  player.run(FA.aaa, 'Triplea', AAA);
  player.run(FA.deep, 'Deepleague', DEEP);
  player.run(FA.amateur, 'Amateur', 0);
  player.run(FA.otherOrg, 'Elsewhere', OTHER_LEAGUE);
});

const listed = async (): Promise<Array<Record<string, any>>> =>
  (await request(`/api/free-agents/${IDS.mlbTeam}`)).currentFAs;

const named = (rows: Array<Record<string, any>>, last: string) =>
  rows.find((p) => String(p.name).endsWith(last));

describe('the free agents a club can see', () => {
  it('lists one who finished the season in the top league', async () => {
    expect(named(await listed(), 'Freeman')).toBeDefined();
  });

  /*
   * The reported case, and the whole point: a man whose last league was the
   * affiliate rather than the parent.
   */
  it('lists one who finished the season at Triple-A', async () => {
    const rows = await listed();
    const him = rows.find((p) => p.player_id === FA.aaa);
    expect(him, 'a Triple-A free agent was missing from the list').toBeDefined();
  });

  it('walks the tree rather than stopping one level down', async () => {
    const rows = await listed();
    expect(rows.find((p) => p.player_id === FA.deep)).toBeDefined();
  });

  /*
   * 1,317 of them in my save, aged fourteen to twenty-one with no professional
   * service between them. They are free agents in the data and not in the
   * sense a manager means.
   */
  it('leaves the amateur pool out', async () => {
    const rows = await listed();
    expect(rows.find((p) => p.player_id === FA.amateur)).toBeUndefined();
  });

  it('leaves another organisation’s free agents out', async () => {
    const rows = await listed();
    expect(rows.find((p) => p.player_id === FA.otherOrg)).toBeUndefined();
  });
});

describe('saying where a free agent was last seen', () => {
  it('names the level for a man who was not in the top league', async () => {
    const rows = await listed();
    const him = rows.find((p) => p.player_id === FA.aaa)!;
    expect(him.lastSeen).toEqual({ league: 'International League', level: 'AAA' });
  });

  /*
   * Nothing to explain about a man who was already here, and a label on every
   * row would be noise on most of them.
   */
  it('says nothing about a man who finished in the top league', async () => {
    const rows = await listed();
    const him = rows.find((p) => p.player_id === FA.majors)!;
    expect(him.lastSeen).toBeNull();
  });
});
