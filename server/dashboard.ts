import { Router } from 'express';
import { db, tableExists } from './db.js';
import { healthOf, HURT_SQL } from './health.js';
import { computeContracts } from './contracts.js';
import { computeProspects } from './org.js';

export const dashboardRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const LEVEL_NAMES: Record<number, string> = { 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R' };
const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };

const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

/** OOTP dates are unpadded (2026-4-9), so lexicographic ORDER BY is wrong. */
export const DATE_KEY = (col: string) => `(
  CAST(substr(${col}, 1, 4) AS INTEGER) * 10000 +
  CAST(substr(${col}, 6, CASE WHEN substr(${col}, 7, 1) = '-' THEN 1 ELSE 2 END) AS INTEGER) * 100 +
  CAST(substr(${col}, 6 + CASE WHEN substr(${col}, 7, 1) = '-' THEN 2 ELSE 3 END) AS INTEGER)
)`;

function playerName(id: number | null): { player_id: number; name: string; throws: string } | null {
  if (!id) return null;
  const p = db
    .prepare(`SELECT player_id, first_name || ' ' || last_name AS name, throws FROM players WHERE player_id = ?`)
    .get(id) as { player_id: number; name: string; throws: number } | undefined;
  return p ? { player_id: p.player_id, name: p.name, throws: HAND[p.throws] ?? '?' } : null;
}

function probableStarter(teamId: number, gameIndex: number) {
  if (!tableExists('projected_starting_pitchers')) return null;
  const row = db
    .prepare(`SELECT * FROM projected_starting_pitchers WHERE team_id = ?`)
    .get(teamId) as Record<string, number> | undefined;
  if (!row) return null;
  return playerName(row[`starter_${Math.min(gameIndex, 7)}`] ?? null);
}

export function nextGames(teamId: number, limit: number) {
  return db
    .prepare(
      `SELECT g.game_id, g.date, g.home_team, g.away_team,
              ${teamLabel.replace(/t\./g, 'ht.')} AS home_label,
              ${teamLabel.replace(/t\./g, 'at2.')} AS away_label
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team
       JOIN teams at2 ON at2.team_id = g.away_team
       WHERE g.played = 0 AND (g.home_team = ? OR g.away_team = ?) AND g.game_type = 0
       ORDER BY ${DATE_KEY('g.date')}, g.time LIMIT ?`
    )
    .all(teamId, teamId, limit) as Array<{
    game_id: number; date: string; home_team: number; away_team: number;
    home_label: string; away_label: string;
  }>;
}

export function orgInjuries(orgId: number) {
  return (
    db
      .prepare(
        `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
                t.level, ${teamLabel} AS team_label,
                p.injury_is_injured, p.injury_dtd_injury, p.injury_left,
                rs.is_on_dl, rs.is_on_dl60, rs.is_active, rs.dl_days_this_year
         FROM players p
         JOIN teams t ON t.team_id = p.team_id
         LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
         WHERE p.organization_id = ? AND p.retired = 0
           AND ${HURT_SQL}
         ORDER BY t.level, p.injury_left DESC`
      )
      .all(orgId) as Array<Record<string, number | string | null>>
  )
    .map((r) => ({ r, health: healthOf(r as Record<string, number | null>) }))
    // The SQL narrows it; healthOf has the final say, so the two agree
    .filter((x) => x.health !== null)
    .map(({ r, health }) => ({
    player_id: r.player_id,
    name: r.name,
    age: r.age,
    positionName: POSITION_NAMES[r.position as number] ?? '?',
    levelName: LEVEL_NAMES[r.level as number] ?? 'R',
    team: r.team_label,
    status: health!.status,
    daysLeft: health!.daysLeft,
    dlDaysThisYear: r.dl_days_this_year ?? null,
  }));
}

dashboardRoutes.get('/injuries/:orgId', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  res.json(orgInjuries(Number(req.params.orgId)));
});

dashboardRoutes.get('/next-game/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('games')) return res.json(null);
  const [game] = nextGames(teamId, 1);
  if (!game) return res.json(null);
  const isHome = game.home_team === teamId;
  const oppId = isHome ? game.away_team : game.home_team;
  res.json({
    date: game.date,
    isHome,
    opponent: isHome ? game.away_label : game.home_label,
    ourStarter: probableStarter(teamId, 0),
    theirStarter: probableStarter(oppId, 0),
  });
});

