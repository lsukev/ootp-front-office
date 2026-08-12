import { Router } from 'express';
import { db, tableExists } from './db.js';
import {
  contractsByPlayer, currentGameDate, leagueRules, mlbPercentiler, ON_ROSTER, seasonYear,
  teamFinances, valuesByPlayer,
} from './valuation.js';

export const contractRoutes = Router();

/** Days of major-league service that make one service year. */
export const SERVICE_DAYS_PER_YEAR = 172;

/**
 * How much service a player still on the major-league roster can bank between
 * now and the end of the season, as a fraction of a service year.
 *
 * The export publishes `mlb_service_days_this_year`, so the season's progress
 * is whatever the most-tenured man on a major-league roster has banked: he has
 * been up since Opening Day, so his total is the season's own clock. In the
 * off-season that reaches 172 and nothing is left to earn; before Opening Day
 * it is 0 and a full year remains.
 */
export function serviceRemainingThisSeason(): number {
  if (!tableExists('players_roster_status') || !tableExists('teams')) return 1;
  const row = db
    .prepare(
      `SELECT MAX(rs.mlb_service_days_this_year) AS banked
       FROM players_roster_status rs
       JOIN players p ON p.player_id = rs.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE t.level = 1`
    )
    .get() as { banked: number | null } | undefined;
  const banked = row?.banked;
  // An export without the column behaves as it always did, adding a full year
  if (typeof banked !== 'number' || !Number.isFinite(banked)) return 1;
  return Math.min(Math.max(SERVICE_DAYS_PER_YEAR - banked, 0), SERVICE_DAYS_PER_YEAR) / SERVICE_DAYS_PER_YEAR;
}

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

interface Recommendation {
  action: string;
  reasons: string[];
}

function recommend(args: {
  age: number;
  yearsAfterThis: number;
  reachingFA: boolean;
  hasFreeAgency: boolean;
  overallPct: number | null;
  talentPct: number | null;
  salaryNow: number;
}): Recommendation | null {
  const { age, yearsAfterThis, reachingFA, hasFreeAgency, overallPct, talentPct, salaryNow } = args;
  if (overallPct === null) return null;
  const declining = talentPct !== null && overallPct - talentPct >= 15;

  // Under the reserve clause there is no market to lose a player to, so the
  // question is never "extend before he walks" — it is whether he is worth
  // keeping and what he will hold out for.
  if (!hasFreeAgency) {
    if (overallPct >= 70 && age <= 29) {
      return { action: 'Core keeper', reasons: [`top ${100 - overallPct}% value, prime years ahead — renew`] };
    }
    if (declining && age >= 32) {
      return { action: 'Consider moving', reasons: ['talent slipping below production — sell while value holds'] };
    }
    if (overallPct < 30) {
      return { action: 'Release candidate', reasons: [`bottom ${overallPct}% value`] };
    }
    return null;
  }

  if (yearsAfterThis === 0 && !reachingFA) {
    // Deal ends but the player lacks the service time to leave — auto-renews
    if (overallPct >= 75 && age <= 28) {
      return { action: 'Extension candidate', reasons: ['team-controlled — buy out arb/FA years while cheap'] };
    }
    return null;
  }

  if (yearsAfterThis === 0) {
    // Expiring after this season
    const reasons: string[] = [];
    if (declining) reasons.push('scouted talent below current production — decline risk');
    if (overallPct >= 70 && age <= 29) {
      return { action: 'Extend now', reasons: [`top ${100 - overallPct}% MLB value, prime years ahead`, ...reasons] };
    }
    if (overallPct >= 70 && age <= 33) {
      return { action: 'Re-sign', reasons: [`top ${100 - overallPct}% MLB value`, ...reasons] };
    }
    if (overallPct >= 70) {
      return { action: 'Re-sign short-term', reasons: [`still productive but age ${age} — limit years`, ...reasons] };
    }
    if (overallPct < 40) {
      return { action: 'Let walk', reasons: [`bottom ${overallPct}% MLB value`, ...reasons] };
    }
    return { action: 'Market-dependent', reasons: [`middling value (${overallPct}th pct) — replaceable`, ...reasons] };
  }

  // Not expiring: surface extension candidates and decline warnings
  if (yearsAfterThis <= 2 && overallPct >= 75 && age <= 28) {
    return {
      action: 'Extension candidate',
      reasons: [`${yearsAfterThis} yr${yearsAfterThis === 1 ? '' : 's'} left after this one — buy out prime early`],
    };
  }
  if (declining && age >= 32 && salaryNow >= 10_000_000) {
    return { action: 'Watch decline', reasons: ['expensive veteran with talent slipping below production'] };
  }
  return null;
}

