import { db, tableExists, tableColumns } from './db.js';

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

/** OOTP's role code for a starting pitcher. */
export const ROLE_STARTER = 11;

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
/**
 * The dates that govern the season, and how far off each one is.
 *
 * Asked whether to wait a fortnight before selling, the assistant said it had
 * nothing that pinned down the trade deadline and would not guess at a date —
 * honest, and useless, since the save carries every one of these. A calendar
 * is small enough to hand to every voice in the building rather than hide
 * behind a tool one of them might think to call.
 *
 * Dates in the past are kept and marked as passed. Whether the deadline has
 * gone is exactly as useful as when it falls.
 */
export interface CalendarEntry {
  what: string;
  date: string;
  daysAway: number | null;
  passed: boolean;
}

const DATE_COLUMNS: Array<[string, string]> = [
  ['start_date', 'Opening day'],
  ['allstar_date', 'All-Star game'],
  ['draft_date', 'Amateur draft'],
  ['trade_deadline_date', 'Trade deadline'],
  ['roster_expand_date', 'Rosters expand'],
  ['rule_5_draft_date', 'Rule 5 draft'],
  ['international_fa_date', 'International free agency opens'],
];

/** OOTP writes '2026-8-3' as readily as '2026-08-03'. */
function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
}

export function seasonCalendar(leagueId: number): CalendarEntry[] {
  if (!tableExists('leagues')) return [];
  const have = new Set(
    (db.prepare(`PRAGMA table_info(leagues)`).all() as Array<{ name: string }>).map((c) => c.name)
  );
  const wanted = DATE_COLUMNS.filter(([col]) => have.has(col));
  if (wanted.length === 0) return [];

  const row = db
    .prepare(`SELECT ${wanted.map(([c]) => `"${c}"`).join(', ')} FROM leagues WHERE league_id = ?`)
    .get(leagueId) as Record<string, unknown> | undefined;
  if (!row) return [];

  const today = asDate(currentGameDate(leagueId));
  const out: CalendarEntry[] = [];
  for (const [col, what] of wanted) {
    const raw = row[col];
    const when = asDate(raw);
    if (!when || typeof raw !== 'string') continue;
    const daysAway = today
      ? Math.round((when.getTime() - today.getTime()) / 86_400_000)
      : null;
    out.push({ what, date: raw, daysAway, passed: daysAway !== null && daysAway < 0 });
  }
  return out.sort((a, b) => (a.daysAway ?? 0) - (b.daysAway ?? 0));
}

/** The calendar as a line of prose, for a system prompt. */
export function calendarBriefing(leagueId: number): string {
  const entries = seasonCalendar(leagueId);
  if (entries.length === 0) return '';
  const today = currentGameDate(leagueId);
  const said = entries.map((e) => {
    if (e.daysAway === null) return `${e.what} ${e.date}`;
    if (e.passed) return `${e.what} ${e.date} (${Math.abs(e.daysAway)} days ago)`;
    if (e.daysAway === 0) return `${e.what} ${e.date} (today)`;
    return `${e.what} ${e.date} (in ${e.daysAway} days)`;
  });
  return (
    `KEY DATES — today is ${today ?? 'unknown'}. ${said.join('; ')}. ` +
    'These come from the save, so use them rather than assuming the real-world calendar, ' +
    'and never tell the reader you do not know when something falls.'
  );
}

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

/**
 * OOTP's level codes, in one place.
 *
 * Was declared privately in two files and about to be a third. A constant
 * describing how the save encodes something is exactly the kind that drifts
 * quietly once there are copies of it.
 */
export const LEVEL_NAMES: Record<number, string> = {
  1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R',
};

/**
 * The scale OOTP is set to display ratings on.
 *
 * The setting is the user's, not the league's, and the export carries whatever
 * they chose — 20-80, 1-20, 1-10, 2-8 or 1-5 — with no column saying which. A
 * reader running the 1-to-5 scale found his best contact hitter drawn as a
 * sliver, because the bars divided by eighty regardless: a 5 came out at six
 * per cent of the width instead of full.
 *
 * So it is read off the data. The top of the scale is the largest rating
 * anywhere in the file, which needs no setting to be right and is correct for
 * a custom scale nobody has thought of.
 */
let scaleCache: number | null = null;

