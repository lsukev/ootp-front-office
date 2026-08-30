import { Router } from 'express';
import { db, tableExists } from './db.js';
import { gloves } from './gloves.js';
import { contactLeague, contactProfiles, situationalSplits } from './battedball.js';
import { contractsByPlayer, leagueRules, mlbPercentiler, seasonYear, valuesByPlayer } from './valuation.js';
import { controlAfterThisSeason, serviceRemainingThisSeason } from './contracts.js';
import { playerTransactions, scoutingReport } from './playerfile.js';
import { DATE_KEY } from './dashboard.js';

export const playerRoutes = Router();

/**
 * OOTP ships award IDs with no lookup table, so these were recovered from the
 * data itself and cross-checked against real baseball history: the first year
 * each award appears (MVP 1911, Rookie of the Year 1947, Cy Young 1956, Gold
 * Glove 1957, Silver Slugger 1980, World Series MVP 1955), whether it is
 * position-specific, how many are handed out a year, and whether the winners
 * are pitchers. Aaron Judge's record in an imported real-history save matches
 * his actual honours exactly, which is what confirms the mapping.
 */
const AWARD_NAMES: Record<number, string> = {
  0: 'Player of the Week',
  1: 'Pitcher of the Month',
  2: 'Batter of the Month',
  3: 'Rookie of the Month',
  4: 'Cy Young',
  5: 'MVP',
  6: 'Rookie of the Year',
  7: 'Gold Glove',
  9: 'All-Star',
  11: 'Silver Slugger',
  13: 'Reliever of the Year',
  15: 'World Series MVP',
};

/** The honours worth a line on a career page, biggest first. */
const AWARD_RANK: Record<number, number> = { 5: 1, 4: 2, 15: 3, 6: 4, 13: 5, 11: 6, 7: 7, 9: 8 };

/** Weekly and monthly nods are noise on a career page; season awards are not. */
const SEASON_AWARDS = [4, 5, 6, 7, 9, 11, 13, 15];

/**
 * League-leader categories, recovered the same way: for every category the
 * recorded amount was matched against the actual league-leading value of each
 * candidate stat across ten seasons. Only categories that matched a single
 * column repeatedly are listed — the rate stats (average, ERA) record decimals
 * that this method cannot pin down, so they are left out rather than guessed,
 * and anything unrecognised is simply not shown.
 */
