import { Router } from 'express';
import { db, tableExists } from './db.js';
import { loadSettings } from './settings.js';
import { leagueRules, seasonYear } from './valuation.js';
import { controlAfterThisSeason, serviceRemainingThisSeason } from './contracts.js';

export const payrollRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/** How many future seasons the commitment curve covers. */
const HORIZON = 6;

interface ContractRow extends Record<string, number> {
  player_id: number;
  years: number;
  current_year: number;
  season_year: number;
}

/** A signed extension that has not started yet; same salary0..14 shape. */
interface ExtensionRow extends Record<string, number> {
  player_id: number;
  years: number;
  season_year: number;
}

/**
 * Salary for a given calendar year. `current_year` counts COMPLETED contract
 * years, so this season sits at salary{current_year} and each future season
 * walks one index further — the same indexing valuation.ts established and
 * verified against real deals.
 */
/**
 * The share of a contract this club is actually paying.
 *
 * `retained` is a percentage, and nothing was reading it as one. A reader
 * acquired a man in a trade whose former club retained all of his salary, and
 * the payroll page listed the full figure as money that would come off the
 * books when he left — money this club was never paying in the first place. My
 * own save has it the other way round and worse: the Yankees retained fifteen
 * per cent of Carlos Rodón and were charged the whole $27.8m of him, an
 * overstatement of twenty-three and a half million.
 *
 * `contract_team_id` is the club of record, which is the one that did the
 * retaining. So it pays its retained share of a man who has gone, and a club
 * holding somebody else's retained player pays the rest. Where nothing was
 * retained this comes to the whole salary either way, which is why a club of
 * record left behind on a man who simply moved — the case the note above
 * describes — still reads correctly.
 */
function payingShare(c: ContractRow & { current_org: number | null; retained: number | null },
                     orgId: number): number {
  const retained = c.retained ?? 0;
  if (retained <= 0) return 1;
  const clubOfRecord = c.contract_team_id === orgId;
  if (clubOfRecord) {
    // He has gone and we kept a share of him; on our own roster we pay it all
    return c.current_org === orgId ? 1 : retained / 100;
  }
  // Somebody else kept a share of a man now on our books, so we pay the rest
  return Math.max(0, 1 - retained / 100);
}

function salaryForYear(
  c: ContractRow,
  thisSeason: number,
  year: number,
  extension?: ExtensionRow
): number | null {
  const completed = c.current_year ?? 0;
  const offset = year - thisSeason;
  const idx = completed + offset;
  const years = c.years ?? 0;
  if (offset < 0 || idx < 0 || idx > 14) return null;
  // Past the final year of the deal the current contract pays nothing more —
  // but a signed extension picks up from its own start year, and leaving it
  // out understated every future season by the whole value of the new deal.
  if (idx > years - 1) {
    if (!extension) return null;
    const extIdx = year - extension.season_year;
    if (extIdx < 0 || extIdx > 14 || extIdx > (extension.years ?? 0) - 1) return null;
    return extension[`salary${extIdx}`] ?? 0;
  }
  return c[`salary${idx}`] ?? 0;
}

