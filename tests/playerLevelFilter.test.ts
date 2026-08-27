import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { inScope } from '../src/playerModal.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Reading a career one level at a time.
 *
 * "Could you add filters to the stats in the player detail pages so I can see
 * only MLB or only Minor league?" A man who came up through a system has his
 * major-league line buried among a dozen years of it, and the question a reader
 * usually has — what has he done in the majors — meant reading past everything
 * else.
 *
 * The split is level one against everything under it. Not a list of what counts
 * as the minors: that would need maintaining, and a league with levels this app
 * has never seen would fall out of it.
 */

const CAREER_MAN = 9950;
const MAJORS_ONLY = 9951;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Career', ?, 29, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, ?, 1, 400, 360, 100, 20, 2, 15, 35, 0, 3, 2, 80, 5, 2, 55, 60, 2.0)`
  );
  const field = db.prepare(
    `INSERT INTO players_career_fielding_stats
       (player_id, year, level_id, split_id, position, g, gs, ip, po, a, e, dp)
     VALUES (?, ?, ?, 1, 7, 100, 95, 800.0, 180, 8, 3, 1)`
  );

  // Three years up, two years down — the shape the request is about
  player.run(CAREER_MAN, 'Man', 51, IDS.mlbTeam, IDS.mlbTeam);
  for (const [year, level] of [[SEASON, 1], [SEASON - 1, 1], [SEASON - 2, 1],
                               [SEASON - 3, 2], [SEASON - 4, 3]] as const) {
    bat.run(CAREER_MAN, year, IDS.mlbTeam, IDS.league, level);
    field.run(CAREER_MAN, year, level);
  }

  // Never played anywhere but the majors
  player.run(MAJORS_ONLY, 'Lifer', 52, IDS.mlbTeam, IDS.mlbTeam);
  bat.run(MAJORS_ONLY, SEASON, IDS.mlbTeam, IDS.league, 1);
  field.run(MAJORS_ONLY, SEASON, 1);
});

describe('which levels a row belongs to', () => {
  it('keeps everything when nothing is asked for', () => {
    expect(inScope(1, 'all')).toBe(true);
    expect(inScope(4, 'all')).toBe(true);
    expect(inScope(null, 'all')).toBe(true);
  });

  it('treats level one as the majors and everything else as below it', () => {
    expect(inScope(1, 'mlb')).toBe(true);
    expect(inScope(2, 'mlb')).toBe(false);
    expect(inScope(1, 'minors')).toBe(false);
    expect(inScope(6, 'minors')).toBe(true);
  });

  it('puts a level it has never seen below the majors rather than losing it', () => {
    /*
     * A custom league can use numbers this app has no name for. Anything that
     * is not the majors is under them, which is the only reading that cannot
     * quietly drop a row.
     */
    expect(inScope(97, 'minors')).toBe(true);
    expect(inScope(97, 'mlb')).toBe(false);
  });

  it('does not read a missing level as the majors', () => {
    // The dangerous direction: a blank counted as MLB would show minor-league
    // work as major-league, which is the error this app keeps having to fix
    expect(inScope(undefined, 'mlb')).toBe(false);
    expect(inScope(null, 'mlb')).toBe(false);
  });
});

describe('what the card is given to filter on', () => {
  it('carries the level on every batting year', async () => {
    const d = await request(`/api/player/${CAREER_MAN}`);
    expect(d.battingYears.length).toBe(5);
    for (const y of d.battingYears) expect(typeof y.level_id).toBe('number');
    expect(d.battingYears.filter((y: { level_id: number }) => y.level_id === 1)).toHaveLength(3);
  });

  it('carries the level on every fielding year', async () => {
    /*
     * The batting and pitching rows keep it by spreading the database row; the
     * fielding ones are built field by field and were dropping it, so the
     * fielding table could not have been filtered at all.
     */
    const d = await request(`/api/player/${CAREER_MAN}`);
    expect(d.fieldingYears.length).toBeGreaterThan(0);
    for (const f of d.fieldingYears) expect(typeof f.level_id).toBe('number');
    expect(d.fieldingYears.some((f: { level_id: number }) => f.level_id !== 1)).toBe(true);
  });

  it('splits a career cleanly, losing nothing', async () => {
    // Every row belongs to exactly one side of the filter
    const d = await request(`/api/player/${CAREER_MAN}`);
    const majors = d.battingYears.filter((y: { level_id: number }) => inScope(y.level_id, 'mlb'));
    const minors = d.battingYears.filter((y: { level_id: number }) => inScope(y.level_id, 'minors'));
    expect(majors.length + minors.length).toBe(d.battingYears.length);
    expect(majors.length).toBe(3);
    expect(minors.length).toBe(2);
  });

  it('gives a lifer nothing to divide', async () => {
    // The card offers no filter in this case, and this is what it reads to decide
    const d = await request(`/api/player/${MAJORS_ONLY}`);
    const rows = [...d.battingYears, ...(d.fieldingYears ?? [])];
    expect(rows.every((r: { level_id: number }) => r.level_id === 1)).toBe(true);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the card', () => {
  const modal = () => read('src/playerModal.tsx');

  it('filters all three history tables, not just one', () => {
    const src = modal();
    for (const arr of ['battingYears', 'pitchingYears', 'fieldingYears']) {
      expect(src, `${arr} is not filtered`).toMatch(
        new RegExp(`const ${arr} = [^;]*inScope`, 's')
      );
    }
  });

  it('offers the filter only where there is something to divide', () => {
    // A man who has never played below the majors gains nothing from being
    // asked which levels he wants, and the card is long enough already
    expect(modal()).toMatch(/const mixed =/);
    expect(modal()).toMatch(/mixed \? <LevelPicker/);
  });

  it('says so when a filter empties a table', () => {
    // Otherwise it is a bare header row, which reads as broken rather than empty
    expect(modal()).toMatch(/battingYears\.length === 0 &&/);
    expect(modal()).toMatch(/pitchingYears\.length === 0 &&/);
    expect(modal()).toMatch(/fieldingYears\.length === 0 &&/);
  });
});
