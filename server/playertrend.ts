import { Router } from 'express';
import { db, hasColumns, tableExists } from './db.js';
import { DATE_KEY } from './dashboard.js';
import { padDate } from './rosterops.js';
import { seasonYear } from './valuation.js';

export const playerTrendRoutes = Router();

/**
 * A season as it happened, rather than as it finished.
 *
 * "How does a player's AVG, OPS, ERA, etc., change throughout the year, or
 * even compare year over year?"
 *
 * A season line is a single number standing for six months, and it hides
 * everything worth knowing: a .270 hitter who was at .190 in May and .330
 * since is not the same man as one who has been .270 all along, and the
 * ordinary stat page cannot tell them apart. OOTP exports a row per player per
 * game — eighty thousand of them in my own save — and nothing here was reading
 * them for anything but the last fortnight.
 *
 * Two readings, because they answer different questions and each is misleading
 * on its own:
 *
 *  - Season to date is the number on his card that night, and it converges. By
 *    August it barely moves, which is honest: one game in a hundred and forty
 *    genuinely does not move a season.
 *  - The rolling window is form. It never settles, which is the point, but a
 *    fortnight of baseball is a small sample and it will swing on nothing.
 *
 * Both are computed and the page names which it is showing. Neither is a
 * projection and nothing here is smoothed.
 */

/** Games in a rolling window. Ten is noise; thirty is most of a season's shape. */
const WINDOW = 15;

export interface TrendPoint {
  game: number;
  date: string | null;
  /** Season to date, as his card read that night. */
  toDate: number | null;
  /** The same measure over the last {@link WINDOW} games he appeared in. */
  rolling: number | null;
}

interface Line {
  ab: number; h: number; d: number; t: number; hr: number;
  bb: number; hp: number; sf: number; pa: number;
}

interface ArmLine {
  outs: number; er: number; ha: number; bb: number; k: number;
}

const rate = (v: number, places: number): number | null =>
  Number.isFinite(v) ? Number(v.toFixed(places)) : null;

/** Batting rates from a run of games, however long that run is. */
function battingRates(rows: Line[]) {
  const sum = rows.reduce(
    (a, r) => ({
      ab: a.ab + r.ab, h: a.h + r.h, d: a.d + r.d, t: a.t + r.t, hr: a.hr + r.hr,
      bb: a.bb + r.bb, hp: a.hp + r.hp, sf: a.sf + r.sf, pa: a.pa + r.pa,
    }),
    { ab: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, hp: 0, sf: 0, pa: 0 }
  );
  const singles = sum.h - sum.d - sum.t - sum.hr;
  const obpDen = sum.ab + sum.bb + sum.hp + sum.sf;
  const avg = sum.ab > 0 ? sum.h / sum.ab : null;
  const obp = obpDen > 0 ? (sum.h + sum.bb + sum.hp) / obpDen : null;
  const slg = sum.ab > 0 ? (singles + 2 * sum.d + 3 * sum.t + 4 * sum.hr) / sum.ab : null;
  return {
    avg: avg === null ? null : rate(avg, 3),
    obp: obp === null ? null : rate(obp, 3),
    slg: slg === null ? null : rate(slg, 3),
    ops: obp === null || slg === null ? null : rate(obp + slg, 3),
  };
}

/** Pitching rates from a run of outings. */
function pitchingRates(rows: ArmLine[]) {
  const sum = rows.reduce(
    (a, r) => ({
      outs: a.outs + r.outs, er: a.er + r.er, ha: a.ha + r.ha, bb: a.bb + r.bb, k: a.k + r.k,
    }),
    { outs: 0, er: 0, ha: 0, bb: 0, k: 0 }
  );
  const ip = sum.outs / 3;
  return {
    era: ip > 0 ? rate((sum.er * 9) / ip, 2) : null,
    whip: ip > 0 ? rate((sum.ha + sum.bb) / ip, 2) : null,
    k9: ip > 0 ? rate((sum.k * 9) / ip, 1) : null,
  };
}

/**
 * Every appearance this season, oldest first.
 *
 * Only the level he has played most at, because a curve that runs through a
 * call-up is two different seasons drawn as one line — a man hitting .320 in
 * Double-A and .190 in the majors has a graph that says .250 and means nothing.
 */
function appearances(playerId: number, year: number, table: string, columns: string[]) {
  if (!tableExists(table) || !hasColumns(table, 'player_id', 'year', 'game_id', 'level_id')) {
    return { rows: [] as Array<Record<string, number | string | null>>, level: null as number | null };
  }
  const level = (
    db
      .prepare(
        `SELECT level_id, COUNT(*) AS n FROM "${table}"
         WHERE player_id = ? AND year = ?
         GROUP BY level_id ORDER BY n DESC LIMIT 1`
      )
      .get(playerId, year) as { level_id: number } | undefined
  )?.level_id;
  if (level === undefined) return { rows: [], level: null };

  const rows = db
    .prepare(
      `SELECT ${columns.map((c) => `s.${c}`).join(', ')}, g.date
       FROM "${table}" s
       JOIN games g ON g.game_id = s.game_id
       WHERE s.player_id = ? AND s.year = ? AND s.level_id = ?
         -- No split filter: a game log has one split and OOTP numbers it zero,
         -- where the career tables call the overall split one. Asking for one
         -- here returned an empty season.
         AND g.game_type = 0
       ORDER BY ${DATE_KEY('g.date')}, s.game_id`
    )
    .all(playerId, year, level) as Array<Record<string, number | string | null>>;
  return { rows, level };
}