/**
 * What happens to a man when his deal runs out.
 *
 * "Expiring" and "leaving" are not the same thing, and the payroll page was
 * treating them as one: a player with arbitration years left was counted as
 * money coming off the books, when the club still holds him and his salary is
 * about to go up rather than away. A reader reported it, and he is right —
 * the two belong in different columns.
 *
 * Lives here because this is where the service-time reasoning already was.
 * Working out arbitration eligibility twice, in two files, is how the two
 * pages would come to disagree about the same player.
 */
export type ControlStatus =
  | 'signed'          // still under contract next season
  | 'extended'        // an extension already picks him up
  | 'leaving'         // reaches free agency — the money genuinely comes off
  | 'arbitration'     // still controlled, and about to cost more
  | 'pre-arbitration' // still controlled, renewed near the minimum
  | 'reserve clause'; // no free agency in this league; he simply stays

export interface Control {
  status: ControlStatus;
  /** Which arbitration trip this would be, when that is where he lands. */
  arbYear: number | null;
}

export function controlAfterThisSeason(opts: {
  yearsAfterThis: number;
  hasExtension: boolean;
  serviceDays: number | null;
  serviceYears: number | null;
  serviceLeft: number;
  rules: { faMinYears: number; arbMinYears: number; hasFreeAgency: boolean; hasArbitration: boolean };
}): Control {
  const { yearsAfterThis, hasExtension, serviceDays, serviceYears, serviceLeft, rules } = opts;
  if (hasExtension) return { status: 'extended', arbYear: null };
  if (yearsAfterThis > 0) return { status: 'signed', arbYear: null };

  /*
   * Service days are exact where mlb_service_years is truncated to whole
   * years, and only the part of the season still to be played can be added:
   * the banked days already count what he has earned so far.
   */
  const service = serviceDays != null ? serviceDays / SERVICE_DAYS_PER_YEAR : serviceYears ?? 0;
  const projected = service + serviceLeft;

  if (!rules.hasFreeAgency) return { status: 'reserve clause', arbYear: null };
  if (projected >= rules.faMinYears) return { status: 'leaving', arbYear: null };
  if (rules.hasArbitration && projected >= rules.arbMinYears) {
    return { status: 'arbitration', arbYear: Math.floor(projected - rules.arbMinYears) + 1 };
  }
  return { status: 'pre-arbitration', arbYear: null };
}

