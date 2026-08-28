import { Router } from 'express';
import { db, tableExists } from './db.js';
import { contractsByPlayer, mlbPercentiler, rosterHoles, teamFinances, valuesByPlayer } from './valuation.js';

export const freeAgentRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

freeAgentRoutes.get('/free-agents/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown org' });

  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const contracts = contractsByPlayer();

  const decorate = (p: {
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    team_label?: string;
  }) => {
    const c = contracts.get(p.player_id);
    return {
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      position: p.position,
      positionName: POSITION_NAMES[p.position] ?? '?',
      team: p.team_label ?? null,
      overallPct: overallPct(p.player_id),
      talentPct: talentPct(p.player_id),
      lastSalary: c?.salaryNow ?? null,
    };
  };

  // Players currently without a club in this org's league
  const currentFAs = (
    db
      .prepare(
        `SELECT player_id, first_name, last_name, age, position FROM players
         WHERE free_agent = 1 AND retired = 0 AND last_league_id = ?`
      )
      .all(org.league_id) as Array<{
      player_id: number; first_name: string; last_name: string; age: number; position: number;
    }>
  ).map(decorate);

  // Contracts around the league that expire after this season — the offseason
  // market. Service-time filter matters: pre-arb/arb players on expiring 1-year
  // deals stay team-controlled and never reach the market.
  const faMinYears =
    (db.prepare(`SELECT rules_fa_minimum_years AS y FROM leagues WHERE league_id = ?`).get(org.league_id) as
      | { y: number }
      | undefined)?.y ?? 6;
  const upcoming = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position,
              CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END AS team_label,
              rs.mlb_service_years AS service_years
       FROM players p
       JOIN teams t ON t.team_id = p.team_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE t.allstar_team = 0 AND t.league_id = ?
         AND p.team_id != ? AND p.retired = 0`
    )
    .all(org.league_id, orgId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    team_label: string; service_years: number | null;
  }>;
  const upcomingFAs = upcoming
    .filter((p) => {
      const c = contracts.get(p.player_id);
      return (
        // A signed extension means he never reaches the market
        c && c.isMajor && c.yearsAfterThis === 0 && !c.extension &&
        !c.lastYearTeamOption && !c.lastYearPlayerOption &&
        (p.service_years ?? 0) >= faMinYears - 1 // crosses the FA threshold during this season
      );
    })
    .map(decorate)
    .filter((p) => (p.overallPct ?? 0) >= 40);

  const byValue = (a: { overallPct: number | null }, b: { overallPct: number | null }) =>
    (b.overallPct ?? -1) - (a.overallPct ?? -1);
  currentFAs.sort(byValue);
  upcomingFAs.sort(byValue);

  res.json({
    finances: teamFinances(orgId),
    holes: rosterHoles(orgId),
    currentFAs,
    upcomingFAs: upcomingFAs.slice(0, 80),
  });
});