dashboardRoutes.get('/dashboard/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players') || !tableExists('teams')) {
    return res.status(400).json({ error: 'No data imported yet' });
  }
  const team = db
    .prepare(`SELECT league_id, sub_league_id, division_id FROM teams WHERE team_id = ?`)
    .get(orgId) as { league_id: number; sub_league_id: number; division_id: number } | undefined;
  if (!team) return res.status(404).json({ error: 'Unknown org' });

  // Division standings
  const standings = db
    .prepare(
      `SELECT t.team_id, ${teamLabel} AS team, r.w, r.l, r.pct, r.pos, r.gb, r.streak
       FROM teams t JOIN team_record r ON r.team_id = t.team_id
       WHERE t.league_id = ? AND t.sub_league_id = ? AND t.division_id = ? AND t.level = 1 AND t.allstar_team = 0
       ORDER BY r.pos`
    )
    .all(team.league_id, team.sub_league_id, team.division_id) as Array<Record<string, unknown>>;

  // Last 5 results
  const recent = (
    db
      .prepare(
        `SELECT g.date, g.runs0, g.runs1, g.home_team, g.away_team, g.innings,
                ${teamLabel.replace(/t\./g, 'ht.')} AS home_label,
                ${teamLabel.replace(/t\./g, 'at2.')} AS away_label
         FROM games g
         JOIN teams ht ON ht.team_id = g.home_team
         JOIN teams at2 ON at2.team_id = g.away_team
         WHERE g.played = 1 AND (g.home_team = ? OR g.away_team = ?)
         ORDER BY ${DATE_KEY('g.date')} DESC, g.time DESC LIMIT 5`
      )
      .all(orgId, orgId) as Array<Record<string, number | string>>
  ).map((g) => {
    const isHome = g.home_team === orgId;
    // runs0 = away, runs1 = home (matches starter0/starter1 convention)
    const us = isHome ? (g.runs1 as number) : (g.runs0 as number);
    const them = isHome ? (g.runs0 as number) : (g.runs1 as number);
    return {
      date: g.date,
      opponent: isHome ? g.away_label : g.home_label,
      isHome,
      score: `${us}-${them}`,
      won: us > them,
      innings: g.innings,
    };
  });

  // Next 5 games with our probable starters (and theirs for the next game)
  const upcoming = nextGames(orgId, 5).map((g, i) => {
    const isHome = g.home_team === orgId;
    const oppId = isHome ? g.away_team : g.home_team;
    return {
      date: g.date,
      isHome,
      opponent: isHome ? g.away_label : g.home_label,
      ourStarter: probableStarter(orgId, i),
      theirStarter: i === 0 ? probableStarter(oppId, 0) : null,
    };
  });

  // Hot / cold over the org's last 7 MLB games
  const recentGameIds = (
    db
      .prepare(
        `SELECT game_id FROM games WHERE played = 1 AND (home_team = ? OR away_team = ?)
         ORDER BY ${DATE_KEY('date')} DESC LIMIT 7`
      )
      .all(orgId, orgId) as Array<{ game_id: number }>
  ).map((r) => r.game_id);
  /**
   * Active streaks OOTP is already tracking.
   *
   * The streak table ships 21 unlabelled types. Two were pinned by finding the
   * exact game each one began: a player's type-0 streak starts the day after
   * his last hitless game, and type-9 the day after he last failed to reach
   * base. Only those two are shown — the rest are left alone rather than
   * guessed at and mislabelled.
   */
  const STREAK_HITTING = 0;
  const STREAK_ON_BASE = 9;
  const streaks = tableExists('players_streak')
    ? (
        db
          .prepare(
            `SELECT s.player_id, s.streak_id, s.value, s.started,
                    p.first_name || ' ' || p.last_name AS name, p.position
             FROM players_streak s
             JOIN players p ON p.player_id = s.player_id
             WHERE p.team_id = ? AND s.has_ended = 0
               AND s.streak_id IN (${STREAK_HITTING}, ${STREAK_ON_BASE})
               AND s.value >= 5
             ORDER BY s.value DESC LIMIT 6`
          )
          .all(orgId) as Array<Record<string, number | string>>
      ).map((r) => ({
        player_id: r.player_id,
        name: r.name,
        positionName: POSITION_NAMES[r.position as number] ?? '',
        games: r.value,
        kind: r.streak_id === STREAK_HITTING ? 'hitting streak' : 'on-base streak',
        since: r.started,
      }))
    : [];

  let hot: unknown[] = [];
  let cold: unknown[] = [];
  if (recentGameIds.length >= 3 && tableExists('players_game_batting')) {
    const placeholders = recentGameIds.map(() => '?').join(',');
    const form = (
      db
        .prepare(
          `SELECT b.player_id, p.first_name || ' ' || p.last_name AS name, p.position,
                  SUM(b.pa) AS pa, SUM(b.ab) AS ab, SUM(b.h) AS h, SUM(b.d) AS d, SUM(b.t) AS t3,
                  SUM(b.hr) AS hr, SUM(b.bb) AS bb, SUM(b.hp) AS hp, SUM(b.sf) AS sf
           FROM players_game_batting b
           JOIN players p ON p.player_id = b.player_id
           WHERE b.game_id IN (${placeholders}) AND b.team_id = ?
           GROUP BY b.player_id HAVING SUM(b.pa) >= 12`
        )
        .all(...recentGameIds, orgId) as Array<Record<string, number | string>>
    ).map((r) => {
      const ab = r.ab as number;
      const h = r.h as number;
      const singles = h - (r.d as number) - (r.t3 as number) - (r.hr as number);
      const obpDen = ab + (r.bb as number) + (r.hp as number) + (r.sf as number);
      const obp = obpDen ? (h + (r.bb as number) + (r.hp as number)) / obpDen : 0;
      const slg = ab ? (singles + 2 * (r.d as number) + 3 * (r.t3 as number) + 4 * (r.hr as number)) / ab : 0;
      return {
        player_id: r.player_id,
        name: r.name,
        positionName: POSITION_NAMES[r.position as number] ?? '?',
        pa: r.pa,
        avg: ab ? h / ab : 0,
        ops: obp + slg,
        hr: r.hr,
      };
    });
    form.sort((a, b) => b.ops - a.ops);
    hot = form.slice(0, 3).filter((f) => f.ops >= 0.8);
    cold = form.slice(-3).filter((f) => f.ops < 0.6).reverse();
  }

  // Pending decisions
  let expiring = 0;
  let extensionCandidates = 0;
  try {
    const contracts = computeContracts(orgId);
    for (const p of contracts.players as unknown as Array<{ flags: string[]; recommendation: { action: string } | null }>) {
      if (p.flags.includes('expiring')) expiring++;
      if (p.recommendation?.action === 'Extension candidate' || p.recommendation?.action === 'Extend now') {
        extensionCandidates++;
      }
    }
  } catch { /* contracts table may be absent */ }
  const prospects = computeProspects(orgId);
  const promoteSignals = [...(prospects.batters as Array<{ signal: string | null }>), ...(prospects.pitchers as Array<{ signal: string | null }>)]
    .filter((p) => p.signal !== null).length;
  const injuries = orgInjuries(orgId);
  // Distinct players your staff has raised as trade targets, so the chip counts
  // decisions to make rather than messages received
  const tradeTalk = tableExists('messages')
    ? (db
        .prepare(
          `SELECT COUNT(DISTINCT m.player_id_0) AS n FROM messages m
           JOIN players p ON p.player_id = m.player_id_0
           WHERE m.recipient_id = 1 AND m.sender_type = 0 AND m.deleted = 0
             AND m.team_id_0 != 0 AND m.team_id_1 = ? AND m.player_id_0 != 0
             AND p.retired = 0`
        )
        .get(orgId) as { n: number }).n
    : 0;
  const crunchIssues = tableExists('players_roster_status')
    ? (db
        .prepare(
          `SELECT COUNT(*) AS n FROM players_roster_status rs JOIN players p ON p.player_id = rs.player_id
           WHERE p.organization_id = ? AND (rs.designated_for_assignment = 1 OR rs.is_on_waivers = 1)`
        )
        .get(orgId) as { n: number }).n
    : 0;

  res.json({
    standings,
    recent,
    upcoming,
    hot,
    cold,
    streaks,
    injuries: injuries.slice(0, 8),
    pending: {
      expiring,
      extensionCandidates,
      promoteSignals,
      injuredCount: injuries.length,
      crunchIssues,
      tradeTalk,
    },
  });
});
