import { Router } from 'express';
import { db, tableExists } from './db.js';

/**
 * The club's whole history, which the export has carried all along.
 *
 * team_history_record holds a row per season back to the franchise's first —
 * 144 of them for the Yankees, starting in 1882 — and team_history says who the
 * best hitter and pitcher were and how the year ended. None of it was read.
 */

export const franchiseRoutes = Router();

interface SeasonRow {
  year: number;
  g: number; w: number; l: number; pct: number; pos: number; gb: number;
  name: string | null;
  made_playoffs: number | null;
  won_playoffs: number | null;
  best_hitter_id: number | null;
  best_pitcher_id: number | null;
  payroll: number | null;
  attendance: number | null;
}

franchiseRoutes.get('/franchise/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('team_history_record')) {
    return res.status(400).json({ error: 'This export has no franchise history' });
  }

  const hasHistory = tableExists('team_history');
  const hasFinancials = tableExists('team_history_financials');

  const rows = db
    .prepare(
      `SELECT r.year, r.g, r.w, r.l, r.pct, r.pos, r.gb
              ${hasHistory ? `, h.name, h.made_playoffs, h.won_playoffs, h.best_hitter_id, h.best_pitcher_id` : ''}
              ${hasFinancials ? `, f.player_expenses AS payroll, f.attendance` : ''}
       FROM team_history_record r
       ${hasHistory ? 'LEFT JOIN team_history h ON h.team_id = r.team_id AND h.year = r.year' : ''}
       ${hasFinancials ? 'LEFT JOIN team_history_financials f ON f.team_id = r.team_id AND f.year = r.year' : ''}
       WHERE r.team_id = ? AND r.g > 0
       ORDER BY r.year DESC`
    )
    .all(teamId) as SeasonRow[];

  if (rows.length === 0) return res.json({ seasons: [], summary: null });

  // One lookup for every player named as a season's best, rather than one per row
  const ids = [
    ...new Set(
      rows.flatMap((r) => [r.best_hitter_id, r.best_pitcher_id]).filter((v): v is number => !!v)
    ),
  ];
  const names = new Map<number, string>();
  if (ids.length > 0) {
    const holes = ids.map(() => '?').join(',');
    for (const p of db
      .prepare(`SELECT player_id, first_name || ' ' || last_name AS name FROM players WHERE player_id IN (${holes})`)
      .all(...ids) as Array<{ player_id: number; name: string }>) {
      names.set(p.player_id, p.name);
    }
  }

  const seasons = rows.map((r) => ({
    year: r.year,
    w: r.w,
    l: r.l,
    pct: r.pct,
    finish: r.pos,
    gb: r.gb,
    name: r.name ?? null,
    madePlayoffs: r.made_playoffs === 1,
    wonTitle: r.won_playoffs === 1,
    bestHitter: r.best_hitter_id ? { player_id: r.best_hitter_id, name: names.get(r.best_hitter_id) ?? null } : null,
    bestPitcher: r.best_pitcher_id ? { player_id: r.best_pitcher_id, name: names.get(r.best_pitcher_id) ?? null } : null,
    payroll: r.payroll ?? null,
    attendance: r.attendance ?? null,
  }));

  const wins = seasons.reduce((sum, s) => sum + s.w, 0);
  const losses = seasons.reduce((sum, s) => sum + s.l, 0);
  const best = [...seasons].sort((a, b) => b.pct - a.pct)[0];
  const worst = [...seasons].sort((a, b) => a.pct - b.pct)[0];

  res.json({
    seasons,
    summary: {
      seasons: seasons.length,
      firstYear: seasons[seasons.length - 1].year,
      lastYear: seasons[0].year,
      wins,
      losses,
      pct: wins + losses > 0 ? wins / (wins + losses) : 0,
      titles: seasons.filter((s) => s.wonTitle).length,
      playoffs: seasons.filter((s) => s.madePlayoffs).length,
      bestSeason: best ? { year: best.year, w: best.w, l: best.l } : null,
      worstSeason: worst ? { year: worst.year, w: worst.w, l: worst.l } : null,
    },
  });
});

/**
 * Every organization side by side.
 *
 * The rest of the app answers questions about one club. This answers the one
 * that needs the others in frame — whether the farm system is actually any
 * good, which is unanswerable without seeing the twenty-nine you are competing
 * with. Talent is OOTP's own scouted ceiling, summed over the men in the
 * system, so it reads as "how much future is in there" rather than a ranking of
 * today's results.
 */
