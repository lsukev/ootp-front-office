import { Router } from 'express';
import { db, tableExists } from './db.js';

export const orgRoutes = Router();

const LEVEL_NAMES: Record<number, string> = { 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R' };

const avg = (vals: Array<number | null | undefined>): number | null => {
  const nums = vals.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
};

/** MLB parent clubs, with the human-controlled org flagged and team colors. */
orgRoutes.get('/orgs', (_req, res) => {
  if (!tableExists('teams')) return res.json([]);
  const rows = db
    .prepare(
      `SELECT team_id, name, nickname, human_team,
              background_color_id AS bg, text_color_id AS fg,
              jersey_secondary_color_id AS secondary, ballcaps_main_color_id AS cap
       FROM teams WHERE level = 1 AND allstar_team = 0 ORDER BY name`
    )
    .all() as Array<{
    team_id: number; name: string; nickname: string; human_team: number;
    bg: string | null; fg: string | null; secondary: string | null; cap: string | null;
  }>;
  res.json(
    rows.map((r) => ({
      team_id: r.team_id,
      label: r.name === r.nickname ? r.name : `${r.name} ${r.nickname}`,
      isHuman: r.human_team === 1,
      colors: { bg: r.bg, fg: r.fg, secondary: r.secondary, cap: r.cap },
    }))
  );
});

function orgTeams(orgId: number) {
  return db
    .prepare(
      `SELECT team_id, name, nickname, level FROM teams
       WHERE team_id = ? OR parent_team_id = ? ORDER BY level, team_id`
    )
    .all(orgId, orgId) as Array<{ team_id: number; name: string; nickname: string; level: number }>;
}

interface OrgPlayer {
  player_id: number;
  team_id: number;
  first_name: string;
  last_name: string;
  age: number;
  position: number;
  role: number;
  con: number | null; gap: number | null; pow: number | null; eye: number | null; avk: number | null;
  conP: number | null; gapP: number | null; powP: number | null; eyeP: number | null; avkP: number | null;
  stu: number | null; mov: number | null; ctl: number | null;
  stuP: number | null; movP: number | null; ctlP: number | null;
  spd: number | null;
}

function orgPlayers(orgId: number): OrgPlayer[] {
  return db
    .prepare(
      `SELECT p.player_id, p.team_id, p.first_name, p.last_name, p.age, p.position, p.role,
              b.batting_ratings_overall_contact AS con, b.batting_ratings_overall_gap AS gap,
              b.batting_ratings_overall_power AS pow, b.batting_ratings_overall_eye AS eye,
              b.batting_ratings_overall_strikeouts AS avk,
              b.batting_ratings_talent_contact AS conP, b.batting_ratings_talent_gap AS gapP,
              b.batting_ratings_talent_power AS powP, b.batting_ratings_talent_eye AS eyeP,
              b.batting_ratings_talent_strikeouts AS avkP,
              b.running_ratings_speed AS spd,
              pi.pitching_ratings_overall_stuff AS stu, pi.pitching_ratings_overall_movement AS mov,
              pi.pitching_ratings_overall_control AS ctl,
              pi.pitching_ratings_talent_stuff AS stuP, pi.pitching_ratings_talent_movement AS movP,
              pi.pitching_ratings_talent_control AS ctlP
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       WHERE p.organization_id = ? AND p.team_id > 0 AND p.retired = 0`
    )
    .all(orgId) as OrgPlayer[];
}

function composites(p: OrgPlayer): { cur: number | null; pot: number | null } {
  if (p.position === 1) {
    return { cur: avg([p.stu, p.mov, p.ctl]), pot: avg([p.stuP, p.movP, p.ctlP]) };
  }
  return {
    cur: avg([p.con, p.gap, p.pow, p.eye, p.avk]),
    pot: avg([p.conP, p.gapP, p.powP, p.eyeP, p.avkP]),
  };
}

orgRoutes.get('/depth-chart/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const teams = orgTeams(orgId).map((t) => ({
    ...t,
    label: `${t.name} ${t.nickname}`,
    levelName: LEVEL_NAMES[t.level] ?? `L${t.level}`,
  }));
  const players = orgPlayers(orgId).map((p) => {
    const { cur, pot } = composites(p);
    return {
      player_id: p.player_id,
      team_id: p.team_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      position: p.position,
      role: p.role,
      cur,
      pot,
    };
  });
  res.json({ teams, players });
});

