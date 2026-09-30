import { Router } from 'express';
import { db, hasColumns, tableExists } from './db.js';
import {
  LEVEL_NAMES, contractsByPlayer, mlbPercentiler, rosterHoles, teamFinances, valuesByPlayer,
} from './valuation.js';

export const freeAgentRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};


/**
 * A league and everything beneath it.
 *
 * OOTP hangs each affiliate off its parent with `parent_league_id`, and in
 * every save I have seen that is one level deep — but it is walked rather than
 * assumed, because a save that nests further would otherwise lose exactly the
 * players this was written to find.
 */
function organisationLeagues(leagueId: number): number[] {
  if (!tableExists('leagues') || !hasColumns('leagues', 'league_id', 'parent_league_id')) {
    return [leagueId];
  }
  const children = db
    .prepare(`SELECT league_id, parent_league_id FROM leagues`)
    .all() as Array<{ league_id: number; parent_league_id: number | null }>;
  const found = new Set<number>([leagueId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const l of children) {
      if (l.parent_league_id !== null && found.has(l.parent_league_id) && !found.has(l.league_id)) {
        found.add(l.league_id);
        grew = true;
      }
    }
  }
  return [...found];
}

/**
 * Where a free agent was last seen, when that was not the top league.
 *
 * Shown because the answer to "why is this man on my list" is usually "he
 * finished last season at Triple-A", and a list that cannot say so invites the
 * opposite complaint to the one that prompted the fix.
 */
function leagueLabel(
  lastLeagueId: number,
  orgLeagueId: number
): { league: string; level: string } | null {
  if (lastLeagueId === orgLeagueId || !tableExists('leagues')) return null;
  if (!hasColumns('leagues', 'name', 'league_level')) return null;
  const row = db
    .prepare(`SELECT name, league_level FROM leagues WHERE league_id = ?`)
    .get(lastLeagueId) as { name: string; league_level: number } | undefined;
  if (!row) return null;
  // The short form, because the column is narrow and "AAA" is what a manager
  // reads; the league's own name rides along as the tooltip
  return { league: row.name, level: LEVEL_NAMES[row.league_level] ?? `L${row.league_level}` };
}

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

  /*
   * Players currently without a club, anywhere in this organisation's league
   * tree — the majors and every affiliate beneath them.
   *
   * It used to ask for the top league alone, and a reader found what that
   * costs: "Jasson Dominguez is a free agent I am interested in. He does not
   * appear no matter how many times I refresh and download." He had spent the
   * previous season at Triple-A, so his last league was the International
   * League and the list never considered him.
   *
   * He was not an edge case. In my own save the filter hid 2,515 of 4,689 free
   * agents, and the ones at the top of the hidden pile are the ones a manager
   * would actually sign: Jordan Montgomery with nine years of major-league
   * service, Jon Gray with seven, Griffin Canning with seven — all of them
   * veterans who happened to finish the year on a Triple-A roster.
   *
   * Amateurs stay out. A last league of 0 is 1,317 players in that save, aged
   * fourteen to twenty-one with no professional service between them: the
   * draft class and the international pool, which have their own page. They
   * are free agents in the data and not in the sense anybody means here.
   */
  const leagueTree = organisationLeagues(org.league_id);
  const currentFAs = (
    db
      .prepare(
        `SELECT player_id, first_name, last_name, age, position, last_league_id FROM players
         WHERE free_agent = 1 AND retired = 0
           AND last_league_id IN (${leagueTree.map(() => '?').join(',')})`
      )
      .all(...leagueTree) as Array<{
      player_id: number; first_name: string; last_name: string; age: number; position: number;
      last_league_id: number;
    }>
  ).map((p) => ({ ...decorate(p), lastSeen: leagueLabel(p.last_league_id, org.league_id) }));

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