franchiseRoutes.get('/org-comparison/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_value')) return res.status(400).json({ error: 'No data imported yet' });

  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown org' });

  const clubs = db
    .prepare(
      `SELECT team_id, CASE WHEN name = nickname THEN name ELSE name || ' ' || nickname END AS label
       FROM teams WHERE allstar_team = 0 AND league_id = ?`
    )
    .all(org.league_id) as Array<{ team_id: number; label: string }>;

  // One pass over the league rather than a query per club
  const rows = db
    .prepare(
      `SELECT p.player_id, p.organization_id AS org, t.level AS level,
              v.overall_value AS overall, v.talent_value AS talent, p.age AS age
       FROM players p
       JOIN teams t ON t.team_id = p.team_id
       JOIN players_value v ON v.player_id = p.player_id
       WHERE p.retired = 0 AND p.organization_id > 0`
    )
    .all() as Array<{
    player_id: number; org: number; level: number; overall: number; talent: number; age: number;
  }>;

  const acc = new Map<
    number,
    { mlb: number; farm: number; farmCount: number; topFarm: number; topId: number | null; young: number }
  >();
  for (const r of rows) {
    const cur = acc.get(r.org) ?? { mlb: 0, farm: 0, farmCount: 0, topFarm: 0, topId: null, young: 0 };
    if (r.level === 1) {
      cur.mlb += r.overall ?? 0;
    } else {
      cur.farm += r.talent ?? 0;
      cur.farmCount += 1;
      if ((r.talent ?? 0) > cur.topFarm) {
        cur.topFarm = r.talent ?? 0;
        cur.topId = r.player_id;
      }
      // Talent that is also young is worth more than the same talent at 26
      if (r.age <= 21) cur.young += r.talent ?? 0;
    }
    acc.set(r.org, cur);
  }

  // One name lookup for the handful of players actually shown
  const topIds = [...acc.values()].map((a) => a.topId).filter((id): id is number => id !== null);
  const names = new Map<number, string>();
  if (topIds.length > 0) {
    const holes = topIds.map(() => '?').join(',');
    for (const r of db
      .prepare(
        `SELECT player_id, first_name || ' ' || last_name AS name FROM players WHERE player_id IN (${holes})`
      )
      .all(...topIds) as Array<{ player_id: number; name: string }>) {
      names.set(r.player_id, r.name);
    }
  }

  const records = new Map<number, { w: number; l: number }>();
  if (tableExists('team_record')) {
    for (const r of db.prepare(`SELECT team_id, w, l FROM team_record`).all() as Array<{
      team_id: number; w: number; l: number;
    }>) {
      records.set(r.team_id, { w: r.w, l: r.l });
    }
  }

  const list = clubs.map((c) => {
    const a = acc.get(c.team_id) ?? { mlb: 0, farm: 0, farmCount: 0, topFarm: 0, topId: null, young: 0 };
    const rec = records.get(c.team_id) ?? null;
    return {
      team_id: c.team_id,
      team: c.label,
      isOrg: c.team_id === orgId,
      mlbTalent: Math.round(a.mlb),
      farmTalent: Math.round(a.farm),
      farmCount: a.farmCount,
      topProspect: Math.round(a.topFarm),
      topProspectId: a.topId,
      topProspectName: a.topId !== null ? (names.get(a.topId) ?? null) : null,
      youngTalent: Math.round(a.young),
      w: rec?.w ?? null,
      l: rec?.l ?? null,
    };
  });

  /** Rank on a field, 1 = best, so the client does not re-sort to find a place. */
  const rankBy = (key: 'mlbTalent' | 'farmTalent' | 'youngTalent'): Map<number, number> => {
    const order = [...list].sort((a, b) => b[key] - a[key]);
    return new Map(order.map((x, i) => [x.team_id, i + 1]));
  };
  const mlbRank = rankBy('mlbTalent');
  const farmRank = rankBy('farmTalent');
  const youngRank = rankBy('youngTalent');

  res.json({
    clubs: list
      .map((x) => ({
        ...x,
        mlbRank: mlbRank.get(x.team_id) ?? null,
        farmRank: farmRank.get(x.team_id) ?? null,
        youngRank: youngRank.get(x.team_id) ?? null,
      }))
      .sort((a, b) => (a.farmRank ?? 99) - (b.farmRank ?? 99)),
  });
});