/** Aggregate latest-season stats per player (split 1 = overall). */
function seasonBatting(): Map<number, Record<string, number>> {
  const t = 'players_career_batting_stats';
  const out = new Map<number, Record<string, number>>();
  if (!tableExists(t)) return out;
  const year = (db.prepare(`SELECT MAX(year) AS y FROM "${t}"`).get() as { y: number }).y;
  const rows = db
    .prepare(
      `SELECT player_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t,
              SUM(hr) AS hr, SUM(bb) AS bb, SUM(hp) AS hp, SUM(k) AS k, SUM(sf) AS sf,
              SUM(sb) AS sb, SUM(war) AS war
       FROM "${t}" WHERE year = ? AND split_id = 1 GROUP BY player_id`
    )
    .all(year) as Array<Record<string, number>>;
  for (const r of rows) out.set(r.player_id, r);
  return out;
}

function seasonPitching(): Map<number, Record<string, number>> {
  const t = 'players_career_pitching_stats';
  const out = new Map<number, Record<string, number>>();
  if (!tableExists(t)) return out;
  const year = (db.prepare(`SELECT MAX(year) AS y FROM "${t}"`).get() as { y: number }).y;
  const rows = db
    .prepare(
      `SELECT player_id, SUM(outs) AS outs, SUM(er) AS er, SUM(bb) AS bb, SUM(k) AS k,
              SUM(bf) AS bf, SUM(ha) AS ha, SUM(g) AS g, SUM(gs) AS gs, SUM(war) AS war
       FROM "${t}" WHERE year = ? AND split_id = 1 GROUP BY player_id`
    )
    .all(year) as Array<Record<string, number>>;
  for (const r of rows) out.set(r.player_id, r);
  return out;
}

const ops = (s: Record<string, number>): number | null => {
  const ab = s.ab ?? 0;
  if (!ab) return null;
  const singles = s.h - s.d - s.t - s.hr;
  const obpDen = ab + s.bb + s.hp + s.sf;
  const obp = obpDen ? (s.h + s.bb + s.hp) / obpDen : 0;
  const slg = (singles + 2 * s.d + 3 * s.t + 4 * s.hr) / ab;
  return obp + slg;
};

/**
 * League-wide per-level baselines (avg age of rostered players; avg OPS / ERA / K%
 * of players with a meaningful sample), computed from THIS save's data so the
 * thresholds self-calibrate to the league environment.
 */
