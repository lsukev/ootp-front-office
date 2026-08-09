import { Router } from 'express';
import { db, tableExists } from './db.js';
import { seasonYear } from './valuation.js';

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

  // Players on the club, PLUS anyone this club still pays after a trade or
  // release — contract_team_id points back here while team_id has moved on.
  // Without that dead money the total misses OOTP's own payroll figure: for the
  // sample save it is exactly the $6.19M spread across three departed players.
  const rows = db
    .prepare(
      `SELECT c.*, p.first_name, p.last_name, p.age, p.position, p.retired,
              p.team_id AS current_team_id,
              rs.mlb_service_years AS service_years
       FROM players_contract c
       JOIN players p ON p.player_id = c.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = c.player_id
       WHERE (c.team_id = ? OR c.contract_team_id = ?)
         AND p.retired = 0 AND c.years >= 1`
    )
    .all(orgId, orgId) as Array<ContractRow & {
    first_name: string; last_name: string; age: number; position: number;
    no_trade: number; last_year_team_option: number; last_year_player_option: number;
    last_year_vesting_option: number; service_years: number | null;
    current_team_id: number;
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

  const players = rows
    .map((c) => {
      const extension = extensions.get(c.player_id);
      const byYear = years.map((y) => salaryForYear(c, thisSeason, y, extension));
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
        // Salary owed to someone who no longer plays here
        deadMoney: c.current_team_id !== orgId,
        age: c.age,
        positionName: POSITION_NAMES[c.position] ?? '?',
        salaryNow: byYear[0] ?? 0,
        byYear,
        yearsAfterThis,
        endYear,
        expiring: yearsAfterThis === 0,
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
  const expiringAfterThisYear = players.filter((p) => p.expiring && !p.deadMoney);

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
    deadMoney: {
      total: players.filter((p) => p.deadMoney).reduce((sum, p) => sum + (p.salaryNow ?? 0), 0),
      players: players
        .filter((p) => p.deadMoney)
        .map((p) => ({ player_id: p.player_id, name: p.name, salary: p.salaryNow })),
    },
    commitments: commitments.map((c) => ({
      ...c,
      // Headroom assumes the budget holds flat, which is the only honest
      // assumption available — OOTP does not publish future budgets.
      headroom: budget !== null ? budget - c.total : null,
    })),
    // What comes off the books after this season
    comingOff: {
      count: expiringAfterThisYear.length,
      money: expiringAfterThisYear.reduce((sum, p) => sum + (p.salaryNow ?? 0), 0),
      players: expiringAfterThisYear
        .sort((a, b) => b.salaryNow - a.salaryNow)
        .slice(0, 12)
        .map((p) => ({ player_id: p.player_id, name: p.name, age: p.age, salary: p.salaryNow })),
    },
    players,
  });
});
