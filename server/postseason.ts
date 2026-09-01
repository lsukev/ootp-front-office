import { db, DATE_KEY, hasColumns, tableExists } from './db.js';

/**
 * October, which the app used to stop before.
 *
 * "Wild Card games are over, Division Series are about to start today. On
 * Dashboard page 'Up Next' table is empty, League's Daily Recap doesn't
 * generate anything new after last game day of the regular season, there is no
 * mention of Wild Card games anywhere, The Paper hasn't generated any new
 * content past regular season end."
 *
 * Four symptoms, one cause: every screen that asks the schedule a question
 * filtered on `game_type = 0`. That filter is correct and load-bearing where
 * it started — a club's remaining games, its season stat lines — because it is
 * what keeps the exhibition slate out. Copied into "what is on tonight" and
 * "what happened yesterday", it quietly ends the app's year in early October.
 *
 * The postseason is not identified by a game type here, because this save has
 * no postseason games in it to identify one from, and a number guessed at
 * would be a number wrong in somebody else's save. It is identified by when it
 * happens: a league's regular season has a last day, and a competitive game
 * after that day is a playoff game. Spring training sits before the season and
 * the All-Star game inside it, so both stay out without being named.
 *
 * What the rounds ARE comes from the export rather than from arithmetic:
 * `league_playoffs` carries the round names — "Wildcard Series", "Division
 * Series", "League Championship Series", "World Series" — with the best-of
 * for each, and `league_playoff_fixtures` carries the bracket itself.
 */

/** The last day of a league's regular season, as a sortable number. */
export function regularSeasonEnd(leagueId: number): number | null {
  if (!tableExists('games') || !hasColumns('games', 'game_type', 'date', 'league_id')) return null;
  const row = db
    .prepare(
      `SELECT MAX(${DATE_KEY('date')}) AS last FROM games
       WHERE league_id = ? AND game_type = 0`
    )
    .get(leagueId) as { last: number | null } | undefined;
  return row?.last ?? null;
}

/**
 * A game that counts: the regular season, or anything played after it.
 *
 * Returned as SQL because the callers are queries. Where the last day cannot
 * be worked out the fragment falls back to the regular season alone, which is
 * the behaviour every one of these screens had before.
 */
export function competitiveGamesSql(alias: string, leagueId: number): string {
  const end = regularSeasonEnd(leagueId);
  if (end === null) return `${alias}.game_type = 0`;
  return `(${alias}.game_type = 0 OR ${DATE_KEY(`${alias}.date`)} > ${end})`;
}

export interface Series {
  round: number;
  home: { team_id: number; name: string; wins: number };
  away: { team_id: number; name: string; wins: number };
  bestOf: number;
  /** Games played in the series so far. */
  played: number;
  finished: boolean;
  /** The club that won it, once one has. */
  winner: number | null;
  /** "Boston lead 2-1", "New York won 3-1" — the line a page prints. */
  summary: string;
}

export interface PostseasonRound {
  round: number;
  name: string;
  bestOf: number | null;
  series: Series[];
}

export interface Postseason {
  /** True while a round is still being played. */
  active: boolean;
  /** The round now being played, or the last one played. */
  currentRound: string | null;
  rounds: PostseasonRound[];
  /** The club that won the whole thing, once one has. */
  champion: { team_id: number; name: string } | null;
}

const teamLabel =
  `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

function names(ids: number[]): Map<number, string> {
  const found = new Map<number, string>();
  if (ids.length === 0) return found;
  for (const r of db
    .prepare(
      `SELECT t.team_id, ${teamLabel} AS label FROM teams t
       WHERE t.team_id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{ team_id: number; label: string }>) {
    found.set(r.team_id, r.label);
  }
  return found;
}

interface Fixture {
  team_id0: number; team_id1: number; winner: number | null; finished: number | null;
  best_of: number | null; played: number | null; round: number; result0: number | null;
  result1: number | null;
}

