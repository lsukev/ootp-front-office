import { Router } from 'express';
import { db, tableExists } from './db.js';
import { computePitching, leagueBaseline } from './stats.js';
import { DATE_KEY } from './dashboard.js';

export const pitchingRoutes = Router();

/** OOTP roles for pitchers. */
const ROLE_STARTER = 11;
const ROLE_CLOSER = 13;

const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };

/**
 * Rest and workload are the whole point of this page, so they are computed from
 * per-game appearances rather than season totals: a reliever with a tidy season
 * ERA can still be unusable tonight because he threw 38 pitches yesterday.
 */
interface Appearance {
  player_id: number;
  dateKey: number;
  date: string;
  pitches: number;
  outs: number;
  started: boolean;
}

const dayFromKey = (key: number): Date =>
  new Date(Math.floor(key / 10000), (Math.floor(key / 100) % 100) - 1, key % 100);

const daysBetween = (a: number, b: number): number =>
  Math.round((dayFromKey(a).getTime() - dayFromKey(b).getTime()) / 86_400_000);

function currentDateKey(leagueId: number): number | null {
  const row = db
    .prepare(
      `SELECT MAX(${DATE_KEY('date')}) AS k FROM games WHERE league_id = ? AND played = 1`
    )
    .get(leagueId) as { k: number | null } | undefined;
  return row?.k ?? null;
}

/**
 * Fatigue is expressed the way a manager thinks about it — pitches in the last
 * three days and appearances in the last five — rather than as a single opaque
 * score. Thresholds follow common bullpen practice: back-to-back days are fine,
 * three in a row or 45+ pitches in three days is a red flag.
 */
function bullpenStatus(recent: Appearance[], todayKey: number): { label: string; tone: 'ok' | 'warn' | 'bad' } {
  const on = (d: number) => recent.find((a) => daysBetween(todayKey, a.dateKey) === d);
  const pitches3 = recent
    .filter((a) => daysBetween(todayKey, a.dateKey) <= 2)
    .reduce((sum, a) => sum + a.pitches, 0);

  const today = on(0);
  const yesterday = on(1);

  // Everything is phrased as availability for the NEXT game, which is the only
  // question a manager is actually asking on this screen.
  if (today && yesterday) return { label: 'Two straight — sit him', tone: 'bad' };
  if (pitches3 >= 50) return { label: `${pitches3} pitches in 3 days`, tone: 'bad' };
  if (today && today.pitches >= 30) return { label: `${today.pitches} pitches today`, tone: 'bad' };
  if (today) return { label: `Would be back-to-back (${today.pitches} today)`, tone: 'warn' };
  if (yesterday && yesterday.pitches >= 30) {
    return { label: `${yesterday.pitches} pitches yesterday`, tone: 'warn' };
  }
  if (pitches3 >= 40) return { label: `${pitches3} pitches in 3 days`, tone: 'warn' };
  if (yesterday) return { label: `Available (${yesterday.pitches} yesterday)`, tone: 'ok' };
  const last = recent[0];
  if (!last) return { label: 'No appearances yet', tone: 'ok' };
  return { label: `Rested ${daysBetween(todayKey, last.dateKey)}d`, tone: 'ok' };
}

