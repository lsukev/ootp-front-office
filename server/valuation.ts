import { db, tableExists } from './db.js';

export interface ContractInfo {
  salaryNow: number;
  totalYears: number;
  yearsAfterThis: number;
  endYear: number;
  isMajor: boolean;
  noTrade: boolean;
  lastYearTeamOption: boolean;
  lastYearPlayerOption: boolean;
  lastYearVestingOption: boolean;
}

/**
 * SQL fragment restricting a `players p` query to men genuinely on the club.
 *
 * `players.team_id` is not the roster: OOTP parks newly signed international
 * free agents on the parent club until they are assigned to an affiliate, so a
 * bare `team_id = ?` sweeps 16-year-olds from the complex league in alongside
 * the major-league staff. Roster status is the real signal — active, or on the
 * injured list (Cole and Schmidt are inactive but very much on the roster).
 *
 * Requires the query to join `players_roster_status rs ON rs.player_id = p.player_id`.
 */
export const ON_ROSTER = '(rs.is_active = 1 OR rs.is_on_dl = 1 OR rs.is_on_dl60 = 1)';

export function seasonYear(leagueId: number): number {
  const row = db.prepare(`SELECT season_year FROM leagues WHERE league_id = ?`).get(leagueId) as
    | { season_year: number }
    | undefined;
  return row?.season_year ?? new Date().getFullYear();
}

export function currentGameDate(leagueId: number): string | null {
  const row = db.prepare(`SELECT "current_date" AS d FROM leagues WHERE league_id = ?`).get(leagueId) as
    | { d: string }
    | undefined;
  return row?.d ?? null;
}

/** Contracts keyed by player_id. Salary years live in salary0..salary14. */
export function contractsByPlayer(): Map<number, ContractInfo> {
  const out = new Map<number, ContractInfo>();
  if (!tableExists('players_contract')) return out;
  const rows = db.prepare(`SELECT * FROM players_contract`).all() as Array<Record<string, number>>;
  for (const c of rows) {
    const years = c.years ?? 0;
    // current_year counts COMPLETED contract years, so this season's salary is
    // salary{current_year} (0-based) — verified against known deals in a real export
    const completed = c.current_year ?? 0;
    const idx = Math.min(Math.max(completed, 0), 14);
    out.set(c.player_id, {
      salaryNow: c[`salary${idx}`] ?? 0,
      totalYears: years,
      yearsAfterThis: Math.max(years - completed - 1, 0),
      endYear: (c.season_year ?? 0) + years - 1,
      isMajor: c.is_major === 1,
      noTrade: c.no_trade === 1,
      lastYearTeamOption: c.last_year_team_option === 1,
      lastYearPlayerOption: c.last_year_player_option === 1,
      lastYearVestingOption: c.last_year_vesting_option === 1,
    });
  }
  return out;
}

export interface PlayerValue {
  overall: number;
  talent: number;
  offense: number;
  offenseVsL: number;
  offenseVsR: number;
  pitching: number;
}

export function valuesByPlayer(): Map<number, PlayerValue> {
  const out = new Map<number, PlayerValue>();
  if (!tableExists('players_value')) return out;
  const rows = db
    .prepare(
      `SELECT player_id, overall_value, talent_value, offensive_value,
              offensive_value_vsl, offensive_value_vsr, pitching_value
       FROM players_value`
    )
    .all() as Array<Record<string, number>>;
  for (const r of rows) {
    out.set(r.player_id, {
      overall: r.overall_value ?? 0,
      talent: r.talent_value ?? 0,
      offense: r.offensive_value ?? 0,
      offenseVsL: r.offensive_value_vsl ?? 0,
      offenseVsR: r.offensive_value_vsr ?? 0,
      pitching: r.pitching_value ?? 0,
    });
  }
  return out;
}

/**
 * Percentile rank (0-100) helpers computed against all players currently on an
 * MLB-level roster — the pool that matters for big-league decisions.
 */
export function mlbPercentiler(values: Map<number, PlayerValue>): {
  overallPct: (playerId: number) => number | null;
  talentPct: (playerId: number) => number | null;
} {
  const mlbIds = (
    db
      .prepare(
        `SELECT p.player_id FROM players p JOIN teams t ON t.team_id = p.team_id
         WHERE t.level = 1 AND t.allstar_team = 0 AND p.retired = 0`
      )
      .all() as Array<{ player_id: number }>
  ).map((r) => r.player_id);
  const overallSorted = mlbIds
    .map((id) => values.get(id)?.overall)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  const talentSorted = mlbIds
    .map((id) => values.get(id)?.talent)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  const pct = (sorted: number[], v: number | undefined): number | null => {
    if (v === undefined || sorted.length === 0) return null;
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    return Math.round((lo / sorted.length) * 100);
  };
  return {
    overallPct: (id) => pct(overallSorted, values.get(id)?.overall),
    talentPct: (id) => pct(talentSorted, values.get(id)?.talent),
  };
}

export interface TeamFinances {
  budget: number;
  payroll: number;
  payrollNextSeason: number;
  cash: number;
  market: number;
  fanInterest: number;
}

export function teamFinances(teamId: number): TeamFinances | null {
  if (!tableExists('team_financials')) return null;
  const r = db
    .prepare(
      `SELECT budget, player_payroll, player_payroll_next_season, cash,
              cash_trades_available, market, fan_interest
       FROM team_financials WHERE team_id = ?`
    )
    .get(teamId) as Record<string, number> | undefined;
  if (!r) return null;
  return {
    budget: r.budget ?? 0,
    payroll: r.player_payroll ?? 0,
    payrollNextSeason: r.player_payroll_next_season ?? 0,
    // OOTP exports `cash` as zero for every team; the money a club can
    // actually spend is cash_trades_available. Reporting the dead field made
    // the GM briefing and storylines announce "zero cash on hand" to clubs
    // sitting on millions.
    cash: r.cash_trades_available ?? r.cash ?? 0,
    market: r.market ?? 0,
    fanInterest: r.fan_interest ?? 0,
  };
}