export function ratingScaleMax(): number {
  if (scaleCache !== null) return scaleCache;
  const columns: Array<[string, string]> = [
    ['players_batting', 'batting_ratings_overall_contact'],
    ['players_batting', 'batting_ratings_overall_power'],
    ['players_pitching', 'pitching_ratings_overall_stuff'],
    ['players_fielding', 'fielding_ratings_infield_range'],
  ];
  let observed = 0;
  for (const [table, column] of columns) {
    if (!tableExists(table)) continue;
    try {
      const row = db.prepare(`SELECT MAX("${column}") AS m FROM "${table}"`).get() as { m: number | null };
      observed = Math.max(observed, Number(row?.m ?? 0));
    } catch {
      // A save without that column simply contributes nothing
    }
  }
  // Snap to the scale OOTP actually offers; nobody tops out at exactly the
  // maximum on a small scale, so the bands are generous at the bottom
  const known = [5, 8, 10, 20, 80];
  scaleCache = known.find((max) => observed <= max) ?? 80;
  return scaleCache;
}

/** Called after an import, since a new save may use a different scale. */
export function clearScaleCache(): void {
  scaleCache = null;
}

export function currentGameDate(leagueId: number): string | null {
  const row = db.prepare(`SELECT "current_date" AS d FROM leagues WHERE league_id = ?`).get(leagueId) as
    | { d: string }
    | undefined;
  return row?.d ?? null;
}

/**
 * These two maps cover every player in the league and were being rebuilt from
 * scratch on every request — a player card reloaded all 12,000 contracts to
 * read one. They only change when a new export is imported, which is exactly
 * when the cache is dropped.
 */
let contractCache: Map<number, ContractInfo> | null = null;
let valueCache: Map<number, PlayerValue> | null = null;

export function clearValuationCaches(): void {
  contractCache = null;
  valueCache = null;
  percentilerCache = null;
}

/** Contracts keyed by player_id. Salary years live in salary0..salary14. */
export function contractsByPlayer(): Map<number, ContractInfo> {
  if (contractCache) return contractCache;
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
  contractCache = out;
  return out;
}

export interface PlayerValue {
  overall: number;
  talent: number;
  /**
   * OOTP's own Overall and Potential on the 20-80 scouting scale — the numbers
   * printed on the player's page in the game. Coarse by design (five-point
   * steps, twelve grades in all), so they are shown for cross-reference and
   * never used for ranking; overall/talent are continuous and role-relative.
   */
  oaRating: number | null;
  potRating: number | null;
  offense: number;
  offenseVsL: number;
  offenseVsR: number;
  pitching: number;
}

