import { db, tableExists } from './db.js';

/**
 * League-relative statistics (OPS+, wRC+, ERA+) need a league baseline and a
 * park factor. Both are derived from the imported save rather than hardcoded,
 * so they stay correct for any league setup, run environment, or era.
 */

/** wOBA linear weights. wOBAScale is the run-conversion implied by these same weights. */
const W = { bb: 0.69, hbp: 0.72, single: 0.88, double: 1.25, triple: 1.58, hr: 2.03 };
const WOBA_SCALE = 1.2;

export interface LeagueBaseline {
  year: number;
  lgOBP: number;
  lgSLG: number;
  lgWOBA: number;
  lgRperPA: number;
  lgERA: number;
  /** League's raw FIP numerator per inning; lgERA minus this is the FIP constant. */
  lgFIPRaw: number;
  /** team_id → park run factor, already halved for a half-home schedule. */
  parkFactor: Map<number, number>;
}

const baselineCache = new Map<string, LeagueBaseline>();

/**
 * OOTP publishes per-park AVG and HR ratings. We blend them into one run-scoring
 * factor, then halve the deviation because a player only plays half his games at
 * home — the standard correction used for park-adjusted rate stats.
 */
function parkFactors(leagueId: number): Map<number, number> {
  const out = new Map<number, number>();
  if (!tableExists('parks')) return out;
  const rows = db
    .prepare(
      `SELECT t.team_id, p.avg AS avgF, p.hr AS hrF
       FROM teams t JOIN parks p ON p.park_id = t.park_id
       WHERE t.league_id = ? AND t.allstar_team = 0`
    )
    .all(leagueId) as Array<{ team_id: number; avgF: number | null; hrF: number | null }>;
  for (const r of rows) {
    const raw = ((r.avgF ?? 1) + (r.hrF ?? 1)) / 2;
    out.set(r.team_id, 1 + (raw - 1) / 2);
  }
  return out;
}

/**
 * Baselines are per league AND level — a Double-A hitter is measured against
 * Double-A, not the majors, so his OPS+ means what it should.
 */
export function leagueBaseline(leagueId: number, year: number, level = 1): LeagueBaseline {
  const key = `${leagueId}:${year}:${level}`;
  const hit = baselineCache.get(key);
  if (hit) return hit;

  const bat = db
    .prepare(
      `SELECT SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d, SUM(s.t) AS t3,
              SUM(s.hr) AS hr, SUM(s.bb) AS bb, SUM(s.ibb) AS ibb, SUM(s.hp) AS hp,
              SUM(s.sf) AS sf, SUM(s.r) AS r
       FROM players_career_batting_stats s
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND s.league_id = ?`
    )
    .get(year, level, leagueId) as Record<string, number | null>;

  const pit = db
    .prepare(
      `SELECT SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.hra) AS hra,
              SUM(s.bb) AS bb, SUM(s.k) AS k, SUM(s.hp) AS hp
       FROM players_career_pitching_stats s
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND s.league_id = ?`
    )
    .get(year, level, leagueId) as Record<string, number | null>;

  const n = (v: number | null | undefined) => v ?? 0;
  const ab = n(bat.ab);
  const h = n(bat.h);
  const singles = h - n(bat.d) - n(bat.t3) - n(bat.hr);
  const obpDen = ab + n(bat.bb) + n(bat.hp) + n(bat.sf);
  const wobaDen = ab + (n(bat.bb) - n(bat.ibb)) + n(bat.sf) + n(bat.hp);
  const lgInnings = n(pit.outs) / 3;

  const baseline: LeagueBaseline = {
    year,
    lgOBP: obpDen ? (h + n(bat.bb) + n(bat.hp)) / obpDen : 0,
    lgSLG: ab ? (singles + 2 * n(bat.d) + 3 * n(bat.t3) + 4 * n(bat.hr)) / ab : 0,
    lgWOBA: wobaDen
      ? (W.bb * (n(bat.bb) - n(bat.ibb)) + W.hbp * n(bat.hp) + W.single * singles +
         W.double * n(bat.d) + W.triple * n(bat.t3) + W.hr * n(bat.hr)) / wobaDen
      : 0,
    lgRperPA: n(bat.pa) ? n(bat.r) / n(bat.pa) : 0,
    lgERA: lgInnings ? (n(pit.er) / lgInnings) * 9 : 0,
    lgFIPRaw: lgInnings
      ? (13 * n(pit.hra) + 3 * (n(pit.bb) + n(pit.hp)) - 2 * n(pit.k)) / lgInnings
      : 0,
    parkFactor: parkFactors(leagueId),
  };
  baselineCache.set(key, baseline);
  return baseline;
}

/** Cleared whenever a fresh export is imported. */
export function clearStatCaches(): void {
  baselineCache.clear();
}

export interface RawBatting {
  pa: number; ab: number; h: number; d: number; t3: number; hr: number;
  bb: number; ibb: number; hp: number; sf: number; k: number; sb: number;
  cs: number; r: number; rbi: number; war: number;
}

export interface RawPitching {
  outs: number; er: number; ra: number; ha: number; bb: number; k: number;
  hra: number; hp: number; bf: number; g: number; gs: number; w: number; l: number;
  sv: number; hld: number; war: number;
}