function levelBaselines(batting: Map<number, Record<string, number>>, pitching: Map<number, Record<string, number>>) {
  const players = db
    .prepare(
      `SELECT p.player_id, p.age, p.position, t.level FROM players p
       JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND t.level >= 1 AND t.allstar_team = 0`
    )
    .all() as Array<{ player_id: number; age: number; position: number; level: number }>;

  const acc = new Map<number, { ages: number[]; ops: number[]; era: number[]; kpct: number[] }>();
  for (const p of players) {
    if (!acc.has(p.level)) acc.set(p.level, { ages: [], ops: [], era: [], kpct: [] });
    const a = acc.get(p.level)!;
    a.ages.push(p.age);
    const b = batting.get(p.player_id);
    if (b && (b.pa ?? 0) >= 50) {
      const o = ops(b);
      if (o !== null) a.ops.push(o);
    }
    const pi = pitching.get(p.player_id);
    if (pi && (pi.outs ?? 0) >= 45) {
      a.era.push(((pi.er ?? 0) / (pi.outs / 3)) * 9);
      if (pi.bf > 0) a.kpct.push(pi.k / pi.bf);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const out: Record<number, { avgAge: number | null; avgOps: number | null; avgEra: number | null; avgKpct: number | null }> = {};
  for (const [level, a] of acc) {
    out[level] = { avgAge: mean(a.ages), avgOps: mean(a.ops), avgEra: mean(a.era), avgKpct: mean(a.kpct) };
  }
  return out;
}

export function computeProspects(orgId: number): { batters: unknown[]; pitchers: unknown[]; baselines: unknown } {
  const batting = seasonBatting();
  const pitching = seasonPitching();
  const baselines = levelBaselines(batting, pitching);
  const teams = new Map(orgTeams(orgId).map((t) => [t.team_id, t]));

  const batters: unknown[] = [];
  const pitchers: unknown[] = [];

  for (const p of orgPlayers(orgId)) {
    const team = teams.get(p.team_id);
    if (!team || team.level <= 1) continue; // only minor leaguers
    const base = baselines[team.level];
    if (!base) continue;
    const { cur, pot } = composites(p);
    const ageDiff = base.avgAge !== null ? base.avgAge - p.age : null;
    const common = {
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      team: `${team.name} ${team.nickname}`,
      level: team.level,
      levelName: LEVEL_NAMES[team.level] ?? `L${team.level}`,
      cur,
      pot,
      ageDiff,
    };

    if (p.position === 1) {
      const s = pitching.get(p.player_id);
      if (!s || (s.outs ?? 0) < 45) continue; // ~15 IP minimum
      const ip = s.outs / 3;
      const era = ((s.er ?? 0) / ip) * 9;
      const kpct = s.bf > 0 ? s.k / s.bf : 0;
      const eraDiff = base.avgEra !== null ? base.avgEra - era : 0;
      const kDiff = base.avgKpct !== null ? kpct - base.avgKpct : 0;
      const reasons: string[] = [];
      if (eraDiff >= 1.0) reasons.push(`ERA ${era.toFixed(2)} vs level avg ${base.avgEra!.toFixed(2)}`);
      if (kDiff >= 0.05) reasons.push(`K% ${(kpct * 100).toFixed(0)} vs level avg ${(base.avgKpct! * 100).toFixed(0)}`);
      if (ageDiff !== null && ageDiff >= 1.5) reasons.push(`young for level (${p.age} vs avg ${base.avgAge!.toFixed(1)})`);
      if (cur !== null && pot !== null && pot - cur <= 5) reasons.push('near ceiling — development mostly done');
      const score = eraDiff * 12 + kDiff * 200 + (ageDiff ?? 0) * 8;
      pitchers.push({
        ...common, role: p.role, ip: Number(ip.toFixed(1)), era: Number(era.toFixed(2)),
        kpct: Number((kpct * 100).toFixed(1)), war: s.war ?? 0,
        score: Number(score.toFixed(1)), reasons,
        signal: eraDiff >= 1.0 && ip >= 30 ? 'promote' : score > 5 ? 'watch' : null,
      });
    } else {
      const s = batting.get(p.player_id);
      if (!s || (s.pa ?? 0) < 60) continue;
      const o = ops(s);
      if (o === null) continue;
      const opsDiff = base.avgOps !== null ? o - base.avgOps : 0;
      const reasons: string[] = [];
      if (opsDiff >= 0.1) reasons.push(`OPS ${o.toFixed(3)} vs level avg ${base.avgOps!.toFixed(3)}`);
      if (ageDiff !== null && ageDiff >= 1.5) reasons.push(`young for level (${p.age} vs avg ${base.avgAge!.toFixed(1)})`);
      if (cur !== null && pot !== null && pot - cur <= 5) reasons.push('near ceiling — development mostly done');
      if (cur !== null && pot !== null && pot - cur >= 15) reasons.push('high remaining upside');
      const score = opsDiff * 300 + (ageDiff ?? 0) * 8;
      batters.push({
        ...common, pa: s.pa, opsVal: Number(o.toFixed(3)), hr: s.hr, sb: s.sb, war: s.war ?? 0,
        score: Number(score.toFixed(1)), reasons,
        signal: opsDiff >= 0.075 && s.pa >= 100 ? 'promote' : score > 5 ? 'watch' : null,
      });
    }
  }

  const byScore = (a: unknown, b: unknown) => (b as { score: number }).score - (a as { score: number }).score;
  batters.sort(byScore);
  pitchers.sort(byScore);
  return { batters, pitchers, baselines };
}

orgRoutes.get('/prospects/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  res.json(computeProspects(orgId));
});