payrollRoutes.get('/payroll/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_contract')) return res.status(400).json({ error: 'No data imported yet' });

  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown team' });
  const thisSeason = seasonYear(org.league_id);

  const finances = tableExists('team_financials')
    ? (db
        .prepare(
          `SELECT budget, player_payroll, player_payroll_next_season, cash, market,
                  owner_expectation, total_revenue, total_expenses, budget_balance,
                  cash_trades_available
           FROM team_financials WHERE team_id = ?`
        )
        .get(orgId) as Record<string, number> | undefined) ?? null
    : null;

  // Payroll means major-league contracts, which is what OOTP's own figure
  // counts and how the money actually works: a man on the 40-man optioned to
  // Triple-A is still paid his major-league salary, while a minor-league deal
  // is not payroll at all. Counting every contract in the organization put the
  // total consistently above OOTP's own number.
  //
  // Players in the organization, PLUS anyone this club still pays after a trade
  // or release.
  //
  // Membership is judged on organization_id, NOT team_id: a player optioned to
  // the affiliate keeps the organization but takes the affiliate's team_id, so
  // comparing team_id billed the club's own farmhands as money owed to men who
  // had left.
  //
  // A contract_team_id pointing at another club does NOT by itself mean that
  // club is paying. It is the club of record, and OOTP leaves it behind when a
  // player moves: in the sample save Chase Silseth is charged to the Angels
  // while playing in the Yankees system with nothing retained. Trading a player
  // away without retaining salary hands the whole remaining deal to the club
  // acquiring him, and the old club owes nothing — so the retained flag, not
  // contract_team_id, decides whether money is really owed.
  const rows = db
    .prepare(
      `SELECT c.*, p.first_name, p.last_name, p.age, p.position, p.retired,
              p.team_id AS current_team_id, p.organization_id AS current_org,
              c.retained AS retained,
              rs.mlb_service_years AS service_years, rs.mlb_service_days AS service_days
       FROM players_contract c
       JOIN players p ON p.player_id = c.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = c.player_id
       WHERE p.retired = 0 AND c.years >= 1 AND c.is_major = 1
         AND (p.organization_id = ? OR (c.contract_team_id = ? AND c.retained != 0))`
    )
    .all(orgId, orgId) as Array<ContractRow & {
    first_name: string; last_name: string; age: number; position: number;
    no_trade: number; last_year_team_option: number; last_year_player_option: number;
    last_year_vesting_option: number; service_years: number | null; service_days: number | null;
    current_team_id: number; current_org: number | null; retained: number | null;
  }>;

  // Signed extensions that begin after the current deal expires
  const extensions = new Map<number, ExtensionRow>();
  if (tableExists('players_contract_extension')) {
    const extRows = db
      .prepare(`SELECT * FROM players_contract_extension WHERE years > 0`)
      .all() as ExtensionRow[];
    for (const e of extRows) extensions.set(e.player_id, e);
  }

  const years = Array.from({ length: HORIZON }, (_, i) => thisSeason + i);
  const rules = leagueRules(org.league_id);
  const serviceLeft = serviceRemainingThisSeason();

  const players = rows
    .map((c) => {
      const extension = extensions.get(c.player_id);
      /*
       * Scaled to what this club pays. A retained share is the difference
       * between a payroll figure and a number somebody else is settling.
       */
      const share = payingShare(c, orgId);
      const byYear = years.map((y) => {
        const full = salaryForYear(c, thisSeason, y, extension);
        return full === null ? null : Math.round(full * share);
      });
      const completed = c.current_year ?? 0;
      const contractEnd = (c.season_year ?? thisSeason) + (c.years ?? 0) - 1;
      // An extension keeps him on the books, so he is neither expiring nor
      // "coming off after this season"
      const endYear = extension
        ? Math.max(contractEnd, extension.season_year + extension.years - 1)
        : contractEnd;
      const yearsAfterThis = extension
        ? Math.max(endYear - thisSeason, 0)
        : Math.max((c.years ?? 0) - completed - 1, 0);
      const options: string[] = [];
      if (c.last_year_team_option === 1) options.push('team option');
      if (c.last_year_player_option === 1) options.push('player option');
      if (c.last_year_vesting_option === 1) options.push('vesting option');
      if (c.no_trade === 1) options.push('no-trade');
      return {
        player_id: c.player_id,
        name: `${c.first_name} ${c.last_name}`,
        // Owed to someone who has left AND whose salary this club retained
        deadMoney: c.current_org !== orgId && (c.retained ?? 0) !== 0,
        age: c.age,
        positionName: POSITION_NAMES[c.position] ?? '?',
        salaryNow: byYear[0] ?? 0,
        byYear,
        yearsAfterThis,
        endYear,
        expiring: yearsAfterThis === 0,
        /*
         * What actually happens to him, rather than merely that his deal ends.
         * Arbitration years left is not money coming off the books — the club
         * still holds him and the salary is about to rise, not vanish.
         */
        control: controlAfterThisSeason({
          yearsAfterThis,
          hasExtension: !!extension,
          serviceDays: c.service_days,
          serviceYears: c.service_years,
          serviceLeft,
          rules,
        }),
        options,
        serviceYears: c.service_years,
      };
    })
    .sort((a, b) => (b.salaryNow ?? 0) - (a.salaryNow ?? 0));

  // Committed money per season, and how many players it covers
  const commitments = years.map((year, i) => {
    const withMoney = players.filter((p) => (p.byYear[i] ?? 0) > 0);
    return {
      year,
      total: withMoney.reduce((sum, p) => sum + (p.byYear[i] ?? 0), 0),
      players: withMoney.length,
    };
  });

  const budget = finances?.budget ?? null;
  // What the owner is expected to allow next season. Only a number you have
  // entered counts — otherwise the flat assumption stands, and the response
  // says which of the two produced the headroom below.
  const entered = loadSettings().nextSeasonBudget?.[String(orgId)];
  const nextBudget = typeof entered === 'number' && entered > 0 ? entered : null;
  const endingAfterThisYear = players.filter((p) => p.expiring && !p.deadMoney);
  // Genuinely leaving, against still held but about to cost more
  const leaving = endingAfterThisYear.filter((p) => p.control.status === 'leaving');
  const stillControlled = endingAfterThisYear.filter(
    (p) => p.control.status === 'arbitration' || p.control.status === 'pre-arbitration' || p.control.status === 'reserve clause'
  );
  const brief = (list: typeof players) => ({
    count: list.length,
    money: list.reduce((sum, p) => sum + (p.salaryNow ?? 0), 0),
    players: list
      .slice()
      .sort((a, b) => b.salaryNow - a.salaryNow)
      .slice(0, 12)
      .map((p) => ({
        player_id: p.player_id,
        name: p.name,
        age: p.age,
        salary: p.salaryNow,
        status: p.control.status,
        arbYear: p.control.arbYear,
      })),
  });

  res.json({
    seasonYear: thisSeason,
    years,
    finances: finances
      ? {
          budget: finances.budget ?? 0,
          payroll: finances.player_payroll ?? 0,
          payrollNextSeason: finances.player_payroll_next_season ?? 0,
          cash: finances.cash ?? 0,
          cashTradesAvailable: finances.cash_trades_available ?? 0,
          revenue: finances.total_revenue ?? 0,
          expenses: finances.total_expenses ?? 0,
          budgetBalance: finances.budget_balance ?? 0,
          market: finances.market ?? 0,
          ownerExpectation: finances.owner_expectation ?? 0,
        }
      : null,
    deadMoney: (() => {
      // Only men the club is genuinely still paying. A departed player whose
      // contract has already run out owes nothing and simply is not dead money,
      // however long his old deal lingers in the export.
      const owed = players.filter(
        (p) => p.deadMoney && p.byYear.some((v) => (v ?? 0) > 0)
      );
      return {
        total: owed.reduce((sum, p) => sum + (p.salaryNow ?? 0), 0),
        players: owed.map((p) => ({ player_id: p.player_id, name: p.name, salary: p.salaryNow })),
      };
    })(),
    nextSeasonBudget: nextBudget,
    commitments: commitments.map((c) => ({
      ...c,
      // Seasons after this one measure against the budget you expect, when you
      // have given one. OOTP publishes no future budget, so without an entry
      // the only honest assumption is that today's holds flat.
      headroom:
        (c.year > thisSeason ? (nextBudget ?? budget) : budget) !== null
          ? (c.year > thisSeason ? (nextBudget ?? budget)! : budget!) - c.total
          : null,
      budgetUsed: c.year > thisSeason && nextBudget !== null ? 'expected' : 'flat',
    })),
    /*
     * Two lists, not one. Money only comes off the books when the man leaves;
     * an arbitration case is still yours and is about to get more expensive,
     * which is the opposite of relief.
     */
    comingOff: brief(leaving),
    stillControlled: brief(stillControlled),
    players,
  });
});