pitchingRoutes.get('/pitching/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const team = db.prepare(`SELECT league_id, level FROM teams WHERE team_id = ?`).get(teamId) as
    | { league_id: number; level: number }
    | undefined;
  if (!team) return res.status(404).json({ error: 'Unknown team' });

  const todayKey = currentDateKey(team.league_id);

  const roster = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.role, p.throws,
              pi.pitching_ratings_misc_stamina AS stamina,
              pi.pitching_ratings_overall_stuff AS stuff,
              pi.pitching_ratings_overall_control AS control,
              pi.pitching_ratings_overall_movement AS movement,
              pi.pitching_ratings_misc_velocity AS velocity,
              p.injury_is_injured, p.injury_dtd_injury, p.injury_left,
              rs.is_on_dl, rs.is_on_dl60
       FROM players p
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.team_id = ? AND p.position = 1 AND p.retired = 0`
    )
    .all(teamId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; role: number;
    throws: number; stamina: number | null; stuff: number | null; control: number | null;
    movement: number | null; velocity: number | null;
    injury_is_injured: number | null; injury_dtd_injury: number | null; injury_left: number | null;
    is_on_dl: number | null; is_on_dl60: number | null;
  }>;
  if (roster.length === 0) return res.json({ rotation: [], bullpen: [], today: null });

  const ids = roster.map((r) => r.player_id);
  const holes = ids.map(() => '?').join(',');

  // Season stats
  const statYear = (db.prepare(`SELECT MAX(year) AS y FROM players_career_pitching_stats`).get() as
    | { y: number | null }
    | undefined)?.y ?? null;
  const statsById = new Map<number, Record<string, number | null>>();
  if (statYear !== null) {
    const base = leagueBaseline(team.league_id, statYear, team.level);
    const rows = db
      .prepare(
        `SELECT player_id, SUM(outs) AS outs, SUM(er) AS er, SUM(ha) AS ha, SUM(bb) AS bb,
                SUM(k) AS k, SUM(hra) AS hra, SUM(bf) AS bf, SUM(g) AS g, SUM(gs) AS gs,
                SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv, SUM(hld) AS hld, SUM(war) AS war
         FROM players_career_pitching_stats
         WHERE year = ? AND split_id = 1 AND player_id IN (${holes})
         GROUP BY player_id`
      )
      .all(statYear, ...ids) as Array<Record<string, number>>;
    for (const row of rows) statsById.set(row.player_id, computePitching(row, base, teamId));
  }

  // Per-game appearances, for rest and recent workload
  const appearances = new Map<number, Appearance[]>();
  if (tableExists('players_game_pitching_stats')) {
    const rows = db
      .prepare(
        `SELECT s.player_id, g.date AS date, ${DATE_KEY('g.date')} AS dateKey,
                s.pi AS pitches, s.outs AS outs, s.gs AS gs
         FROM players_game_pitching_stats s
         JOIN games g ON g.game_id = s.game_id
         WHERE s.player_id IN (${holes}) AND g.played = 1
         ORDER BY dateKey DESC`
      )
      .all(...ids) as Array<{
      player_id: number; date: string; dateKey: number; pitches: number; outs: number; gs: number;
    }>;
    for (const r of rows) {
      const list = appearances.get(r.player_id) ?? [];
      list.push({
        player_id: r.player_id,
        dateKey: r.dateKey,
        date: r.date,
        pitches: r.pitches ?? 0,
        outs: r.outs ?? 0,
        started: (r.gs ?? 0) > 0,
      });
      appearances.set(r.player_id, list);
    }
  }

  // OOTP's own projected rotation, so the page agrees with the game's own plan
  const projected = db.prepare(`SELECT * FROM projected_starting_pitchers WHERE team_id = ?`).get(teamId) as
    | Record<string, number>
    | undefined;
  const projectedOrder: number[] = [];
  if (projected) {
    for (let i = 0; i < 5; i++) {
      const id = projected[`starter_${i}`];
      if (id && !projectedOrder.includes(id)) projectedOrder.push(id);
    }
  }

  const injuryOf = (p: (typeof roster)[number]): { status: string; daysLeft: number | null } | null => {
    if (p.is_on_dl60 === 1) return { status: 'IL-60', daysLeft: p.injury_left ?? null };
    if (p.is_on_dl === 1) return { status: 'IL', daysLeft: p.injury_left ?? null };
    if (p.injury_dtd_injury === 1) return { status: 'Day-to-day', daysLeft: p.injury_left ?? null };
    if (p.injury_is_injured === 1) return { status: 'Injured', daysLeft: p.injury_left ?? null };
    return null;
  };

  const describe = (p: (typeof roster)[number]) => {
    const apps = appearances.get(p.player_id) ?? [];
    const last = apps[0] ?? null;
    const stats = statsById.get(p.player_id) ?? null;
    return {
      injury: injuryOf(p),
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      throws: HAND[p.throws] ?? '?',
      role: p.role,
      stamina: p.stamina,
      stuff: p.stuff,
      control: p.control,
      movement: p.movement,
      velocity: p.velocity,
      lastOuting: last ? { date: last.date, pitches: last.pitches, outs: last.outs } : null,
      daysRest: last && todayKey !== null ? daysBetween(todayKey, last.dateKey) : null,
      stats,
    };
  };

  const starters = roster.filter((p) => p.role === ROLE_STARTER);
  const relievers = roster.filter((p) => p.role !== ROLE_STARTER);

  // Rotation order: OOTP's projection first, then anyone else who starts
  const byId = new Map(starters.map((p) => [p.player_id, p]));
  const ordered = [
    ...projectedOrder.map((id) => byId.get(id)).filter((p): p is (typeof roster)[number] => !!p),
    ...starters.filter((p) => !projectedOrder.includes(p.player_id)),
  ];

  const rotation = ordered.map((p) => {
    const d = describe(p);
    const projectedSlot = projectedOrder.indexOf(p.player_id);
    return {
      ...d,
      // Only OOTP's projected five get a rotation slot. Everyone else is depth:
      // long men, spot starters, and arms currently on the IL.
      slot: projectedSlot >= 0 ? projectedSlot + 1 : null,
      projected: projectedSlot >= 0,
      // A five-man rotation turns over every five days
      nextStartInDays: projectedSlot >= 0 && d.daysRest !== null
        ? Math.max(0, 5 - d.daysRest)
        : null,
    };
  });
  const starterDepth = rotation.filter((r) => !r.projected);
  const activeRotation = rotation.filter((r) => r.projected);

  const bullpen = relievers
    .map((p) => {
      const d = describe(p);
      const apps = appearances.get(p.player_id) ?? [];
      const status = todayKey !== null ? bullpenStatus(apps, todayKey) : { label: '—', tone: 'ok' as const };
      // Same window bullpenStatus uses: today, yesterday, the day before
      const last3 = todayKey !== null
        ? apps.filter((a) => daysBetween(todayKey, a.dateKey) <= 2)
        : [];
      return {
        ...d,
        isCloser: p.role === ROLE_CLOSER,
        status: status.label,
        tone: status.tone,
        pitchesLast3: last3.reduce((sum, a) => sum + a.pitches, 0),
        appearancesLast3: last3.length,
      };
    })
    // Closer first, then by ERA+ descending — the order a manager reaches for them
    .sort((a, b) => {
      if (a.isCloser !== b.isCloser) return a.isCloser ? -1 : 1;
      return (b.stats?.eraPlus ?? 0) - (a.stats?.eraPlus ?? 0);
    });

  res.json({
    today: todayKey,
    rotation: activeRotation,
    starterDepth,
    bullpen,
    tired: bullpen.filter((b) => b.tone !== 'ok').length,
    injured: [...activeRotation, ...starterDepth, ...bullpen].filter((p) => p.injury !== null).length,
  });
});