const LEADER_CATEGORIES: Record<number, string> = {
  2: 'at-bats',
  3: 'hits',
  4: 'strikeouts',
  6: 'doubles',
  7: 'triples',
  8: 'home runs',
  9: 'stolen bases',
  10: 'RBI',
  11: 'runs',
  12: 'walks',
  14: 'hit by pitch',
  15: 'sacrifice hits',
  16: 'sacrifice flies',
  27: 'appearances',
  28: 'games started',
  29: 'wins',
  30: 'losses',
  32: 'saves',
  33: 'holds',
  35: 'batters faced',
  36: 'home runs allowed',
  37: 'walks allowed',
  38: 'strikeouts (pitching)',
  39: 'wild pitches',
  54: 'complete games',
  56: 'shutouts',
};

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const ROLE_NAMES: Record<number, string> = { 11: 'SP', 12: 'RP', 13: 'CL' };
const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
/*
 * Deliberately not the shared map. The player card shows a drafted amateur's
 * college and high-school seasons, which OOTP files as levels 10 and 11, and
 * nowhere else has any use for them. Kept local rather than widening the
 * shared one, which would put school years into level pickers that should
 * never offer them.
 */
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
      // The parent club as well as the club. An affiliate's owner is not
      // something a model can know about a simulated league, and it moves
      // between seasons in any save that runs a few
      `SELECT p.*, t.name AS team_name, t.nickname AS team_nickname, t.level AS team_level,
              t.league_id AS team_league,
              o.name AS org_name, o.nickname AS org_nickname
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       LEFT JOIN teams o ON o.team_id = p.organization_id
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
       -- Professional seasons only. A drafted amateur's school year is stored
       -- here under no league, and it belongs to neither the career table nor
       -- the hover card's "what he is doing now" line
       WHERE s.player_id = ? AND s.split_id = 1 AND s.league_id != 0
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
       WHERE s.player_id = ? AND s.split_id = 1 AND s.league_id != 0
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
          // Ordered on the date as a number: OOTP writes them unpadded, and as
          // text the ninth of a month outranks the twenty-third, so the twelve
          // kept here were not always the twelve most recent
          `SELECT date, length, day_to_day FROM players_injury_history
           WHERE player_id = ? ORDER BY ${DATE_KEY('date')} DESC LIMIT 12`
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

  // ── Fielding, by position and season ──────────────────────────────────
  // The card showed scouted fielding ratings but never what the player has
  // actually done in the field, which is the one half of the game the app was
  // silent on.
  const fieldingYears = tableExists('players_career_fielding_stats')
    ? (
        db
          .prepare(
            `SELECT year, level_id, position, SUM(g) AS g, SUM(gs) AS gs, SUM(ip) AS innings,
                    SUM(po) AS po, SUM(a) AS a, SUM(e) AS e, SUM(dp) AS dp
             FROM players_career_fielding_stats
             -- See api.ts: the current season is written with split_id 0
             WHERE player_id = ?
             GROUP BY year, level_id, position
             HAVING SUM(g) > 0
             ORDER BY year DESC, SUM(g) DESC`
          )
          .all(id) as Array<Record<string, number>>
      ).map((f) => {
        const chances = (f.po ?? 0) + (f.a ?? 0) + (f.e ?? 0);
        const innings = f.innings ?? 0;
        return {
          year: f.year,
          // Carried as well as named, so the card can filter on it. The other
          // two history tables keep it by spreading the row; this one builds a
          // fresh object and was dropping it.
          level_id: f.level_id,
          levelName: LEVEL_NAMES[f.level_id] ?? '',
          positionName: POSITION_NAMES[f.position] ?? '?',
          g: f.g,
          gs: f.gs,
          innings,
          po: f.po,
          a: f.a,
          e: f.e,
          dp: f.dp,
          // Fielding percentage, and range factor per nine innings — the two
          // that need no league context to read
          fpct: chances > 0 ? ((f.po ?? 0) + (f.a ?? 0)) / chances : null,
          rf9: innings > 0 ? (((f.po ?? 0) + (f.a ?? 0)) / innings) * 9 : null,
        };
      })
    : [];

  // ── Honours ───────────────────────────────────────────────────────────
  // Season awards only: a career page listing sixty Player of the Week nods
  // buries the MVP among them.
  const awards = tableExists('players_awards')
    ? (
        db
          .prepare(
            `SELECT award_id, year, position FROM players_awards
             WHERE player_id = ? AND award_id IN (${SEASON_AWARDS.join(',')})
             ORDER BY year DESC`
          )
          .all(id) as Array<{ award_id: number; year: number; position: number }>
      ).map((a) => ({
        year: a.year,
        award: AWARD_NAMES[a.award_id] ?? `Award ${a.award_id}`,
        positionName: a.position > 0 ? POSITION_NAMES[a.position] ?? null : null,
        rank: AWARD_RANK[a.award_id] ?? 99,
      }))
    : [];

  // Where he finished in a league category, top three only — "4th in doubles"
  // is not something anyone puts on a plaque.
  const leagueLeader = tableExists('players_league_leader')
    ? (
        db
          .prepare(
            `SELECT year, category, place, amount FROM players_league_leader
             WHERE player_id = ? AND place <= 3 ORDER BY year DESC, place`
          )
          .all(id) as Array<{ year: number; category: number; place: number; amount: number }>
      ).map((l) => ({
        year: l.year,
        category: LEADER_CATEGORIES[l.category] ?? null,
        categoryId: l.category,
        place: l.place,
        amount: l.amount,
      })).filter((l) => l.category !== null)
    : [];

  // Contact quality and the situations he has hit in — both only exist for a
  // man who has actually batted, so a pitcher simply gets nulls
  const contact = isPitcher ? null : (contactProfiles([id]).get(id) ?? null);
  const splits = isPitcher ? [] : situationalSplits(id);

  const earnings = tableExists('players_salary_history')
    ? (db
        .prepare(
          `SELECT SUM(salary) AS total, MIN(year) AS first, MAX(year) AS last
           FROM players_salary_history WHERE player_id = ? AND year > 0`
        )
        .get(id) as { total: number | null; first: number | null; last: number | null })
    : null;

  res.json({
    player_id: id,
    contact,
    careerEarnings: earnings?.total ?? null,
    /*
     * Composed from his own ratings rather than quoted: the export carries no
     * scouting prose at all, and every line here shows the rank behind it.
     */
    scouting: scoutingReport(id, isPitcher),
    /** How he got here, from the same records the transactions page reads. */
    transactions: playerTransactions(id),
    contactLeague: contact ? contactLeague() : null,
    splits,
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
    /** Whose player he is — the parent club, named rather than inferred. */
    organization: p.org_name ? `${p.org_name} ${p.org_nickname}` : (p.free_agent === 1 ? 'Free Agent' : null),
    serviceYears: rosterStatus?.mlb_service_years ?? null,
    overallPct: overallPct(id),
    talentPct: talentPct(id),
    oaRating: values.get(id)?.oaRating ?? null,
    potRating: values.get(id)?.potRating ?? null,
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
    /*
     * Where he can play, and how well, on the same 20-80 scale as the
     * overalls. The card carried the component ratings — range, arm, hands —
     * but never the per-position grades those add up to, which are what a
     * coach actually reads before moving somebody.
     */
    positionRatings: gloves(id)?.positions ?? [],
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
      ? {
          ...contract,
          salarySchedule,
          /*
           * Whether he is leaving or merely at the end of a deal. The card and
           * the staff who read it were shown years-remaining alone, so an
           * arbitration case looked like a man about to reach the market.
           */
          control:
            p.team_league != null
              ? controlAfterThisSeason({
                  yearsAfterThis: contract.yearsAfterThis ?? 0,
                  hasExtension: !!contract.extension,
                  serviceDays: rosterStatus?.mlb_service_days ?? null,
                  serviceYears: rosterStatus?.mlb_service_years ?? null,
                  serviceLeft: serviceRemainingThisSeason(),
                  rules: leagueRules(p.team_league as number),
                })
              : null,
        }
      : null,
    battingYears,
    pitchingYears,
    gameLogs,
    pitchingGameLogs,
    injuryHistory,
    currentInjury,
    awards,
    leagueLeader,
    fieldingYears,
  });
});
