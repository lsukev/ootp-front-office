import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * A season drawn as it happened.
 *
 * "How does a player's AVG, OPS, ERA, etc., change throughout the year, or even
 * compare year over year?"
 *
 * A season line is one number standing for six months and it hides the shape of
 * everything: a .270 hitter who was at .190 in May and .330 since is not the
 * same man as one who has been .270 throughout, and no stat page in the app
 * could tell them apart. OOTP writes a row per player per game — eighty
 * thousand of them in my own save — and nothing was reading them beyond the
 * last fortnight.
 */

const HITTER = 9700;
const ARM = 9701;

/** Ten hitless games, then ten good ones. A shape no season line can show. */
const COLD = 10;
const HOT = 10;

beforeAll(() => {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Slow', 'Starter', 27, 7, 0, 1, 1, 71, ?, ?, 0, 0, 0, 0)`
  ).run(HITTER, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Steady', 'Arm', 29, 1, 11, 1, 1, 72, ?, ?, 0, 0, 0, 0)`
  ).run(ARM, IDS.mlbTeam, IDS.mlbTeam);

  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  );
  const bat = db.prepare(
    `INSERT INTO players_game_batting
       (player_id, year, team_id, game_id, league_id, level_id, split_id, position,
        ab, h, d, t, hr, bb, hp, sf, pa, g)
     VALUES (?, ?, ?, ?, ?, 1, 0, 7, 4, ?, 0, 0, ?, 0, 0, 0, 4, 1)`
  );
  const arm = db.prepare(
    `INSERT INTO players_game_pitching_stats
       (player_id, year, team_id, game_id, league_id, level_id, split_id, outs, er, ha, bb, k, g)
     VALUES (?, ?, ?, ?, ?, 1, 0, 3, ?, ?, 0, 2, 1)`
  );

  for (let i = 0; i < COLD + HOT; i++) {
    const id = 7000 + i;
    const day = String(i + 1).padStart(2, '0');
    game.run(id, IDS.mlbTeam, IDS.otherMlbTeam, `${SEASON}-6-${i + 1}`, IDS.league, 0);
    // Hitless for ten games, then two hits and a homer for ten
    bat.run(HITTER, SEASON, IDS.mlbTeam, id, IDS.league, i < COLD ? 0 : 2, i < COLD ? 0 : 1);
    // The arm gives up a run early and nothing later
    arm.run(ARM, SEASON, IDS.mlbTeam, id, IDS.league, i < COLD ? 1 : 0, i < COLD ? 2 : 0);
    void day;
  }

  // A spring-training game, which is not the season and must not be charted
  game.run(7999, IDS.mlbTeam, IDS.otherMlbTeam, `${SEASON}-3-1`, IDS.league, 3);
  bat.run(HITTER, SEASON, IDS.mlbTeam, 7999, IDS.league, 4, 4);

  // Two major-league seasons, so the year-over-year chart has something to draw
  const career = db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 1, 1, 600, 550, ?, 25, 2, 20, 45, 0, 3, 2, 90, 4, 1, 70, 75, 2.0)`
  );
  career.run(HITTER, SEASON - 1, IDS.mlbTeam, IDS.league, 150);
  career.run(HITTER, SEASON - 2, IDS.mlbTeam, IDS.league, 120);
});

interface Point { game: number; date: string | null; toDate: number | null; rolling: number | null }
interface Trend {
  name: string; year: number; window: number; level: number | null;
  batting: Record<string, Point[]>;
  pitching: Record<string, Point[]>;
  seasons: Array<Record<string, number | null>>;
  armSeasons: Array<Record<string, number | null>>;
}

const trend = (id: number): Promise<Trend> => request(`/api/player-trend/${id}`);

describe('a hitter who started cold', () => {
  it('has a point for every game he played', async () => {
    const d = await trend(HITTER);
    expect(d.batting.avg).toHaveLength(COLD + HOT);
  });

  it('shows the average climbing out of the hole rather than one flat number', async () => {
    /*
     * Hitless through ten and then two hits a game: the season line is .250 and
     * says nothing. The curve is the point of the feature.
     */
    const avg = (await trend(HITTER)).batting.avg;
    expect(avg[COLD - 1].toDate, 'ten hitless games did not read .000').toBe(0);
    expect(avg[avg.length - 1].toDate!).toBeGreaterThan(0.2);
  });

  it('reads his form faster than his record does', async () => {
    // By the last game the window holds mostly hot games and the season holds
    // both halves, so form must be ahead of record
    const avg = (await trend(HITTER)).batting.avg;
    const last = avg[avg.length - 1];
    expect(last.rolling!).toBeGreaterThan(last.toDate!);
  });

  it('agrees with itself where the window covers the whole season', async () => {
    // For the first fifteen games the two readings are the same measurement
    const avg = (await trend(HITTER)).batting.avg;
    expect(avg[3].rolling).toBe(avg[3].toDate);
  });

  it('leaves spring training out of it', async () => {
    /*
     * A four-for-four in March would have started him at 1.000 and is not the
     * season anybody means.
     */
    const d = await trend(HITTER);
    expect(d.batting.avg).toHaveLength(COLD + HOT);
    expect(d.batting.avg[0].toDate, 'an exhibition opened the season').toBe(0);
  });

  it('offers the four rates a hitter is read on', async () => {
    expect(Object.keys((await trend(HITTER)).batting).sort()).toEqual(['avg', 'obp', 'ops', 'slg']);
  });
});

describe('a pitcher', () => {
  it('is measured on his own rates, not a hitter\'s', async () => {
    const d = await trend(ARM);
    expect(Object.keys(d.pitching).sort()).toEqual(['era', 'k9', 'whip']);
    expect(d.batting).toEqual({});
  });

  it('shows an earned run average coming down as the runs stop', async () => {
    const era = (await trend(ARM)).pitching.era;
    expect(era[COLD - 1].toDate!).toBeGreaterThan(era[era.length - 1].toDate!);
    /*
     * Form is ahead of record but not at zero: with a fifteen-game window and
     * twenty outings the window still holds five of the bad ones, which is the
     * window doing exactly what it says rather than a fault.
     */
    const last = era[era.length - 1];
    expect(last.rolling!).toBeLessThan(last.toDate!);
  });
});

describe('year over year', () => {
  it('lines up the seasons he actually played in the majors', async () => {
    const d = await trend(HITTER);
    const years = d.seasons.map((s) => s.year);
    expect(years).toContain(SEASON - 1);
    expect(years).toContain(SEASON - 2);
  });

  it('reports a rate per season rather than a running total', async () => {
    // .273 and .218 from the two lines above, each on its own 550 at-bats
    const d = await trend(HITTER);
    const earlier = d.seasons.find((s) => s.year === SEASON - 2)!;
    const later = d.seasons.find((s) => s.year === SEASON - 1)!;
    expect(later.avg!).toBeGreaterThan(earlier.avg!);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the page', () => {
  it('says which reading it is showing', () => {
    /*
     * The two answer different questions and mislead in different ways — a
     * chart that does not say which one it is is worse than no chart.
     */
    const src = read('src/PlayerTrend.tsx');
    expect(src).toMatch(/season to date/);
    // Wrapped across lines in the JSX, so the whitespace is not the assertion
    expect(src.replace(/\s+/g, ' ')).toMatch(/form rather than record/);
  });

  it('draws it with the chart the app already has', () => {
    // Hand-rolled SVG, because the desktop build is offline and a charting
    // package would be the largest dependency in it
    expect(read('src/PlayerTrend.tsx')).toMatch(/import \{ LineChart \} from '\.\/Chart'/);
  });
});
