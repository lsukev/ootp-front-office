import { Router } from 'express';
import { db, tableExists } from './db.js';
import { DATE_KEY } from './dashboard.js';

export const trendsRoutes = Router();

/** Games in the rolling window used for the smoothed lines. */
const WINDOW = 10;

const rolling = (values: number[], window: number): Array<number | null> =>
  values.map((_, i) => {
    if (i + 1 < window) return null;
    const slice = values.slice(i + 1 - window, i + 1);
    return slice.reduce((a, b) => a + b, 0) / window;
  });

trendsRoutes.get('/trends/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('games')) return res.status(400).json({ error: 'No data imported yet' });

  const games = db
    .prepare(
      `SELECT g.game_id, g.date, g.home_team, g.away_team, g.runs0, g.runs1
       FROM games g
       WHERE g.played = 1 AND (g.home_team = ? OR g.away_team = ?) AND g.game_type = 0
       ORDER BY ${DATE_KEY('g.date')}, g.time`
    )
    .all(teamId, teamId) as Array<{
    game_id: number; date: string; home_team: number; away_team: number; runs0: number; runs1: number;
  }>;

  if (games.length === 0) return res.json({ games: 0, labels: [], series: {} });

  // runs0 is the away score, runs1 the home score — verified against team_record
  const scored: number[] = [];
  const allowed: number[] = [];
  const labels: string[] = [];
  const cumulativeDiff: number[] = [];
  const winPct: Array<number | null> = [];

  let diff = 0;
  let wins = 0;

  games.forEach((g, i) => {
    const isHome = g.home_team === teamId;
    const us = isHome ? g.runs1 : g.runs0;
    const them = isHome ? g.runs0 : g.runs1;
    scored.push(us);
    allowed.push(them);
    diff += us - them;
    cumulativeDiff.push(diff);
    if (us > them) wins++;
    winPct.push((wins / (i + 1)) * 100);
    // OOTP writes dates unpadded; keep them short for the axis
    const [, m, d] = g.date.split('-');
    labels.push(`${m}/${d}`);
  });

  res.json({
    games: games.length,
    window: WINDOW,
    labels,
    series: {
      cumulativeDiff,
      runsScoredRolling: rolling(scored, WINDOW),
      runsAllowedRolling: rolling(allowed, WINDOW),
      winPct,
    },
    totals: {
      scored: scored.reduce((a, b) => a + b, 0),
      allowed: allowed.reduce((a, b) => a + b, 0),
      perGameScored: scored.reduce((a, b) => a + b, 0) / games.length,
      perGameAllowed: allowed.reduce((a, b) => a + b, 0) / games.length,
    },
  });
});