export function computeContracts(orgId: number) {
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) throw new Error('Unknown org');
  const year = seasonYear(org.league_id);

  const contracts = contractsByPlayer();
  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const rules = leagueRules(org.league_id);
  const { faMinYears, arbMinYears, hasFreeAgency, hasArbitration } = rules;

  const players = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position,
              rs.mlb_service_years AS service_years,
              rs.mlb_service_days AS service_days
       FROM players p
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.team_id = ? AND p.retired = 0 AND ${ON_ROSTER}`
    )
    .all(orgId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    service_years: number | null; service_days: number | null;
  }>;

  const serviceLeft = serviceRemainingThisSeason();

  const rows = players
    .map((p) => {
      const c = contracts.get(p.player_id);
      // Placeholder rows: zero-year deals or ones with no valid end year
      if (!c || c.totalYears < 1 || c.controlledThrough < year) return null;
      // A signed extension is the club's real commitment, so it drives both the
      // years-left column and the recommendation
      const endYear = c.controlledThrough;
      const yearsAfterThis = c.extension
        ? Math.max(c.controlledThrough - year, 0)
        : c.yearsAfterThis;
      // mlb_service_years is truncated to whole years, so it cannot tell a
      // player a week past a threshold from one most of a year past it. Service
      // days are exact — 172 of them make an MLB service year.
      const service =
        p.service_days != null ? p.service_days / SERVICE_DAYS_PER_YEAR : p.service_years ?? 0;
      // Where he lands next winter. Only the part of the season still to be
      // played can be added: mlb_service_days already counts the days banked
      // so far this year, so adding a whole year on top of it pushed players
      // over the free-agency line months before they actually get there, and
      // they were flagged "expiring" while still holding an arbitration year.
      const projected = service + serviceLeft;
      // With no free agency the reserve clause binds him regardless of service,
      // so nobody is ever "reaching" a market
      const reachingFA = hasFreeAgency && projected >= faMinYears;
      // Which arbitration trip this would be, when he is not yet a free agent
      const arbYear =
        hasArbitration && !reachingFA && projected >= arbMinYears
          ? Math.floor(projected - arbMinYears) + 1
          : null;
      const oPct = overallPct(p.player_id);
      const tPct = talentPct(p.player_id);
      const rec = recommend({
        age: p.age,
        yearsAfterThis,
        reachingFA,
        hasFreeAgency,
        overallPct: oPct,
        talentPct: tPct,
        salaryNow: c.salaryNow,
      });
      const flags: string[] = [];
      if (c.extension) {
        // Already locked up beyond the current deal — not a decision to make
        flags.push(`extended thru ${c.extension.endYear}`);
      } else if (yearsAfterThis === 0 && !hasFreeAgency) {
        // The deal ends but he cannot leave — the club simply renews him
        flags.push('reserve clause');
      } else if (yearsAfterThis === 0 && reachingFA) flags.push('expiring');
      else if (yearsAfterThis === 0 && arbYear !== null) {
        // Saying "team control" for an arbitration-eligible player hid the fact
        // that he still has arbitration years left, which read as "expiring"
        flags.push(`arbitration ${arbYear}`);
      } else if (yearsAfterThis === 0) flags.push('pre-arbitration');
      if (c.lastYearTeamOption) flags.push('team option');
      if (c.lastYearPlayerOption) flags.push('player option');
      if (c.lastYearVestingOption) flags.push('vesting option');
      if (c.noTrade) flags.push('no-trade');
      return {
        sortKey: yearsAfterThis + (yearsAfterThis === 0 && !reachingFA ? 0.5 : 0),
        player_id: p.player_id,
        name: `${p.first_name} ${p.last_name}`,
        age: p.age,
        positionName: POSITION_NAMES[p.position] ?? '?',
        salaryNow: c.salaryNow,
        totalYears: c.totalYears,
        yearsAfterThis,
        endYear,
        extension: c.extension,
        serviceYears: Number(service.toFixed(2)),
        arbYear,
        overallPct: oPct,
        talentPct: tPct,
        flags,
        recommendation: rec,
      };
    })
    .filter(Boolean) as Array<{ salaryNow: number; sortKey: number }>;

  rows.sort((a, b) => a.sortKey - b.sortKey || b.salaryNow - a.salaryNow);

  return {
    seasonYear: year,
    gameDate: currentGameDate(org.league_id),
    // Surfaced so the page can explain why it is talking about a reserve
    // clause instead of free agency
    rules,
    finances: teamFinances(orgId),
    players: rows,
  };
}

contractRoutes.get('/contracts/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players') || !tableExists('players_contract')) {
    return res.status(400).json({ error: 'No contract data imported yet' });
  }
  try {
    res.json(computeContracts(Number(req.params.orgId)));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});
