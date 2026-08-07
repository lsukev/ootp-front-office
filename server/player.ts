import { Router } from 'express';
import { db, tableExists } from './db.js';
import { contractsByPlayer, mlbPercentiler, seasonYear, valuesByPlayer } from './valuation.js';
import { DATE_KEY } from './dashboard.js';

export const playerRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const ROLE_NAMES: Record<number, string> = { 11: 'SP', 12: 'RP', 13: 'CL' };
const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
const LEVEL_NAMES: Record<number, string> = { 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R', 10: 'R', 11: 'R' };

const cmToFtIn = (cm: number): string => {
  const totalIn = Math.round(cm / 2.54);
  return `${Math.floor(totalIn / 12)}'${totalIn % 12}"`;
};

/** OOTP's internal velocity index maps ~linearly to mph (verified vs known arms). */
const veloLabel = (v: number | null): string | null =>
  v === null || v <= 0 ? null : `${78 + v}–${80 + v} mph`;

playerRoutes.get('/player/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const p = db
    .prepare(
      `SELECT p.*, t.name AS team_name, t.nickname AS team_nickname, t.level AS team_level,
              t.league_id AS team_league
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.player_id = ?`
    )
    .get(id) as Record<string, unknown> | undefined;
  if (!p) return res.status(404).json({ error: 'Player not found' });

  const batting = db.prepare(`SELECT * FROM players_batting WHERE player_id = ?`).get(id) as
    | Record<string, number>
    | undefined;
  const pitching = db.prepare(`SELECT * FROM players_pitching WHERE player_id = ?`).get(id) as
    | Record<string, number>
    | undefined;
  const fielding = db.prepare(`SELECT * FROM players_fielding WHERE player_id = ?`).get(id) as
    | Record<string, number>
    | undefined;
  const rosterStatus = tableExists('players_roster_status')
    ? (db.prepare(`SELECT * FROM players_roster_status WHERE player_id = ?`).get(id) as
        | Record<string, number>
        | undefined)
    : undefined;

  const isPitcher = p.position === 1;

  // Year-by-year batting, one row per year+team stint
  const batYears = db
    .prepare(
      `SELECT s.year, s.level_id, t.abbr AS team,
              SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d, SUM(s.t) AS t3,
              SUM(s.hr) AS hr, SUM(s.r) AS r, SUM(s.rbi) AS rbi, SUM(s.bb) AS bb, SUM(s.k) AS k,
              SUM(s.sb) AS sb, SUM(s.hp) AS hp, SUM(s.sf) AS sf, ROUND(SUM(s.war), 1) AS war
       FROM players_career_batting_stats s LEFT JOIN teams t ON t.team_id = s.team_id
       WHERE s.player_id = ? AND s.split_id = 1
       GROUP BY s.year, s.team_id ORDER BY s.year DESC, pa DESC`
    )
    .all(id) as Array<Record<string, number | string | null>>;
  const battingYears = batYears
    .filter((y) => ((y.pa as number) ?? 0) > 0)
    .map((y) => {
      const ab = (y.ab as number) || 0;
      const h = (y.h as number) || 0;
      const singles = h - (y.d as number) - (y.t3 as number) - (y.hr as number);
      const obpDen = ab + (y.bb as number) + (y.hp as number) + (y.sf as number);
      return {
        ...y,
        levelName: LEVEL_NAMES[y.level_id as number] ?? `L${y.level_id}`,
        avg: ab ? h / ab : null,
        obp: obpDen ? (h + (y.bb as number) + (y.hp as number)) / obpDen : null,
        slg: ab ? (singles + 2 * (y.d as number) + 3 * (y.t3 as number) + 4 * (y.hr as number)) / ab : null,
      };
    });

  const pitchYears = db
    .prepare(
      `SELECT s.year, s.level_id, t.abbr AS team,
              SUM(s.g) AS g, SUM(s.gs) AS gs, SUM(s.w) AS w, SUM(s.l) AS l, SUM(s.s) AS sv,
              SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.ha) AS ha, SUM(s.bb) AS bb,
              SUM(s.k) AS k, ROUND(SUM(s.war), 1) AS war
       FROM players_career_pitching_stats s LEFT JOIN teams t ON t.team_id = s.team_id
       WHERE s.player_id = ? AND s.split_id = 1
       GROUP BY s.year, s.team_id ORDER BY s.year DESC, outs DESC`
    )
    .all(id) as Array<Record<string, number | string | null>>;
  const pitchingYears = pitchYears
    .filter((y) => ((y.outs as number) ?? 0) > 0)
    .map((y) => {
      const ip = (y.outs as number) / 3;
      return {
        ...y,
        levelName: LEVEL_NAMES[y.level_id as number] ?? `L${y.level_id}`,
        ip: Number(ip.toFixed(1)),
        era: ip ? Number((((y.er as number) / ip) * 9).toFixed(2)) : null,
        whip: ip ? Number((((y.bb as number) + (y.ha as number)) / ip).toFixed(2)) : null,
      };
    });

  // Contract with forward salary schedule
  const contract = contractsByPlayer().get(id) ?? null;
  const contractRow = db.prepare(`SELECT * FROM players_contract WHERE player_id = ?`).get(id) as
    | Record<string, number>
    | undefined;
  let salarySchedule: Array<{ year: number; salary: number }> = [];
  if (contractRow && (contractRow.years ?? 0) >= 1) {
    const completed = contractRow.current_year ?? 0;
    const currentSeason = seasonYear((p.team_league as number) ?? (contractRow.league_id as number));
    for (let i = completed; i < contractRow.years && i <= 14; i++) {
      salarySchedule.push({ year: currentSeason + (i - completed), salary: contractRow[`salary${i}`] ?? 0 });
    }
  }

  // Last 15 game logs (batting and/or pitching), newest first
  let gameLogs: Array<Record<string, unknown>> = [];
  if (tableExists('players_game_batting') && tableExists('games')) {
    try {
      gameLogs = (
        db
          .prepare(
            `SELECT g.date, b.ab, b.h, b.d, b.t AS t3, b.hr, b.rbi, b.r, b.bb, b.k, b.sb,
                    CASE WHEN g.home_team = b.team_id THEN 'vs ' ELSE '@ ' END ||
                    (SELECT abbr FROM teams WHERE team_id = CASE WHEN g.home_team = b.team_id THEN g.away_team ELSE g.home_team END) AS opp
             FROM players_game_batting b JOIN games g ON g.game_id = b.game_id
             WHERE b.player_id = ? AND b.ab + b.bb > 0
             ORDER BY ${DATE_KEY('g.date')} DESC LIMIT 15`
          )
          .all(id) as Array<Record<string, unknown>>
      );
    } catch { /* schema drift — skip logs */ }
  }
  let pitchingGameLogs: Array<Record<string, unknown>> = [];
  if (isPitcher && tableExists('players_game_pitching_stats') && tableExists('games')) {
    try {
      pitchingGameLogs = (
        db
          .prepare(
            `SELECT g.date, s.gs, s.outs, s.er, s.ha, s.bb, s.k,
                    CASE WHEN g.home_team = s.team_id THEN 'vs ' ELSE '@ ' END ||
                    (SELECT abbr FROM teams WHERE team_id = CASE WHEN g.home_team = s.team_id THEN g.away_team ELSE g.home_team END) AS opp
             FROM players_game_pitching_stats s JOIN games g ON g.game_id = s.game_id
             WHERE s.player_id = ? AND s.outs > 0
             ORDER BY ${DATE_KEY('g.date')} DESC LIMIT 10`
          )
          .all(id) as Array<Record<string, number | string>>
      ).map((r) => ({
        date: r.date,
        opp: r.opp,
        gs: r.gs,
        ip: Number(((r.outs as number) / 3).toFixed(1)),
        er: r.er,
        ha: r.ha,
        bb: r.bb,
        k: r.k,
      }));
    } catch { /* schema drift — skip logs */ }
  }

  // Injury history + current status
  let injuryHistory: Array<Record<string, unknown>> = [];
  if (tableExists('players_injury_history')) {
    try {
      injuryHistory = db
        .prepare(
          `SELECT date, length, day_to_day FROM players_injury_history
           WHERE player_id = ? ORDER BY date DESC LIMIT 12`
        )
        .all(id) as Array<Record<string, unknown>>;
    } catch { /* skip */ }
  }
  const currentInjury =
    p.injury_is_injured === 1 || p.injury_dtd_injury === 1
      ? {
          status: p.injury_dtd_injury === 1 && p.injury_is_injured !== 1 ? 'Day-to-day' : 'Injured',
          daysLeft: (p.injury_left as number) ?? null,
        }
      : null;

  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);

  const pitches: Array<{ name: string; rating: number; talent: number }> = [];
  if (pitching) {
    const names = [
      'fastball', 'sinker', 'cutter', 'slider', 'curveball', 'changeup', 'splitter',
      'forkball', 'screwball', 'circlechange', 'knucklecurve', 'knuckleball',
    ];
    for (const n of names) {
      const r = pitching[`pitching_ratings_pitches_${n}`] ?? 0;
      if (r > 0) {
        pitches.push({ name: n, rating: r, talent: pitching[`pitching_ratings_pitches_talent_${n}`] ?? r });
      }
    }
  }

  res.json({
    player_id: id,
    name: `${p.first_name} ${p.last_name}`,
    nickname: (p.nick_name as string) || null,
    age: p.age,
    dob: p.date_of_birth,
    heightWeight: p.height ? `${cmToFtIn(p.height as number)}, ${p.weight} lb` : null,
    bats: HAND[p.bats as number] ?? '?',
    throws: HAND[p.throws as number] ?? '?',
    positionName: POSITION_NAMES[p.position as number] ?? '?',
    roleName: ROLE_NAMES[p.role as number] ?? null,
    uniform: p.uniform_number,
    team: p.team_name
      ? `${p.team_name} ${p.team_nickname}${p.team_level ? ` (${LEVEL_NAMES[p.team_level as number] ?? ''})` : ''}`
      : (p.free_agent === 1 ? 'Free Agent' : null),
    serviceYears: rosterStatus?.mlb_service_years ?? null,
    overallPct: overallPct(id),
    talentPct: talentPct(id),
    isPitcher,
    battingRatings: batting
      ? {
          contact: [batting.batting_ratings_overall_contact, batting.batting_ratings_talent_contact],
          gap: [batting.batting_ratings_overall_gap, batting.batting_ratings_talent_gap],
          power: [batting.batting_ratings_overall_power, batting.batting_ratings_talent_power],
          eye: [batting.batting_ratings_overall_eye, batting.batting_ratings_talent_eye],
          avoidK: [batting.batting_ratings_overall_strikeouts, batting.batting_ratings_talent_strikeouts],
          speed: [batting.running_ratings_speed, batting.running_ratings_speed],
          stealing: [batting.running_ratings_stealing, batting.running_ratings_stealing],
          baserunning: [batting.running_ratings_baserunning, batting.running_ratings_baserunning],
        }
      : null,
    pitchingRatings: pitching
      ? {
          stuff: [pitching.pitching_ratings_overall_stuff, pitching.pitching_ratings_talent_stuff],
          movement: [pitching.pitching_ratings_overall_movement, pitching.pitching_ratings_talent_movement],
          control: [pitching.pitching_ratings_overall_control, pitching.pitching_ratings_talent_control],
          stamina: [pitching.pitching_ratings_misc_stamina, pitching.pitching_ratings_misc_stamina],
        }
      : null,
    velocity: veloLabel(pitching?.pitching_ratings_misc_velocity ?? null),
    pitches,
    fieldingRatings: fielding
      ? {
          infieldRange: fielding.fielding_ratings_infield_range,
          infieldArm: fielding.fielding_ratings_infield_arm,
          turnDP: fielding.fielding_ratings_turn_doubleplay,
          outfieldRange: fielding.fielding_ratings_outfield_range,
          outfieldArm: fielding.fielding_ratings_outfield_arm,
          catcherArm: fielding.fielding_ratings_catcher_arm,
          catcherAbility: fielding.fielding_ratings_catcher_ability,
        }
      : null,
    contract: contract
      ? { ...contract, salarySchedule }
      : null,
    battingYears,
    pitchingYears,
    gameLogs,
    pitchingGameLogs,
    injuryHistory,
    currentInjury,
  });
});
