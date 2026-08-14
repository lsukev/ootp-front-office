import { db, tableExists } from './db.js';
import { computeBatting, computePitching, leagueBaseline } from './stats.js';

/**
 * How a man is actually playing this season, in one league-relative number.
 *
 * Written because the contract advice had none. It ran on OOTP's Value figure
 * alone, which is value TO THE CLUB and therefore counts playing time: among
 * the 280 major-league relievers in the save this was found in, Value tracked
 * innings pitched at +0.37 and ERA at +0.19 — the wrong way round, worse ERA
 * reading as slightly more valuable — while barely tracking the stuff rating
 * at all, at +0.12. A converted starter soaking up long relief therefore came
 * out near the top of the reliever pool whatever he did with the ball, and the
 * app told its reader to extend him before somebody else did.
 *
 * So the index here is deliberately the plainest thing available: 100 is the
 * league, higher is better, and it is the same familiar number the rest of the
 * app already shows on every player — wRC+ for a bat, ERA+ for an arm.
 */

/**
 * Enough of a season for the number to carry an argument.
 *
 * The same thresholds the two-way test uses, for the same reason: twenty
 * innings and a hundred trips are where a line stops being an anecdote. Below
 * these the verdict is 'unknown' rather than 'poor' — a man with nine innings
 * has not shown anything, and treating that as evidence against him would be
 * the same error in the opposite direction.
 */
const MEANINGFUL_OUTS = 60;
const MEANINGFUL_PA = 100;

/** Comfortably above the league, roughly it, and clearly below it. */
const GOOD = 115;
const FAIR = 90;

export interface SeasonForm {
  /** League-relative, 100 is average: wRC+ for a batter, ERA+ for a pitcher. */
  index: number | null;
  /** Whether enough has been played for the index to mean anything. */
  meaningful: boolean;
  /** The line itself, for the page to show and the assistants to quote. */
  line: string | null;
  verdict: 'good' | 'fair' | 'poor' | 'unknown';
}

export const UNKNOWN_FORM: SeasonForm = {
  index: null, meaningful: false, line: null, verdict: 'unknown',
};

/** ".248/.343/.392", written the way a slash line is written. */
function slash(
  avg: number | null | undefined, obp: number | null | undefined, slg: number | null | undefined
): string | null {
  if (avg == null || obp == null || slg == null) return null;
  const three = (v: number) => v.toFixed(3).replace(/^0\./, '.');
  return `${three(avg)}/${three(obp)}/${three(slg)}`;
}

const verdictOf = (index: number | null, meaningful: boolean): SeasonForm['verdict'] => {
  if (!meaningful || index === null) return 'unknown';
  if (index >= GOOD) return 'good';
  if (index >= FAIR) return 'fair';
  return 'poor';
};

/**
 * This season's form for everyone on a club, at that club's own level.
 *
 * Scoped to the level deliberately. A reliever who has shuttled to Triple-A
 * and back has two lines, and blending them produces a number that describes
 * nobody — the same fault that once made the staff page disagree with OOTP's
 * own pitching screen.
 */
export function seasonFormByPlayer(teamId: number): Map<number, SeasonForm> {
  const out = new Map<number, SeasonForm>();
  if (!tableExists('players') || !tableExists('teams')) return out;

  const team = db.prepare(`SELECT league_id, level FROM teams WHERE team_id = ?`).get(teamId) as
    | { league_id: number; level: number }
    | undefined;
  if (!team) return out;

  /*
   * The season, from whichever table has one. Reading it off the pitching
   * stats alone loses every batter in a save that has none — which is not the
   * hypothetical it sounds like: a league exported before its first game has
   * no pitching lines at all, and this would have quietly returned nothing for
   * the whole club rather than the batting it did have.
   */
  const years = [
    tableExists('players_career_pitching_stats')
      ? (db.prepare(`SELECT MAX(year) AS y FROM players_career_pitching_stats`).get() as { y: number | null }).y
      : null,
    tableExists('players_career_batting_stats')
      ? (db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number | null }).y
      : null,
  ].filter((y): y is number => y !== null);
  if (years.length === 0) return out;
  const year = Math.max(...years);

  const base = leagueBaseline(team.league_id, year, team.level);

  if (tableExists('players_career_pitching_stats')) {
    const rows = db
      .prepare(
        `SELECT s.player_id, SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.ha) AS ha,
                SUM(s.bb) AS bb, SUM(s.k) AS k, SUM(s.hra) AS hra, SUM(s.hp) AS hp,
                SUM(s.bf) AS bf, SUM(s.g) AS g, SUM(s.gs) AS gs, SUM(s.w) AS w,
                SUM(s.l) AS l, SUM(s.s) AS sv, SUM(s.hld) AS hld, SUM(s.war) AS war
         FROM players_career_pitching_stats s
         JOIN players p ON p.player_id = s.player_id
         WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND p.team_id = ?
         GROUP BY s.player_id`
      )
      .all(year, team.level, teamId) as Array<Record<string, number>>;
    for (const row of rows) {
      const stats = computePitching(row, base, teamId);
      const meaningful = (row.outs ?? 0) >= MEANINGFUL_OUTS;
      const index = stats.eraPlus ?? null;
      // A scoreless spell has no ERA+ to report — the division has no bottom.
      // Better to leave it out than to print a dash in the middle of a line
      // somebody is going to read aloud.
      const era = stats.era !== null && stats.era !== undefined ? stats.era.toFixed(2) : null;
      out.set(row.player_id, {
        index,
        meaningful,
        line: [
          `${stats.ip ?? 0} IP`,
          era !== null ? `${era} ERA` : null,
          index !== null ? `${index} ERA+` : null,
        ].filter(Boolean).join(', '),
        verdict: verdictOf(index, meaningful),
      });
    }
  }

  if (tableExists('players_career_batting_stats')) {
    const rows = db
      .prepare(
        `SELECT s.player_id, SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d,
                SUM(s.t) AS t3, SUM(s.hr) AS hr, SUM(s.bb) AS bb, SUM(s.ibb) AS ibb,
                SUM(s.hp) AS hp, SUM(s.sf) AS sf, SUM(s.k) AS k, SUM(s.r) AS r,
                SUM(s.rbi) AS rbi, SUM(s.sb) AS sb, SUM(s.cs) AS cs, SUM(s.war) AS war
         FROM players_career_batting_stats s
         JOIN players p ON p.player_id = s.player_id
         WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND p.team_id = ? AND p.position <> 1
         GROUP BY s.player_id`
      )
      .all(year, team.level, teamId) as Array<Record<string, number>>;
    for (const row of rows) {
      const stats = computeBatting(row, base, teamId);
      const meaningful = (row.pa ?? 0) >= MEANINGFUL_PA;
      const index = stats.wrcPlus ?? null;
      out.set(row.player_id, {
        index,
        meaningful,
        line: [
          `${row.pa ?? 0} PA`,
          slash(stats.avg, stats.obp, stats.slg),
          index !== null ? `${index} wRC+` : null,
        ].filter(Boolean).join(', '),
        verdict: verdictOf(index, meaningful),
      });
    }
  }

  return out;
}
