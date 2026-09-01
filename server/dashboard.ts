import { Router } from 'express';
import { db, hasColumns, tableExists } from './db.js';
import { LEVEL_NAMES, seasonYear } from './valuation.js';
import { playoffPicture } from './playoffs.js';
import { deadlineRead } from './posture.js';
import { healthOf, HURT_SQL, NO_TIMETABLE } from './health.js';
import { computeContracts } from './contracts.js';
import { computeProspects } from './org.js';

export const dashboardRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
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
         -- Longest known absence first, and the men with no date on it after
         -- them rather than above them: sorted on the raw column, forty
         -- placeholders held the top of the list and the real news sat below
         ORDER BY t.level,
                  CASE WHEN p.injury_left >= ${NO_TIMETABLE} THEN 1 ELSE 0 END,
                  p.injury_left DESC`
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
    durationUnknown: health!.durationUnknown,
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
  /*
   * Slot zero, and it is not an approximation.
   *
   * `projected_starting_pitchers` is the rotation as it stands on the export's
   * own date, so starter_0 is whoever pitches next — which for the next game
   * is by definition the man. The schedule's Plan panel counts along the array
   * because it is asked about games several days out; there is nothing to
   * count here, and I briefly "fixed" this by importing that reckoning before
   * working out it can only ever return zero for the next unplayed game.
   */
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
       WHERE t.league_id = ? AND t.sub_league_id = ? AND t.division_id = ? AND t.allstar_team = 0
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
            /*
             * One row per man, not one per streak.
             *
             * A hitter on a run is usually on both at once — reaching base
             * every night and hitting most of them — so he came back twice and
             * the strip spent its six places on three players. On this club it
             * was Bellinger at 9 and 6, Luciano at 7 and 6, and half the panel
             * saying the same two things.
             *
             * The on-base streak is the longer of the two by nature, so simply
             * taking the longest would print "on-base streak" every time and
             * never mention that a man is also hitting. Both are kept and the
             * row says so.
             *
             * The roster filter is here for the same reason the depth chart
             * has one: OOTP parks unassigned signings on the parent club, and
             * a sixteen-year-old on a tear in the complex league is not news
             * from the major-league dashboard.
             */
            /*
             * Three things `has_ended = 0` does not tell you, all of which a
             * reader met at once: "Ed Kaiser shows 17 games on-base active
             * streak, but the game year is 2006 and the streak is from 2001
             * when he played in the feeder prospect league."
             *
             * It is not one league. A man carries a row per competition he has
             * played in, so a run in a feeder league arrives looking exactly
             * like one in the majors. Filtered to the club's own league now.
             *
             * It is not this season. OOTP leaves last year's streaks open
             * rather than closing them at the final out — on my own save 6,994
             * of the rows flagged unfinished began in the season before this
             * one. So the start has to fall in the current season as well.
             *
             * And it is not one row per man per kind. He had "26 game on-base
             * streak · 17-game on-base streak" beside a single name, which is
             * the same streak type from two different leagues printed as
             * though the second were his other kind. The league filter settles
             * that too, and the reduce below no longer assumes it away.
             */
            `SELECT s.player_id, s.streak_id, s.value, s.started,
                    p.first_name || ' ' || p.last_name AS name, p.position
             FROM players_streak s
             JOIN players p ON p.player_id = s.player_id
             WHERE p.team_id = ? AND s.has_ended = 0
               AND s.league_id = ?
               AND CAST(substr(s.started, 1, 4) AS INTEGER) = ?
               AND s.streak_id IN (${STREAK_HITTING}, ${STREAK_ON_BASE})
               AND s.value >= 5
               AND p.player_id IN (
                 SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1
               )
             ORDER BY s.value DESC`
          )
          .all(orgId, team.league_id, seasonYear(team.league_id), orgId) as Array<Record<string, number | string>>
      ).reduce((out: Array<Record<string, unknown>>, r) => {
        const kind = r.streak_id === STREAK_HITTING ? 'hitting' : 'on-base';
        const existing = out.find((x) => x.player_id === r.player_id);
        if (existing) {
          /*
           * The shorter of his two streaks, named beside the longer one — but
           * only where it is the OTHER kind. A second row of the same kind is
           * not a second streak, it is the same man's run in another
           * competition, and printing it here produced "26 game on-base streak
           * · 17-game on-base streak" against one name.
           */
          if (existing.kind !== `${kind} streak` && existing.also === null) {
            existing.also = `${r.value}-game ${kind} streak`;
          }
          return out;
        }
        if (out.length >= 6) return out;
        out.push({
          player_id: r.player_id,
          name: r.name,
          positionName: POSITION_NAMES[r.position as number] ?? '',
          games: r.value,
          kind: `${kind} streak`,
          since: r.started,
          also: null,
        });
        return out;
      }, [])
    : [];

  /*
   * Hot and cold, hitters and pitchers in one list.
   *
   * "The absence of pitchers on Hot/Cold in Front Office is very obvious, and
   * similarly OOTP list is almost void of positional players." Both halves
   * true: this read the batting logs and nothing else, so a staff could be
   * throwing the ball through a wall and the panel would not know.
   *
   * They are put on one scale rather than two columns, because a table where
   * half the rows mean the opposite of the other half is not one table. A
   * hitter is his OPS; a pitcher is the OPS he has allowed — the same
   * arithmetic from the other side of it, and both are in the game logs.
   *
   * Deliberately not ERA. Over a week a reliever throws three innings and one
   * bad one owns the number: on this roster Clarke Schmidt sits at a 9.00
   * earned run average having allowed .375, and Janson Junk at 7.36 having
   * allowed .267. What a pitcher gave up is form; what crossed the plate in
   * three innings is mostly luck.
   */
  let hot: unknown[] = [];
  let cold: unknown[] = [];
  /** Past these a man is worth naming; between them he is having a normal week. */
  const HOT_OPS = 0.8;
  const COLD_OPS = 0.6;
  /** A hitter needs a fortnight of turns; a reliever's whole week is three innings. */
  const MIN_PA = 12;
  const MIN_OUTS = 9;

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
           GROUP BY b.player_id HAVING SUM(b.pa) >= ${MIN_PA}`
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
    /*
     * The same window and the same measure, read from the other side. `tb` and
     * `ab` are on the pitching log, so the OPS a man allowed is arithmetic
     * rather than an estimate.
     */
    const arms =
      tableExists('players_game_pitching_stats') &&
      hasColumns('players_game_pitching_stats', 'ab', 'tb', 'ha', 'bb', 'hp', 'sf', 'outs')
        ? (
            db
              .prepare(
                `SELECT s.player_id, p.first_name || ' ' || p.last_name AS name, p.position,
                        SUM(s.outs) AS outs, SUM(s.ab) AS ab, SUM(s.ha) AS ha, SUM(s.tb) AS tb,
                        SUM(s.bb) AS bb, SUM(s.hp) AS hp, SUM(s.sf) AS sf
                 FROM players_game_pitching_stats s
                 JOIN players p ON p.player_id = s.player_id
                 WHERE s.game_id IN (${placeholders}) AND s.team_id = ?
                 GROUP BY s.player_id HAVING SUM(s.outs) >= ${MIN_OUTS}`
              )
              .all(...recentGameIds, orgId) as Array<Record<string, number | string>>
          ).map((r) => {
            const ab = r.ab as number;
            const obpDen = ab + (r.bb as number) + (r.hp as number) + (r.sf as number);
            const obp = obpDen ? ((r.ha as number) + (r.bb as number) + (r.hp as number)) / obpDen : 0;
            const slg = ab ? (r.tb as number) / ab : 0;
            return {
              player_id: r.player_id,
              name: r.name,
              positionName: POSITION_NAMES[r.position as number] ?? 'P',
              pitcher: true,
              /** Innings, for a reader to discount a small week by. */
              ip: Math.round(((r.outs as number) / 3) * 10) / 10,
              ops: obp + slg,
            };
          })
        : [];

    /*
     * How far past the line he is, so a hitter and a pitcher can be ranked
     * against each other without pretending their numbers mean the same thing.
     */
    const heat = (f: { ops: number; pitcher?: boolean }) =>
      f.pitcher ? COLD_OPS - f.ops : f.ops - HOT_OPS;
    const chill = (f: { ops: number; pitcher?: boolean }) =>
      f.pitcher ? f.ops - HOT_OPS : COLD_OPS - f.ops;

    const everybody = [...form.map((f) => ({ ...f, pitcher: false })), ...arms];
    hot = everybody
      .filter((f) => heat(f) > 0)
      .sort((a, b) => heat(b) - heat(a))
      .slice(0, 4);
    cold = everybody
      .filter((f) => chill(f) > 0)
      .sort((a, b) => chill(b) - chill(a))
      .slice(0, 4);
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
  /*
   * Columns, not just the table. A table that exists with a different set of
   * them passes an existence check and throws on the first query — which is
   * exactly what happened here the moment a leaner `messages` turned up.
   */
  const tradeTalk = hasColumns('messages', 'player_id_0', 'recipient_id', 'sender_type',
                               'deleted', 'team_id_0', 'team_id_1')
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
    // Where the club actually stands for a place, which for most of the league
    // most of the time is not the division race the table above shows
    playoffs: playoffPicture(orgId),
    // Buy, hold or sell, with the arithmetic that produced it
    deadline: deadlineRead(orgId),
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