export function valuesByPlayer(): Map<number, PlayerValue> {
  if (valueCache) return valueCache;
  const out = new Map<number, PlayerValue>();
  if (!tableExists('players_value')) return out;
  /*
   * Read `oa` and `pot`, not `oa_rating` and `pot_rating`.
   *
   * The export carries both and they are not the same number. `oa` is the
   * grade OOTP prints on the player's page; `oa_rating` is that grade rounded
   * to the nearest five — exactly round(oa/5)*5, which holds for every one of
   * the 12,624 players in this save, and differs for three quarters of them.
   * Reading the rounded one meant the app quietly disagreed with the game
   * about most of the league: a 57 was shown as a 55.
   *
   * The five-step version is not lost — it is what the Settings toggle
   * produces, by rounding, which reproduces oa_rating exactly.
   *
   * Falls back to the rounded column when a save does not carry the exact one,
   * since a coarser grade is worth far more than a page that will not load.
   */
  const valueCols = tableColumns('players_value');
  const oaCol = valueCols.includes('oa') ? 'oa' : 'oa_rating';
  const potCol = valueCols.includes('pot') ? 'pot' : 'pot_rating';
  const rows = db
    .prepare(
      `SELECT player_id, overall_value, talent_value, offensive_value,
              offensive_value_vsl, offensive_value_vsr, pitching_value,
              "${oaCol}" AS oa_rating, "${potCol}" AS pot_rating
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
      oaRating: r.oa_rating ?? null,
      potRating: r.pot_rating ?? null,
    });
  }
  valueCache = out;
  return out;
}

/**
 * Percentile rank (0-100) helpers computed against all players currently on an
 * MLB-level roster — the pool that matters for big-league decisions.
 */
interface Percentiler {
  overallPct: (playerId: number) => number | null;
  talentPct: (playerId: number) => number | null;
}
let percentilerCache: Percentiler | null = null;

/**
 * What these percentiles are, for every prompt that sends them.
 *
 * The GM briefing described a reliever with a 6.51 earned run average as
 * "performing at a 93rd-percentile MLB value" — a claim that figure never
 * made. It was handed the percentile, labelled value, with no statistics
 * beside it, and narrated the only number it had. The fix is both halves: the
 * season line now travels with it, and the prompt says plainly what the number
 * is. Shared because the trade desk sends the same fields.
 */
export const VALUE_PERCENTILE_NOTE =
  'NOTE ON overallPct AND talentPct: these are percentile ranks of OOTP\'s own Value and Talent ' +
  'figures against comparable major leaguers. They are NOT measures of performance. OOTP\'s value ' +
  'counts playing time, so a pitcher who has soaked up innings badly can rank high while pitching ' +
  'poorly. Never describe them as how a player is performing or producing. When a seasonForm is ' +
  'given, that is the performance — quote it, and say so if the two disagree.';

/**
 * Percentile ranks against the players a man actually competes with. Built once
 * per import: it queries every MLB roster and sorts three pools, which is not
 * work repeating for each player card.
 */
export function mlbPercentiler(values: Map<number, PlayerValue>): Percentiler {
  if (percentilerCache) return percentilerCache;
  /*
   * Roster membership, not just the club's id on the player.
   *
   * OOTP parks a signing nobody has assigned yet on the parent club's team_id
   * with no roster entry — the same thing that put sixteen-year-olds from the
   * international complex in the major-league column of the depth chart. They
   * were in these pools too, and a pool is a yardstick: 29 of the 309 arms
   * being called major-league relievers averaged twenty years old, a stuff
   * rating of 26 and a value of 254 against the real men's 841. Every genuine
   * major leaguer was being measured against a field partly made of children,
   * and every percentile in the app read high because of it.
   */
  const rows = db
    .prepare(
      `SELECT p.player_id, p.position, p.role FROM players p
       JOIN teams t ON t.team_id = p.team_id
       JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE t.level = 1 AND t.allstar_team = 0 AND p.retired = 0 AND ${ON_ROSTER}`
    )
    .all() as Array<{ player_id: number; position: number; role: number }>;

  /**
   * Which pool a player is judged against.
   *
   * OOTP's overall_value is value TO THE CLUB, and playing time is baked into
   * it: a closer throws about 65 innings, so his total can never approach a
   * starter's or an everyday player's however good he is. Ranked against all
   * 1,000-odd big leaguers, relievers pile up at the bottom — the league's
   * closers average 879 against 1,067 for starters and 1,097 for position
   * players — and a genuinely good closer reads as below average. Comparing a
   * man to the players he is actually competing with fixes that.
   */
  const groupOf = (position: number, role: number): 'pos' | 'sp' | 'rp' =>
    position !== 1 ? 'pos' : role === ROLE_STARTER ? 'sp' : 'rp';

  const groupById = new Map<number, 'pos' | 'sp' | 'rp'>();
  const pools = {
    pos: { overall: [] as number[], talent: [] as number[] },
    sp: { overall: [] as number[], talent: [] as number[] },
    rp: { overall: [] as number[], talent: [] as number[] },
  };
  for (const r of rows) {
    const g = groupOf(r.position, r.role);
    groupById.set(r.player_id, g);
    const v = values.get(r.player_id);
    if (!v) continue;
    pools[g].overall.push(v.overall);
    pools[g].talent.push(v.talent);
  }
  for (const g of ['pos', 'sp', 'rp'] as const) {
    pools[g].overall.sort((a, b) => a - b);
    pools[g].talent.sort((a, b) => a - b);
  }

  const sortedFor = (id: number, key: 'overall' | 'talent'): number[] => {
    const g = groupById.get(id);
    // Someone off an MLB roster still gets a reading, against the closest pool
    if (g) return pools[g][key];
    const p = db.prepare(`SELECT position, role FROM players WHERE player_id = ?`).get(id) as
      | { position: number; role: number }
      | undefined;
    return pools[p ? groupOf(p.position, p.role) : 'pos'][key];
  };

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
  percentilerCache = {
    overallPct: (id) => pct(sortedFor(id, 'overall'), values.get(id)?.overall),
    talentPct: (id) => pct(sortedFor(id, 'talent'), values.get(id)?.talent),
  };
  return percentilerCache;
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

const HOLE_POSITION_NAMES: Record<number, string> = {
  2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF',
};

/**
 * The org's weakest positions, thinnest first, measured by the best player it
 * currently has at each spot. Used to flag free agents and draft prospects who
 * address a genuine gap.
 */
export function rosterHoles(orgId: number): Array<{ position: number; positionName: string; bestValue: number | null }> {
  const players = db
    .prepare(
      `SELECT p.player_id, p.position FROM players p WHERE p.team_id = ? AND p.retired = 0`
    )
    .all(orgId) as Array<{ player_id: number; position: number }>;
  const values = valuesByPlayer();
  const bestByPos = new Map<number, number>();
  for (const p of players) {
    const v = values.get(p.player_id)?.overall;
    if (v === undefined) continue;
    if (v > (bestByPos.get(p.position) ?? -Infinity)) bestByPos.set(p.position, v);
  }
  const spots = [2, 3, 4, 5, 6, 7, 8, 9];
  return spots
    .map((pos) => ({ position: pos, positionName: HOLE_POSITION_NAMES[pos], bestValue: bestByPos.get(pos) ?? null }))
    .sort((a, b) => (a.bestValue ?? 0) - (b.bestValue ?? 0));
}