/** Walk the season once, reporting both readings at every game. */
function walk<T>(
  rows: T[],
  dates: Array<string | null>,
  measure: (run: T[]) => Record<string, number | null>
): Record<string, TrendPoint[]> {
  const out: Record<string, TrendPoint[]> = {};
  rows.forEach((_, i) => {
    const toDate = measure(rows.slice(0, i + 1));
    const rolling = measure(rows.slice(Math.max(0, i + 1 - WINDOW), i + 1));
    for (const key of Object.keys(toDate)) {
      (out[key] ??= []).push({
        game: i + 1,
        date: dates[i],
        toDate: toDate[key],
        rolling: rolling[key],
      });
    }
  });
  return out;
}

playerTrendRoutes.get('/player-trend/:playerId', (req, res) => {
  const playerId = Number(req.params.playerId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const who = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.position, t.league_id
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.player_id = ?`
    )
    .get(playerId) as { name: string; position: number; league_id: number | null } | undefined;
  if (!who) return res.status(404).json({ error: 'Unknown player' });

  const year = who.league_id ? seasonYear(who.league_id) : new Date().getFullYear();

  const bat = appearances(playerId, year, 'players_game_batting',
    ['ab', 'h', 'd', 't', 'hr', 'bb', 'hp', 'sf', 'pa', 'game_id']);
  const arm = appearances(playerId, year, 'players_game_pitching_stats',
    ['outs', 'er', 'ha', 'bb', 'k', 'game_id']);

  const n = (r: Record<string, number | string | null>, k: string): number => Number(r[k] ?? 0);

  const batting = bat.rows.length > 0
    ? walk(
        bat.rows.map((r) => ({
          ab: n(r, 'ab'), h: n(r, 'h'), d: n(r, 'd'), t: n(r, 't'), hr: n(r, 'hr'),
          bb: n(r, 'bb'), hp: n(r, 'hp'), sf: n(r, 'sf'), pa: n(r, 'pa'),
        })),
        bat.rows.map((r) => padDate(r.date)),
        battingRates
      )
    : {};

  const pitching = arm.rows.length > 0
    ? walk(
        arm.rows.map((r) => ({
          outs: n(r, 'outs'), er: n(r, 'er'), ha: n(r, 'ha'), bb: n(r, 'bb'), k: n(r, 'k'),
        })),
        arm.rows.map((r) => padDate(r.date)),
        pitchingRates
      )
    : {};

  /*
   * Season by season, from the career table rather than by summing the game
   * logs — the logs only cover the seasons this save has actually played,
   * while the career table carries a man's whole record including the years
   * before the save began.
   */
  const seasons = tableExists('players_career_batting_stats')
    ? (db
        .prepare(
          `SELECT year, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t, SUM(hr) AS hr,
                  SUM(bb) AS bb, SUM(hp) AS hp, SUM(sf) AS sf, SUM(pa) AS pa
           FROM players_career_batting_stats
           WHERE player_id = ? AND split_id = 1 AND level_id = 1
           GROUP BY year HAVING SUM(pa) > 0 ORDER BY year`
        )
        .all(playerId) as Array<Record<string, number>>)
        .map((r) => ({
          year: r.year,
          ...battingRates([{
            ab: r.ab, h: r.h, d: r.d, t: r.t, hr: r.hr,
            bb: r.bb, hp: r.hp, sf: r.sf, pa: r.pa,
          }]),
        }))
    : [];

  const armSeasons = tableExists('players_career_pitching_stats')
    ? (db
        .prepare(
          `SELECT year, SUM(outs) AS outs, SUM(er) AS er, SUM(ha) AS ha, SUM(bb) AS bb, SUM(k) AS k
           FROM players_career_pitching_stats
           WHERE player_id = ? AND split_id = 1 AND level_id = 1
           GROUP BY year HAVING SUM(outs) > 0 ORDER BY year`
        )
        .all(playerId) as Array<Record<string, number>>)
        .map((r) => ({
          year: r.year,
          ...pitchingRates([{ outs: r.outs, er: r.er, ha: r.ha, bb: r.bb, k: r.k }]),
        }))
    : [];

  res.json({
    player_id: playerId,
    name: who.name,
    year,
    window: WINDOW,
    /** The level the curve is drawn from, so a call-up cannot become one line. */
    level: bat.rows.length > 0 ? bat.level : arm.level,
    batting,
    pitching,
    seasons,
    armSeasons,
  });
});
