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
  /**
   * An already-signed extension that begins after the current deal runs out.
   * OOTP keeps it in a separate table until it takes effect, so a player who
   * has just signed one still shows a one-year contract in players_contract —
   * which read as "expiring" when he is in fact locked up for years.
   */
  extension: { years: number; startYear: number; endYear: number; firstSalary: number } | null;
  /** Last season the club holds him under contract, extension included. */
  controlledThrough: number;
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

export interface LeagueRules {
  /** Service years needed for free agency; 0 means the league has none. */
  faMinYears: number;
  /** Service years needed for arbitration; 0 means the league has none. */
  arbMinYears: number;
  /** False in reserve-clause leagues, where a player cannot reach a market. */
  hasFreeAgency: boolean;
  hasArbitration: boolean;
  minimumSalary: number;
  /** OOTP's money scale. Historical leagues run far below 1.0. */
  financialCoefficient: number;
}

/**
 * A league's own contract rules, rather than the modern CBA.
 *
 * Historical and reserve-clause leagues export a free-agency threshold of 0,
 * meaning "never". Read naively that turns into "everyone qualifies", which
 * flagged an entire 1910s roster as expiring and had the AI warning about an
 * open market that would not exist for another sixty years.
 */
export function leagueRules(leagueId: number): LeagueRules {
  const r = db
    .prepare(
      `SELECT rules_fa_minimum_years AS fa, rules_salary_arbitration_minimum_years AS arb,
              rules_minimum_salary AS minSalary, financial_coefficient AS coef
       FROM leagues WHERE league_id = ?`
    )
    .get(leagueId) as
    | { fa: number | null; arb: number | null; minSalary: number | null; coef: number | null }
    | undefined;

  const faMinYears = r?.fa ?? 6;
  const arbMinYears = r?.arb ?? 3;
  return {
    faMinYears,
    arbMinYears,
    hasFreeAgency: faMinYears > 0,
    hasArbitration: arbMinYears > 0,
    minimumSalary: r?.minSalary ?? 0,
    financialCoefficient: r?.coef ?? 1,
  };
}

/**
 * Whether this club's half of the league bats a designated hitter.
 *
 * The flag lives on the sub-league, not the league, which is historically
 * exactly right: the AL adopted the DH in 1973 and the NL did not until 2022,
 * so the two halves of the same league disagreed for half a century. A
 * pre-1973 replay has it off everywhere, and a lineup card that hands one of
 * the nine spots to a DH is simply illegal there.
 */
export function usesDH(teamId: number): boolean {
  if (!tableExists('sub_leagues')) return true;
  const row = db
    .prepare(
      `SELECT sl.designated_hitter AS dh
       FROM teams t
       JOIN sub_leagues sl
         ON sl.league_id = t.league_id AND sl.sub_league_id = t.sub_league_id
       WHERE t.team_id = ?`
    )
    .get(teamId) as { dh: number | null } | undefined;
  // An export without the table behaves as it always did rather than dropping
  // a bat from every lineup in the app
  return row?.dh == null ? true : row.dh === 1;
}

/**
 * A plain-language note about the league's rules, for the AI prompts.
 *
 * Without this the model assumes the modern game. In a reserve-clause league it
 * would urge a GM to extend a player "before he reaches the open market" that
 * will not exist for another sixty years, and in a pre-1973 replay it would
 * happily park a slugger at DH.
 */
export function rulesBriefing(leagueId: number, teamId?: number): string {
  const r = leagueRules(leagueId);
  const parts: string[] = [];
  // Whether the pitcher hits changes lineup construction, bench roles and what
  // a "bat-only" player is worth, so the model must not assume the modern game
  if (teamId !== undefined && !usesDH(teamId)) {
    parts.push(
      'This league has NO DESIGNATED HITTER — the pitcher bats, ninth. Only eight position ' +
        'players are in the order, there is no place for a bat-only slugger who cannot field, ' +
        'and double switches and pinch-hitting for the pitcher are live tactical questions. ' +
        'Never suggest using someone "at DH".'
    );
  }
  if (!r.hasFreeAgency) {
    parts.push(
      'This league has NO FREE AGENCY — the reserve clause binds players to the club indefinitely. ' +
        'Contracts run a year at a time and simply renew. A player cannot leave for another team, so ' +
        'never advise extending someone "before he reaches the market", and never treat an ending ' +
        'contract as a risk of losing him. The real pressures are salary demands, holdouts, sales and ' +
        'trades between clubs.'
    );
  } else {
    parts.push(`Free agency requires ${r.faMinYears} years of major-league service.`);
  }
  if (r.hasArbitration) parts.push(`Salary arbitration begins at ${r.arbMinYears} years of service.`);
  else if (r.hasFreeAgency) parts.push('This league has no salary arbitration.');
  if (r.minimumSalary > 0) {
    parts.push(`The league minimum salary is ${Math.round(r.minimumSalary).toLocaleString()}.`);
  }
  if (r.financialCoefficient !== 1) {
    parts.push(
      `Money in this league runs at a coefficient of ${r.financialCoefficient} versus a modern league — ` +
        'judge every salary against this league\'s own scale, not modern figures.'
    );
  }
  return parts.join(' ');
}

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

  // Signed-but-not-yet-started extensions. The table carries a row for every
  // player, almost all of them zeroed, so only real terms are worth keeping.
  const extensions = new Map<number, { years: number; startYear: number; firstSalary: number }>();
  if (tableExists('players_contract_extension')) {
    const extRows = db
      .prepare(`SELECT player_id, years, season_year, salary0 FROM players_contract_extension WHERE years > 0`)
      .all() as Array<{ player_id: number; years: number; season_year: number; salary0: number }>;
    for (const e of extRows) {
      extensions.set(e.player_id, {
        years: e.years,
        startYear: e.season_year,
        firstSalary: e.salary0 ?? 0,
      });
    }
  }

  const rows = db.prepare(`SELECT * FROM players_contract`).all() as Array<Record<string, number>>;
  for (const c of rows) {
    const years = c.years ?? 0;
    // current_year counts COMPLETED contract years, so this season's salary is
    // salary{current_year} (0-based) — verified against known deals in a real export
    const completed = c.current_year ?? 0;
    const idx = Math.min(Math.max(completed, 0), 14);
    const endYear = (c.season_year ?? 0) + years - 1;

    const e = extensions.get(c.player_id);
    const extension = e
      ? { years: e.years, startYear: e.startYear, endYear: e.startYear + e.years - 1, firstSalary: e.firstSalary }
      : null;

    out.set(c.player_id, {
      salaryNow: c[`salary${idx}`] ?? 0,
      totalYears: years,
      yearsAfterThis: Math.max(years - completed - 1, 0),
      endYear,
      isMajor: c.is_major === 1,
      noTrade: c.no_trade === 1,
      lastYearTeamOption: c.last_year_team_option === 1,
      lastYearPlayerOption: c.last_year_player_option === 1,
      lastYearVestingOption: c.last_year_vesting_option === 1,
      extension,
      controlledThrough: extension ? Math.max(endYear, extension.endYear) : endYear,
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
