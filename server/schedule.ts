import { Router } from 'express';
import { db, tableExists } from './db.js';
import { DATE_KEY } from './dashboard.js';

export const scheduleRoutes = Router();

const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
const teamLabel = (alias: string) =>
  `CASE WHEN ${alias}.name = ${alias}.nickname THEN ${alias}.name
        ELSE ${alias}.name || ' ' || ${alias}.nickname END`;

/**
 * Games are grouped into series the way a schedule is actually read: consecutive
 * games against the same opponent at the same venue. OOTP does not store a
 * series id, so it is derived from the ordered game list.
 */
interface GameRow {
  game_id: number;
  date: string;
  dateKey: number;
  time: number;
  home_team: number;
  away_team: number;
  home_label: string;
  away_label: string;
  played: number;
  runs0: number | null; // away
  runs1: number | null; // home
  innings: number | null;
  starter0: number | null; // away starter
  starter1: number | null; // home starter
}

function pitcher(id: number | null) {
  if (!id) return null;
  const p = db
    .prepare(`SELECT player_id, first_name || ' ' || last_name AS name, throws FROM players WHERE player_id = ?`)
    .get(id) as { player_id: number; name: string; throws: number } | undefined;
  return p ? { player_id: p.player_id, name: p.name, throws: HAND[p.throws] ?? '?' } : null;
}

function projectedStarter(teamId: number, index: number) {
  if (!tableExists('projected_starting_pitchers')) return null;
  const row = db.prepare(`SELECT * FROM projected_starting_pitchers WHERE team_id = ?`).get(teamId) as
    | Record<string, number>
    | undefined;
  return row ? pitcher(row[`starter_${Math.min(index, 7)}`] ?? null) : null;
}

