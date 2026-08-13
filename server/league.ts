import { Router } from 'express';
import { db, tableExists } from './db.js';
import { LEVEL_NAMES } from './valuation.js';
import { computeBatting, computePitching, leagueBaseline } from './stats.js';

export const leagueRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

/** OOTP stores streaks as a signed count: 3 = won three, -2 = lost two. */
const streakLabel = (streak: number | null): string => {
  if (!streak) return '—';
  return streak > 0 ? `W${streak}` : `L${Math.abs(streak)}`;
};

leagueRoutes.get('/standings/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('team_record')) return res.status(400).json({ error: 'No data imported yet' });
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown org' });

  // Runs scored and allowed aren't in team_record. The team stat tables hold
  // exactly one row per team, but batting and pitching disagree on which
  // split_id means "overall" — so group without filtering rather than guessing.
  // Runs allowed is `r`; `ra` is a different measure (verified against the
  // games table: NYY r=80 matches 80 runs allowed across 18 games).
  const runsFor = new Map<number, number>();
  const runsAgainst = new Map<number, number>();
  if (tableExists('team_batting_stats')) {
    for (const r of db
      .prepare(`SELECT team_id, SUM(r) AS runs FROM team_batting_stats GROUP BY team_id`)
      .all() as Array<{ team_id: number; runs: number }>) {
      runsFor.set(r.team_id, r.runs ?? 0);
    }
  }
  if (tableExists('team_pitching_stats')) {
    for (const r of db
      .prepare(`SELECT team_id, SUM(r) AS runs FROM team_pitching_stats GROUP BY team_id`)
      .all() as Array<{ team_id: number; runs: number }>) {
      runsAgainst.set(r.team_id, r.runs ?? 0);
    }
  }

  const rows = db
    .prepare(
      `SELECT t.team_id, ${teamLabel} AS team, t.abbr, t.sub_league_id, t.division_id,
              sl.name AS sub_league, d.name AS division,
              r.g, r.w, r.l, r.pct, r.pos, r.gb, r.streak, r.magic_number
       FROM teams t
       JOIN team_record r ON r.team_id = t.team_id
       LEFT JOIN sub_leagues sl ON sl.league_id = t.league_id AND sl.sub_league_id = t.sub_league_id
       LEFT JOIN divisions d ON d.league_id = t.league_id
            AND d.sub_league_id = t.sub_league_id AND d.division_id = t.division_id
       WHERE t.league_id = ? AND t.level = 1 AND t.allstar_team = 0
       ORDER BY t.sub_league_id, t.division_id, r.pos`
    )
    .all(org.league_id) as Array<Record<string, number | string | null>>;

  // Group into sub-league → division, the shape a standings page reads in
  const groups = new Map<string, { subLeague: string; divisions: Map<string, unknown[]> }>();
  for (const r of rows) {
    const sub = (r.sub_league as string) ?? 'League';
    const div = (r.division as string) ?? 'Division';
    if (!groups.has(sub)) groups.set(sub, { subLeague: sub, divisions: new Map() });
    const g = groups.get(sub)!;
    if (!g.divisions.has(div)) g.divisions.set(div, []);
    const rs = runsFor.get(r.team_id as number) ?? null;
    const ra = runsAgainst.get(r.team_id as number) ?? null;
    g.divisions.get(div)!.push({
      team_id: r.team_id,
      team: r.team,
      abbr: r.abbr,
      w: r.w,
      l: r.l,
      pct: r.pct,
      gb: r.gb,
      g: r.g,
      streak: streakLabel(r.streak as number | null),
      magicNumber: r.magic_number === 1000 ? null : r.magic_number,
      rs,
      ra,
      diff: rs !== null && ra !== null ? rs - ra : null,
      isOrg: r.team_id === orgId,
    });
  }

  const scheduled =
    (db.prepare(`SELECT rules_schedule_games_per_team AS n FROM leagues WHERE league_id = ?`)
      .get(org.league_id) as { n: number | null } | undefined)?.n ?? null;

  res.json({
    scheduledGames: scheduled,
    subLeagues: [...groups.values()].map((g) => ({
      name: g.subLeague,
      divisions: [...g.divisions.entries()].map(([name, teams]) => ({ name, teams })),
    })),
  });
});

/**
 * League-wide player browser. Filters run in SQL so only the returned page has
 * its stats computed — the players table holds 130k rows.
 */