const round = (v: number | null, places: number): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(places));

export function computeBatting(
  s: Partial<RawBatting>, base: LeagueBaseline, teamId: number | null
): Record<string, number | null> {
  const g = (k: keyof RawBatting) => s[k] ?? 0;
  const ab = g('ab');
  const pa = g('pa');
  const h = g('h');
  const singles = h - g('d') - g('t3') - g('hr');
  const obpDen = ab + g('bb') + g('hp') + g('sf');
  const wobaDen = ab + (g('bb') - g('ibb')) + g('sf') + g('hp');

  const avg = ab ? h / ab : null;
  const obp = obpDen ? (h + g('bb') + g('hp')) / obpDen : null;
  const slg = ab ? (singles + 2 * g('d') + 3 * g('t3') + 4 * g('hr')) / ab : null;
  const woba = wobaDen
    ? (W.bb * (g('bb') - g('ibb')) + W.hbp * g('hp') + W.single * singles +
       W.double * g('d') + W.triple * g('t3') + W.hr * g('hr')) / wobaDen
    : null;
  const babipDen = ab - g('k') - g('hr') + g('sf');
  const pf = (teamId !== null ? base.parkFactor.get(teamId) : undefined) ?? 1;

  // OPS+ : 100 × (OBP/lgOBP + SLG/lgSLG − 1), then park-adjusted
  const opsPlus =
    obp !== null && slg !== null && base.lgOBP > 0 && base.lgSLG > 0
      ? (100 * (obp / base.lgOBP + slg / base.lgSLG - 1)) / pf
      : null;

  // wRC+ : runs created per PA relative to league, park-adjusted
  const wrcPlus =
    woba !== null && base.lgRperPA > 0
      ? (100 * ((woba - base.lgWOBA) / WOBA_SCALE + base.lgRperPA)) / (base.lgRperPA * pf)
      : null;

  return {
    pa, ab, h,
    d: g('d'), t3: g('t3'), hr: g('hr'), r: g('r'), rbi: g('rbi'),
    bb: g('bb'), k: g('k'), sb: g('sb'), cs: g('cs'),
    xbh: g('d') + g('t3') + g('hr'),
    avg: round(avg, 3),
    obp: round(obp, 3),
    slg: round(slg, 3),
    ops: obp !== null && slg !== null ? round(obp + slg, 3) : null,
    iso: slg !== null && avg !== null ? round(slg - avg, 3) : null,
    babip: babipDen > 0 ? round((h - g('hr')) / babipDen, 3) : null,
    woba: round(woba, 3),
    bbPct: pa ? round((g('bb') / pa) * 100, 1) : null,
    kPct: pa ? round((g('k') / pa) * 100, 1) : null,
    sbPct: g('sb') + g('cs') > 0 ? round((g('sb') / (g('sb') + g('cs'))) * 100, 0) : null,
    opsPlus: round(opsPlus, 0),
    wrcPlus: round(wrcPlus, 0),
    war: round(g('war'), 1),
  };
}

export function computePitching(
  s: Partial<RawPitching>, base: LeagueBaseline, teamId: number | null
): Record<string, number | null> {
  const g = (k: keyof RawPitching) => s[k] ?? 0;
  const ip = g('outs') / 3;
  const pf = (teamId !== null ? base.parkFactor.get(teamId) : undefined) ?? 1;

  const era = ip ? (g('er') / ip) * 9 : null;
  // ERA+ : 100 × lgERA / ERA, with the park factor lifting pitchers in hitters' parks
  const eraPlus = era !== null && era > 0 && base.lgERA > 0 ? (100 * base.lgERA * pf) / era : null;
  // FIP's constant is what makes league FIP equal league ERA, so it must be
  // lgERA minus the league's own raw component — not lgERA minus the textbook
  // 3.10. Using the textbook figure inflated every FIP by the difference.
  const fipConstant = base.lgERA > 0 ? base.lgERA - base.lgFIPRaw : 0;

  return {
    g: g('g'), gs: g('gs'), w: g('w'), l: g('l'), sv: g('sv'), hld: g('hld'),
    ip: round(ip, 1),
    h: g('ha'), er: g('er'), bb: g('bb'), k: g('k'), hr: g('hra'),
    era: round(era, 2),
    whip: ip ? round((g('bb') + g('ha')) / ip, 2) : null,
    k9: ip ? round((g('k') / ip) * 9, 1) : null,
    bb9: ip ? round((g('bb') / ip) * 9, 1) : null,
    hr9: ip ? round((g('hra') / ip) * 9, 1) : null,
    kbb: g('bb') ? round(g('k') / g('bb'), 2) : g('k') > 0 ? null : null,
    kPct: g('bf') ? round((g('k') / g('bf')) * 100, 1) : null,
    bbPct: g('bf') ? round((g('bb') / g('bf')) * 100, 1) : null,
    // Walks and hit batsmen both count: they are the batter reaching without
    // the defense being involved, which is the whole point of the metric.
    fip: ip
      ? round((13 * g('hra') + 3 * (g('bb') + g('hp')) - 2 * g('k')) / ip + fipConstant, 2)
      : null,
    eraPlus: round(eraPlus, 0),
    war: round(g('war'), 1),
  };
}