scheduleRoutes.get('/schedule/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('games')) return res.status(400).json({ error: 'No data imported yet' });

  const rows = db
    .prepare(
      `SELECT g.game_id, g.date, ${DATE_KEY('g.date')} AS dateKey, g.time,
              g.home_team, g.away_team, g.played, g.runs0, g.runs1, g.innings,
              g.starter0, g.starter1,
              ${teamLabel('ht')} AS home_label, ${teamLabel('at2')} AS away_label
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team
       JOIN teams at2 ON at2.team_id = g.away_team
       WHERE (g.home_team = ? OR g.away_team = ?) AND g.game_type = 0
       ORDER BY ${DATE_KEY('g.date')}, g.time`
    )
    .all(teamId, teamId) as GameRow[];

  if (rows.length === 0) return res.json({ series: [], record: null });

  // Opponent records, so a series can be judged before it starts
  const records = new Map<number, { w: number; l: number; pct: number }>();
  if (tableExists('team_record')) {
    for (const r of db.prepare(`SELECT team_id, w, l, pct FROM team_record`).all() as Array<{
      team_id: number; w: number; l: number; pct: number;
    }>) {
      records.set(r.team_id, { w: r.w, l: r.l, pct: r.pct });
    }
  }

  const games = rows.map((g) => {
    const isHome = g.home_team === teamId;
    const oppId = isHome ? g.away_team : g.home_team;
    // runs0 is the away score and runs1 the home score — verified against
    // team_record: recomputing W-L from these matches the official standings.
    const us = g.played ? (isHome ? g.runs1 : g.runs0) : null;
    const them = g.played ? (isHome ? g.runs0 : g.runs1) : null;
    return {
      game_id: g.game_id,
      date: g.date,
      dateKey: g.dateKey,
      isHome,
      oppId,
      opponent: isHome ? g.away_label : g.home_label,
      opponentRecord: records.get(oppId) ?? null,
      played: g.played === 1,
      us,
      them,
      won: us !== null && them !== null ? us > them : null,
      extraInnings: (g.innings ?? 9) > 9,
      ourStarter: g.played ? pitcher(isHome ? g.starter1 : g.starter0) : null,
      theirStarter: g.played ? pitcher(isHome ? g.starter0 : g.starter1) : null,
    };
  });

  // Group consecutive same-opponent, same-venue games into series
  type Game = (typeof games)[number];
  const series: Array<{
    opponent: string;
    oppId: number;
    isHome: boolean;
    opponentRecord: { w: number; l: number; pct: number } | null;
    startDate: string;
    endDate: string;
    games: Game[];
    played: boolean;
    inProgress: boolean;
    wins: number;
    losses: number;
  }> = [];

  for (const g of games) {
    const last = series[series.length - 1];
    if (last && last.oppId === g.oppId && last.isHome === g.isHome) {
      last.games.push(g);
    } else {
      series.push({
        opponent: g.opponent,
        oppId: g.oppId,
        isHome: g.isHome,
        opponentRecord: g.opponentRecord,
        startDate: g.date,
        endDate: g.date,
        games: [g],
        played: false,
        inProgress: false,
        wins: 0,
        losses: 0,
      });
    }
  }

  for (const s of series) {
    s.endDate = s.games[s.games.length - 1].date;
    s.wins = s.games.filter((g) => g.won === true).length;
    s.losses = s.games.filter((g) => g.won === false).length;
    const playedCount = s.games.filter((g) => g.played).length;
    s.played = playedCount === s.games.length;
    s.inProgress = playedCount > 0 && playedCount < s.games.length;

    // Probable starters for games still to come, taken from the projected
    // rotation and advanced one slot per remaining game
    let ours = 0;
    let theirs = 0;
    for (const g of s.games) {
      if (g.played) continue;
      g.ourStarter = projectedStarter(teamId, ours++);
      g.theirStarter = projectedStarter(g.oppId, theirs++);
    }
  }

  const wins = games.filter((g) => g.won === true).length;
  const losses = games.filter((g) => g.won === false).length;
  const home = games.filter((g) => g.played && g.isHome);
  const away = games.filter((g) => g.played && !g.isHome);
  const nextIndex = series.findIndex((s) => !s.played);

  /**
   * Record against each opponent, and the line score of every game played.
   *
   * A season record says how the club is doing; a head-to-head record says who
   * it is doing it against, which is the thing a manager actually asks before a
   * series. games_score carries the runs scored in each inning and had never
   * been read.
   */
  const headToHead = [...
    games
      .filter((g) => g.played)
      .reduce((acc, g) => {
        const cur = acc.get(g.oppId) ?? { opponentId: g.oppId, opponent: g.opponent, w: 0, l: 0, rf: 0, ra: 0 };
        if (g.won === true) cur.w += 1;
        else if (g.won === false) cur.l += 1;
        cur.rf += g.us ?? 0;
        cur.ra += g.them ?? 0;
        acc.set(g.oppId, cur);
        return acc;
      }, new Map<number, { opponentId: number; opponent: string; w: number; l: number; rf: number; ra: number }>())
      .values(),
  ].sort((a, b) => b.w + b.l - (a.w + a.l) || b.w - a.w);

  // Only the games already played, and only the recent ones — a full season of
  // line scores is a lot of payload for a page that shows a window
  const lineScores: Record<number, { away: number[]; home: number[] }> = {};
  if (tableExists('games_score')) {
    const recent = games.filter((g) => g.played).slice(-24).map((g) => g.game_id);
    if (recent.length > 0) {
      const holes = recent.map(() => '?').join(',');
      for (const r of db
        .prepare(
          `SELECT game_id, team, inning, score FROM games_score
           WHERE game_id IN (${holes}) ORDER BY inning`
        )
        .all(...recent) as Array<{ game_id: number; team: number; inning: number; score: number }>) {
        const entry = (lineScores[r.game_id] ??= { away: [], home: [] });
        (r.team === 0 ? entry.away : entry.home).push(r.score ?? 0);
      }
    }
  }

  res.json({
    headToHead,
    lineScores,
    record: {
      w: wins,
      l: losses,
      home: `${home.filter((g) => g.won).length}-${home.filter((g) => g.won === false).length}`,
      away: `${away.filter((g) => g.won).length}-${away.filter((g) => g.won === false).length}`,
      runsFor: games.reduce((sum, g) => sum + (g.us ?? 0), 0),
      runsAgainst: games.reduce((sum, g) => sum + (g.them ?? 0), 0),
    },
    nextSeriesIndex: nextIndex,
    series,
  });
});