/**
 * Every name the AI features are likely to mention, so plain prose can be
 * turned into hoverable links.
 *
 * Scoped to major-league rosters plus this organization's own minor leaguers:
 * that is who a briefing or a storyline actually writes about, and shipping the
 * whole 12,000-player league to the browser to underline a handful of names
 * would cost more than the feature is worth.
 */
leagueRoutes.get('/name-index/:orgId', (req, res) => {
  if (!tableExists('players')) return res.json({ names: [] });
  const orgId = Number(req.params.orgId);
  const rows = db
    .prepare(
      `SELECT p.player_id AS id, p.first_name || ' ' || p.last_name AS name,
              CASE WHEN p.organization_id = ? THEN 1 ELSE 0 END AS ours
       FROM players p
       JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND p.first_name IS NOT NULL AND p.last_name IS NOT NULL
         AND (t.level = 1 OR p.organization_id = ?)`
    )
    .all(orgId, orgId) as Array<{ id: number; name: string; ours: number }>;
  // The third field marks our own men, so a surname shared across the league
  // can be offered with ours first rather than refused as ambiguous
  res.json({ names: rows.map((r) => [r.id, r.name, r.ours] as const) });
});

leagueRoutes.get('/players', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const q = String(req.query.q ?? '').trim();
  const level = req.query.level === 'all' ? null : Number(req.query.level ?? 1);
  const orgId = req.query.orgId ? Number(req.query.orgId) : null;
  const group = req.query.group === 'pitching' ? 'pitching' : 'batting';
  const freeAgents = req.query.freeAgents === '1';
  const limit = Math.min(Number(req.query.limit ?? 100), 300);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);

  /*
   * The narrowing that makes a list of four hundred and sixty men usable.
   * Every one of these is a plain column on players, so they cost nothing to
   * apply and can be combined freely — which is the point: a left-handed
   * shortstop under 25 is a question the roster page could not answer at all.
   */
  const num = (v: unknown): number | null => {
    const n = Number(v);
    return v !== undefined && v !== '' && Number.isFinite(n) ? n : null;
  };
  const position = num(req.query.position);
  const role = num(req.query.role);
  const bats = num(req.query.bats);
  const throws = num(req.query.throws);
  const minAge = num(req.query.minAge);
  const maxAge = num(req.query.maxAge);
  const minPt = num(req.query.minPt);

  const where: string[] = ['p.retired = 0'];
  const params: Array<string | number> = [];
  if (freeAgents) {
    where.push('p.free_agent = 1');
  } else {
    where.push('p.team_id > 0');
    if (level !== null && Number.isFinite(level)) {
      where.push('t.level = ?');
      params.push(level);
    }
    if (orgId !== null) {
      where.push('p.organization_id = ?');
      params.push(orgId);
    }
  }
  if (q.length >= 2) {
    where.push(`(p.first_name || ' ' || p.last_name) LIKE ?`);
    params.push(`%${q}%`);
  }
  where.push(group === 'pitching' ? 'p.position = 1' : 'p.position != 1');

  // Position for a hitter, role for a pitcher — the same question either way
  if (position !== null) { where.push('p.position = ?'); params.push(position); }
  if (role !== null) { where.push('p.role = ?'); params.push(role); }
  // A switch hitter answers to both sides rather than to neither
  if (bats !== null) { where.push('(p.bats = ? OR p.bats = 3)'); params.push(bats); }
  if (throws !== null) { where.push('p.throws = ?'); params.push(throws); }
  if (minAge !== null) { where.push('p.age >= ?'); params.push(minAge); }
  if (maxAge !== null) { where.push('p.age <= ?'); params.push(maxAge); }

  const statYear = tableExists('players_career_batting_stats')
    ? (db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number }).y
    : null;

  // Sort by this season's playing time so the default view is the regulars,
  // not everyone whose last name starts with A. Players with no stat line
  // (rookies, the just-signed) fall to the bottom but stay findable by name.
  const ptTable = group === 'pitching' ? 'players_career_pitching_stats' : 'players_career_batting_stats';
  const ptColumn = group === 'pitching' ? 'outs' : 'pa';
  const ptJoin =
    statYear !== null
      ? `LEFT JOIN (SELECT player_id, SUM(${ptColumn}) AS pt FROM "${ptTable}"
                    WHERE year = ${statYear} AND split_id = 1 GROUP BY player_id) pt
         ON pt.player_id = p.player_id`
      : '';
  const orderBy = statYear !== null
    ? 'COALESCE(pt.pt, 0) DESC, p.last_name, p.first_name'
    : 'p.last_name, p.first_name';

  /*
   * A playing-time floor is the one filter that cannot come from the players
   * table, so it rides on the join that already exists for the sort order —
   * and the count has to carry the same join, or the total describes a
   * different set of players than the rows beneath it.
   */
  const ptWhere = [...where];
  const ptParams = [...params];
  if (minPt !== null && statYear !== null) {
    ptWhere.push('COALESCE(pt.pt, 0) >= ?');
    ptParams.push(minPt);
  }

  const total = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
         ${ptJoin}
         WHERE ${ptWhere.join(' AND ')}`
      )
      .get(...ptParams) as { n: number }
  ).n;

  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position, p.role, p.bats, p.throws,
              p.team_id, p.free_agent, t.level, t.league_id,
              CASE WHEN t.team_id IS NULL THEN NULL ELSE ${teamLabel} END AS team, t.abbr
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       ${ptJoin}
       WHERE ${ptWhere.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT ? OFFSET ?`
    )
    .all(...ptParams, limit, offset) as Array<Record<string, number | string | null>>;

  const ids = rows.map((r) => r.player_id as number);
  const statsById = new Map<number, Record<string, number | string | null>>();

  if (statYear !== null && ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const table = group === 'pitching' ? 'players_career_pitching_stats' : 'players_career_batting_stats';
    const columns =
      group === 'pitching'
        ? `SUM(outs) AS outs, SUM(er) AS er, SUM(ra) AS ra, SUM(ha) AS ha, SUM(bb) AS bb,
           SUM(k) AS k, SUM(hra) AS hra, SUM(hp) AS hp, SUM(bf) AS bf, SUM(g) AS g, SUM(gs) AS gs,
           SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv, SUM(hld) AS hld, SUM(war) AS war`
        : `SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3, SUM(hr) AS hr,
           SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf, SUM(k) AS k,
           SUM(sb) AS sb, SUM(cs) AS cs, SUM(r) AS r, SUM(rbi) AS rbi, SUM(war) AS war`;
    const statRows = db
      .prepare(
        `SELECT player_id, league_id, level_id, ${columns} FROM "${table}"
         WHERE year = ? AND split_id = 1 AND player_id IN (${placeholders})
         GROUP BY player_id, league_id, level_id`
      )
      .all(statYear, ...ids) as Array<Record<string, number>>;
    for (const row of statRows) {
      const base = leagueBaseline(row.league_id, statYear, row.level_id);
      const teamId = (rows.find((r) => r.player_id === row.player_id)?.team_id as number) ?? null;
      const computed = group === 'pitching'
        ? computePitching(row, base, teamId)
        : computeBatting(row, base, teamId);
      /*
       * A player can appear at several levels; keep the busiest stint — and
       * say which one it was. The line was already correctly unblended, but
       * nothing marked it, so a Triple-A season on a man now on the major
       * league roster read as major-league work. A reader reported exactly
       * that: two lines set against each other, one of them not what it
       * appeared to be.
       */
      const existing = statsById.get(row.player_id);
      const weight = group === 'pitching' ? (computed.ip ?? 0) : (computed.pa ?? 0);
      const prior = existing ? Number((group === 'pitching' ? existing.ip : existing.pa) ?? 0) : -1;
      if (weight > prior) {
        statsById.set(row.player_id, {
          ...computed,
          statsLevel: LEVEL_NAMES[row.level_id] ?? `L${row.level_id}`,
        });
      }
    }
  }

  res.json({
    total,
    offset,
    limit,
    players: rows.map((r) => ({
      player_id: r.player_id,
      name: `${r.first_name} ${r.last_name}`,
      age: r.age,
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      bats: HAND[r.bats as number] ?? '?',
      throws: HAND[r.throws as number] ?? '?',
      team: r.team ?? (r.free_agent === 1 ? 'Free Agent' : null),
      abbr: r.abbr,
      levelName: r.level !== null ? LEVEL_NAMES[r.level as number] ?? 'R' : null,
      stats: statsById.get(r.player_id as number) ?? null,
    })),
  });
});
