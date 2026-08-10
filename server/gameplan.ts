import { Router } from 'express';
import { db, tableExists } from './db.js';
import { contactProfiles } from './battedball.js';
import { padDate } from './rosterops.js';

export const gameplanRoutes = Router();

/**
 * Preparation for one particular game.
 *
 * The schedule already knew who you were playing; it could not tell you
 * anything useful about it. This assembles what a manager would want the night
 * before: who is starting for them, how your hitters have actually fared
 * against that man and against that club, and where the opponent is strong and
 * soft.
 *
 * Head-to-head samples in a single season are tiny, and a .400 average in ten
 * at-bats is noise wearing a suit. Every line here reports its own sample size
 * so it can be discounted honestly rather than quietly averaged into a
 * recommendation.
 */

const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

interface GameRow {
  game_id: number;
  date: string;
  home_team: number;
  away_team: number;
  played: number;
  runs0: number | null;
  runs1: number | null;
  starter0: number | null;
  starter1: number | null;
  game_type: number | null;
}

// The schedule itself is already served by schedule.ts; this module only adds
// the preparation for one game in it.

interface Hitter {
  player_id: number;
  name: string;
  positionName: string;
  bats: string;
}

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/**
 * How our hitters have done against one pitcher, and against one club.
 *
 * Career head-to-head comes from OOTP's own batter-versus-pitcher table; the
 * per-club line is assembled from the at-bat rows, which carry the opposing
 * pitcher and therefore his team.
 */
function matchups(teamId: number, oppTeamId: number, pitcherId: number | null) {
  const hitters = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.position, p.bats
       FROM players p
       WHERE p.team_id = ? AND p.retired = 0 AND p.position != 1
         AND p.player_id IN (SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1)`
    )
    .all(teamId, teamId) as Array<{ player_id: number; name: string; position: number; bats: number }>;

  const ids = hitters.map((h) => h.player_id);
  const byId = new Map<number, Hitter>(
    hitters.map((h) => [
      h.player_id,
      { player_id: h.player_id, name: h.name, positionName: POSITION_NAMES[h.position] ?? '?', bats: HAND[h.bats] ?? '?' },
    ])
  );

  const vsPitcher =
    pitcherId && ids.length > 0 && tableExists('players_individual_batting_stats')
      ? (db
          .prepare(
            `SELECT player_id, SUM(ab) AS ab, SUM(h) AS h, SUM(hr) AS hr
             FROM players_individual_batting_stats
             WHERE opponent_id = ? AND player_id IN (${ids.map(() => '?').join(',')})
             GROUP BY player_id`
          )
          .all(pitcherId, ...ids) as Array<{ player_id: number; ab: number; h: number; hr: number }>)
      : [];

  const vsTeam =
    ids.length > 0 && tableExists('players_at_bat_batting_stats')
      ? (db
          .prepare(
            `SELECT a.player_id,
                    COUNT(*) AS pa,
                    SUM(CASE WHEN a.result IN (6,7,8,9) THEN 1 ELSE 0 END) AS h,
                    SUM(CASE WHEN a.result IN (1,4,5) THEN 1 ELSE 0 END)
                      + SUM(CASE WHEN a.result IN (6,7,8,9) THEN 1 ELSE 0 END) AS ab,
                    SUM(CASE WHEN a.result = 9 THEN 1 ELSE 0 END) AS hr
             FROM players_at_bat_batting_stats a
             JOIN players op ON op.player_id = a.opponent_player_id
             WHERE op.team_id = ? AND a.player_id IN (${ids.map(() => '?').join(',')})
             GROUP BY a.player_id`
          )
          .all(oppTeamId, ...ids) as Array<{ player_id: number; pa: number; h: number; ab: number; hr: number }>)
      : [];

  const avg = (h: number, ab: number): number | null =>
    ab > 0 ? Number((h / ab).toFixed(3)) : null;

  return {
    vsPitcher: vsPitcher
      .filter((r) => r.ab > 0)
      .map((r) => ({ ...byId.get(r.player_id)!, ab: r.ab, h: r.h, hr: r.hr, avg: avg(r.h, r.ab) }))
      .sort((a, b) => b.ab - a.ab),
    vsTeam: vsTeam
      .filter((r) => r.ab > 0)
      .map((r) => ({ ...byId.get(r.player_id)!, ab: r.ab, h: r.h, hr: r.hr, avg: avg(r.h, r.ab) }))
      .sort((a, b) => b.ab - a.ab),
  };
}

/** What the opposing club does well and badly, so the plan has a shape. */
function scoutOpponent(oppTeamId: number) {
  const hitters = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.position, p.bats
       FROM players p
       WHERE p.team_id = ? AND p.retired = 0 AND p.position != 1
         AND p.player_id IN (SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1)`
    )
    .all(oppTeamId, oppTeamId) as Array<{ player_id: number; name: string; position: number; bats: number }>;

  const profiles = contactProfiles(hitters.map((h) => h.player_id));
  const dangerous = hitters
    .map((h) => ({
      player_id: h.player_id,
      name: h.name,
      positionName: POSITION_NAMES[h.position] ?? '?',
      bats: HAND[h.bats] ?? '?',
      ...(profiles.get(h.player_id) ?? {}),
    }))
    .filter((h) => (h.battedBalls ?? 0) >= 40)
    .sort((a, b) => (b.barrelPct ?? 0) - (a.barrelPct ?? 0))
    .slice(0, 5);

  return { dangerous };
}

