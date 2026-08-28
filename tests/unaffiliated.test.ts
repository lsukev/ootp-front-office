import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * A universe where the lower leagues stand on their own.
 *
 * "I have a save where the MLB and all the minor League are not affiliated so
 * I can't access those the same way as the MLB."
 *
 * He could not, and the reason was one word in one query: the club picker
 * asked for level 1. In an affiliated save that is the whole of the answer,
 * because everything below the majors hangs off a parent club. In his, the
 * lower leagues are leagues in their own right and their clubs are level 2 or
 * 3 — so the picker never offered them, and every page behind it was
 * unreachable rather than empty.
 *
 * Being top of your own tree is what actually makes a club an organisation:
 * nothing above it, and nothing above its league. On my own affiliated save
 * that rule returns the same thirty clubs to the man.
 *
 * The rest of it was a filter that had always been redundant. OOTP gives every
 * club in a league that league's own level, so `league_id = ? AND level = 1`
 * says nothing extra about a major league and excludes every club of an
 * independent one.
 */

const INDIE_LEAGUE = 900;
const INDIE_A = 9600;
const INDIE_B = 9601;
/** Affiliated to the fixture's own major-league club, and so not an org. */
const AFFILIATE = 9602;

beforeAll(() => {
  db.prepare(
    `INSERT INTO leagues (league_id, name, abbr, parent_league_id, league_level, season_year)
     VALUES (?, 'Independent League', 'IND', 0, 3, 2030)`
  ).run(INDIE_LEAGUE);
  db.prepare(`INSERT INTO sub_leagues VALUES (?, 0, 'Only', 1)`).run(INDIE_LEAGUE);
  db.prepare(`INSERT INTO divisions VALUES (?, 0, 0, 'Independent', 0)`).run(INDIE_LEAGUE);
  db.prepare(`INSERT INTO divisions VALUES (?, 0, 1, 'Only Division', 0)`).run(IDS.league);

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, ?, ?, ?, 3, ?, 0, 0, ?, 0)`
  );
  // Two clubs in a league of their own, at Double-A level, with no parent
  team.run(INDIE_A, 'Freeport', 'Independents', 'FRE', INDIE_LEAGUE, 0);
  team.run(INDIE_B, 'Harbour', 'Mariners', 'HAR', INDIE_LEAGUE, 0);
  // And one that IS attached to a parent, in the same independent league
  team.run(AFFILIATE, 'Attached', 'Farmhands', 'ATT', INDIE_LEAGUE, IDS.mlbTeam);

  const rec = db.prepare(
    `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
     VALUES (?, 40, ?, ?, 0, ?, 0.5, 0, 0, 0)`
  );
  rec.run(INDIE_A, 25, 15, 1);
  rec.run(INDIE_B, 15, 25, 2);
  // And the fixture's own major-league clubs, so the affiliated case is a
  // real comparison rather than an empty one
  rec.run(IDS.mlbTeam, 24, 16, 1);
  rec.run(IDS.otherMlbTeam, 16, 24, 2);
});

interface Org { team_id: number; label: string; levelName: string | null; isHuman: boolean }

const orgs = async (): Promise<Org[]> => request('/api/orgs');

describe('a club at the top of its own tree', () => {
  it('can be picked, whatever level it plays at', async () => {
    // The whole of the report: his clubs were level 3 and the picker wanted 1
    const ids = (await orgs()).map((o) => o.team_id);
    expect(ids, 'an unaffiliated club was still unreachable').toContain(INDIE_A);
    expect(ids).toContain(INDIE_B);
  });

  it('says which level it is, once the list holds more than one', async () => {
    /*
     * On an affiliated save every club is MLB and saying so says nothing; here
     * it is the only thing telling a Double-A club apart from the major-league
     * club it is not attached to.
     */
    const indie = (await orgs()).find((o) => o.team_id === INDIE_A);
    expect(indie!.levelName).toBe('AA');
    const major = (await orgs()).find((o) => o.team_id === IDS.mlbTeam);
    expect(major!.levelName).toBe('MLB');
  });
});

describe('a club that hangs off another', () => {
  it('is still not offered as an organisation of its own', async () => {
    // It is somebody's farm club, and the org it belongs to is already listed
    const ids = (await orgs()).map((o) => o.team_id);
    expect(ids, 'an affiliate was offered as its own organisation').not.toContain(AFFILIATE);
    expect(ids, 'the fixture\'s own Triple-A club was offered').not.toContain(IDS.aaaTeam);
  });

  it('leaves an ordinary affiliated save exactly as it was', async () => {
    // The parent clubs, and nothing that hangs off one
    const ids = (await orgs()).map((o) => o.team_id);
    expect(ids).toContain(IDS.mlbTeam);
    expect(ids).toContain(IDS.otherMlbTeam);
  });
});

describe('the pages behind the picker', () => {
  it('answer for an independent club rather than coming back empty', async () => {
    /*
     * The standings are the clearest case: scoped to the club's league already,
     * they also demanded level 1, so an independent league returned nobody.
     */
    const d = await request(`/api/standings/${INDIE_A}`);
    const names = JSON.stringify(d);
    expect(names, 'the independent league had no standings at all').toMatch(/Freeport|Harbour/);
  });

  it('still answer for a major-league club', async () => {
    // The filter that was dropped was redundant there, not load-bearing
    const d = await request(`/api/standings/${IDS.mlbTeam}`);
    expect(JSON.stringify(d)).toMatch(/Test|Other/);
  });
});
