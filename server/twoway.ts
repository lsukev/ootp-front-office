import { db, tableExists } from './db.js';

/**
 * Players who belong in both halves of the club.
 *
 * OOTP gives a man one listed position, and the app split the roster on it:
 * position 1 was the pitching staff, everything else the batters. That loses
 * the two-way player entirely on one side. Shohei Ohtani is listed at
 * designated hitter, so eighty-six innings of his did not appear on the
 * Pitching Staff page at all, and a save with several such players hides
 * several of them.
 *
 * Decided on what a man has actually done rather than on how he is labelled.
 * Ratings would need a threshold, and the scale those are on is the user's
 * setting — it may be 20-80 or 1-5 — so any number chosen here would be right
 * in one save and nonsense in another. Innings and plate appearances mean the
 * same thing in every save there is.
 */

/*
 * Both sides, and enough of each to be a job rather than an oddity.
 *
 * The first attempt asked only whether a man had done a little of the other
 * thing, and swept up seventy-three players: outfielders who mopped up three
 * innings of a blowout, and every pitcher in the minor leagues, where there is
 * often no designated hitter and they all bat. Requiring twenty innings AND a
 * hundred plate appearances leaves twenty-six across the whole league, headed
 * by Ohtani at 86 innings and 341 trips — which is the shape the answer should
 * have.
 */
const MEANINGFUL_OUTS = 60; // twenty innings
const MEANINGFUL_PA = 100;

interface TwoWay {
  /** Listed as a position player, but has pitched. */
  pitchers: Set<number>;
  /** Listed as a pitcher, but has batted beyond the odd turn. */
  batters: Set<number>;
}

let cache: TwoWay | null = null;

export function clearTwoWayCache(): void {
  cache = null;
}

function currentYear(): number | null {
  if (!tableExists('players_career_pitching_stats')) return null;
  const row = db.prepare(`SELECT MAX(year) AS y FROM players_career_pitching_stats`).get() as
    | { y: number | null }
    | undefined;
  return row?.y ?? null;
}

function compute(): TwoWay {
  const empty: TwoWay = { pitchers: new Set(), batters: new Set() };
  const year = currentYear();
  if (year === null || !tableExists('players')) return empty;

  const pitchers = new Set<number>();
  const batters = new Set<number>();

  if (tableExists('players_career_batting_stats') && tableExists('players_career_pitching_stats')) {
    /*
     * One query for both sets, because the test is the same either way: a man
     * who has done a real amount of both. Which list he lands in depends only
     * on how the save has him listed, and therefore which half of the app
     * would otherwise miss him.
     */
    const rows = db
      .prepare(
        `SELECT p.player_id, p.position,
                (SELECT SUM(b.pa) FROM players_career_batting_stats b
                  WHERE b.player_id = p.player_id AND b.year = ? AND b.split_id = 1) AS pa,
                (SELECT SUM(t.outs) FROM players_career_pitching_stats t
                  WHERE t.player_id = p.player_id AND t.year = ? AND t.split_id = 1) AS outs
         FROM players p WHERE p.retired = 0`
      )
      .all(year, year) as Array<{ player_id: number; position: number; pa: number | null; outs: number | null }>;
    for (const r of rows) {
      if ((r.outs ?? 0) < MEANINGFUL_OUTS || (r.pa ?? 0) < MEANINGFUL_PA) continue;
      if (r.position === 1) batters.add(r.player_id);
      else pitchers.add(r.player_id);
    }
  }

  cache = { pitchers, batters };
  return cache;
}

/** Position players who have pitched enough to belong on the staff page. */
export function twoWayPitchers(): Set<number> {
  return (cache ?? compute()).pitchers;
}

/** Pitchers who have batted enough to belong among the hitters. */
export function twoWayBatters(): Set<number> {
  return (cache ?? compute()).batters;
}

/**
 * A SQL fragment for "counts as a pitcher here", for the queries that were
 * testing position = 1 directly. Returns a literal id list rather than a
 * bound parameter so it can be dropped into an existing prepared statement.
 */
export function countsAsPitcherSql(column = 'p.player_id'): string {
  const ids = [...twoWayPitchers()];
  return ids.length > 0 ? `(p.position = 1 OR ${column} IN (${ids.join(',')}))` : 'p.position = 1';
}

/** The mirror: "counts as a batter here". */
export function countsAsBatterSql(column = 'p.player_id'): string {
  const ids = [...twoWayBatters()];
  return ids.length > 0 ? `(p.position <> 1 OR ${column} IN (${ids.join(',')}))` : 'p.position <> 1';
}