/**
 * Everything worth knowing before one game.
 *
 * The opposing starter is taken from the game itself when the export names
 * one, and otherwise from OOTP's projected rotation — which is the usual case
 * for a game that has not been played.
 */
gameplanRoutes.get('/game-plan/:teamId/:gameId', (req, res) => {
  const teamId = Number(req.params.teamId);
  const gameId = Number(req.params.gameId);
  if (!tableExists('games')) return res.status(400).json({ error: 'No data imported yet' });

  const g = db
    .prepare(
      `SELECT game_id, date, home_team, away_team, played, runs0, runs1, starter0, starter1
       FROM games WHERE game_id = ?`
    )
    .get(gameId) as GameRow | undefined;
  if (!g) return res.status(404).json({ error: 'No such game' });

  const home = g.home_team === teamId;
  const oppId = home ? g.away_team : g.home_team;
  const opp = db.prepare(`SELECT ${teamLabel} AS label FROM teams t WHERE team_id = ?`).get(oppId) as
    | { label: string }
    | undefined;

  // starter0 is the away side, starter1 the home side
  const namedStarter = home ? g.starter0 : g.starter1;
  const projected =
    !namedStarter && tableExists('projected_starting_pitchers')
      ? (db
          .prepare(`SELECT player_id FROM projected_starting_pitchers WHERE team_id = ? LIMIT 1`)
          .get(oppId) as { player_id: number } | undefined)?.player_id ?? null
      : null;
  const pitcherId = namedStarter || projected;

  const pitcher = pitcherId
    ? (db
        .prepare(
          `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.throws, p.age
           FROM players p WHERE p.player_id = ?`
        )
        .get(pitcherId) as { player_id: number; name: string; throws: number; age: number } | undefined)
    : undefined;

  res.json({
    game: {
      game_id: g.game_id,
      date: padDate(g.date),
      isHome: home,
      played: g.played === 1,
      opponent: { team_id: oppId, label: opp?.label ?? 'Unknown' },
    },
    starter: pitcher
      ? {
          player_id: pitcher.player_id,
          name: pitcher.name,
          throws: HAND[pitcher.throws] ?? '?',
          age: pitcher.age,
          // A projected starter is OOTP's guess and can change; say so
          confirmed: Boolean(namedStarter),
        }
      : null,
    // Which platoon side to build the card against. The lineup builder already
    // ranks hitters by their split, so the page asks it for this hand rather
    // than duplicating the ordering here.
    lineupVs: pitcher ? (HAND[pitcher.throws] === 'L' ? 'l' : 'r') : 'r',
    matchups: matchups(teamId, oppId, pitcherId ?? null),
    opponent: scoutOpponent(oppId),
  });
});