export function postseason(leagueId: number): Postseason | null {
  if (!tableExists('league_playoff_fixtures') || !tableExists('league_playoffs')) return null;
  if (!hasColumns('league_playoff_fixtures', 'league_id', 'team_id0', 'team_id1', 'round')) {
    return null;
  }

  const fixtures = db
    .prepare(
      `SELECT team_id0, team_id1, winner, finished, best_of, played, round, result0, result1
       FROM league_playoff_fixtures WHERE league_id = ? ORDER BY round`
    )
    .all(leagueId) as Fixture[];
  // Empty until a save reaches October, which is most of the year
  if (fixtures.length === 0) return null;

  const config = db
    .prepare(`SELECT * FROM league_playoffs WHERE league_id = ?`)
    .get(leagueId) as Record<string, unknown> | undefined;

  /*
   * Whether OOTP numbers the first round 0 or 1 is not something to assume, so
   * it is read off the bracket: the earliest round present is the first one,
   * whatever it is called. Names then line up from there.
   */
  const offset = Math.min(...fixtures.map((f) => f.round));
  const nameOf = (round: number): string => {
    const name = config?.[`round_names${round - offset}`];
    return typeof name === 'string' && name.trim().length > 0
      ? name.trim()
      : `Round ${round - offset + 1}`;
  };
  const bestOfConfigured = (round: number): number | null => {
    const value = Number(config?.[`best_of${round - offset}`] ?? 0);
    return value > 0 ? value : null;
  };

  const label = names(fixtures.flatMap((f) => [f.team_id0, f.team_id1]).filter((id) => id > 0));
  const rounds = new Map<number, PostseasonRound>();

  for (const f of fixtures) {
    // A bracket can carry a placeholder for a round nobody has reached yet
    if (!(f.team_id0 > 0) || !(f.team_id1 > 0)) continue;
    const wins0 = Number(f.result0 ?? 0);
    const wins1 = Number(f.result1 ?? 0);
    const home = { team_id: f.team_id0, name: label.get(f.team_id0) ?? 'Unknown', wins: wins0 };
    const away = { team_id: f.team_id1, name: label.get(f.team_id1) ?? 'Unknown', wins: wins1 };
    const finished = f.finished === 1 || (f.winner ?? 0) > 0;
    const leader = wins0 === wins1 ? null : wins0 > wins1 ? home : away;
    const trailer = leader === null ? null : leader === home ? away : home;

    const summary = finished && leader
      ? `${leader.name} won ${leader.wins}-${trailer!.wins}`
      : leader
        ? `${leader.name} lead ${leader.wins}-${trailer!.wins}`
        // Not the matchup again: the line above it already says who is playing
        : wins0 + wins1 === 0
          ? 'Yet to begin'
          : `Level at ${wins0}-${wins1}`;

    if (!rounds.has(f.round)) {
      rounds.set(f.round, {
        round: f.round,
        name: nameOf(f.round),
        bestOf: Number(f.best_of ?? 0) > 0 ? Number(f.best_of) : bestOfConfigured(f.round),
        series: [],
      });
    }
    rounds.get(f.round)!.series.push({
      round: f.round,
      home, away,
      bestOf: Number(f.best_of ?? 0) > 0 ? Number(f.best_of) : (bestOfConfigured(f.round) ?? 0),
      played: Number(f.played ?? wins0 + wins1),
      finished,
      winner: (f.winner ?? 0) > 0 ? Number(f.winner) : null,
      summary,
    });
  }

  const ordered = [...rounds.values()].sort((a, b) => a.round - b.round);
  if (ordered.length === 0) return null;

  const live = ordered.filter((r) => r.series.some((s) => !s.finished));
  const last = ordered[ordered.length - 1];
  const finalRound = last.series.length === 1 && last.series.every((s) => s.finished)
    ? last.series[0]
    : null;

  return {
    active: live.length > 0,
    currentRound: (live[0] ?? last).name,
    rounds: ordered,
    champion:
      finalRound && finalRound.winner
        ? {
            team_id: finalRound.winner,
            name: finalRound.winner === finalRound.home.team_id
              ? finalRound.home.name
              : finalRound.away.name,
          }
        : null,
  };
}
