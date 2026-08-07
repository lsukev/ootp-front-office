import { Router } from 'express';
import { db, tableExists } from './db.js';
import {
  contractsByPlayer, currentGameDate, mlbPercentiler, seasonYear, teamFinances, valuesByPlayer,
} from './valuation.js';

export const contractRoutes = Router();

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
  overallPct: number | null;
  talentPct: number | null;
  salaryNow: number;
}): Recommendation | null {
  const { age, yearsAfterThis, reachingFA, overallPct, talentPct, salaryNow } = args;
  if (overallPct === null) return null;
  const declining = talentPct !== null && overallPct - talentPct >= 15;

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

export function computeContracts(orgId: number) {
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) throw new Error('Unknown org');
  const year = seasonYear(org.league_id);

  const contracts = contractsByPlayer();
  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const faMinYears =
    (db.prepare(`SELECT rules_fa_minimum_years AS y FROM leagues WHERE league_id = ?`).get(org.league_id) as
      | { y: number }
      | undefined)?.y ?? 6;

  const players = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position,
              rs.mlb_service_years AS service_years
       FROM players p
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.team_id = ? AND p.retired = 0`
    )
    .all(orgId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    service_years: number | null;
  }>;

  const rows = players
    .map((p) => {
      const c = contracts.get(p.player_id);
      // Placeholder rows: zero-year deals or ones with no valid end year
      if (!c || c.totalYears < 1 || c.endYear < year) return null;
      const reachingFA = (p.service_years ?? faMinYears) >= faMinYears - 1;
      const oPct = overallPct(p.player_id);
      const tPct = talentPct(p.player_id);
      const rec = recommend({
        age: p.age,
        yearsAfterThis: c.yearsAfterThis,
        reachingFA,
        overallPct: oPct,
        talentPct: tPct,
        salaryNow: c.salaryNow,
      });
      const flags: string[] = [];
      if (c.yearsAfterThis === 0 && reachingFA) flags.push('expiring');
      else if (c.yearsAfterThis === 0) flags.push('team control');
      if (c.lastYearTeamOption) flags.push('team option');
      if (c.lastYearPlayerOption) flags.push('player option');
      if (c.lastYearVestingOption) flags.push('vesting option');
      if (c.noTrade) flags.push('no-trade');
      return {
        sortKey: c.yearsAfterThis + (c.yearsAfterThis === 0 && !reachingFA ? 0.5 : 0),
        player_id: p.player_id,
        name: `${p.first_name} ${p.last_name}`,
        age: p.age,
        positionName: POSITION_NAMES[p.position] ?? '?',
        salaryNow: c.salaryNow,
        totalYears: c.totalYears,
        yearsAfterThis: c.yearsAfterThis,
        endYear: c.endYear,
        serviceYears: p.service_years,
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
