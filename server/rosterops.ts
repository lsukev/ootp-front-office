import { Router } from 'express';
import { db, tableExists } from './db.js';
import { LEVEL_NAMES, rosterHoles, seasonYear } from './valuation.js';

export const rosterOpsRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

// ── Roster crunch (40-man / options / Rule 5 / DFA) ─────────────────────

rosterOpsRoutes.get('/roster-crunch/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_roster_status')) return res.status(400).json({ error: 'No roster data imported yet' });

  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              t.level, rs.is_active, rs.is_on_secondary, rs.is_on_dl, rs.is_on_dl60,
              rs.options_used, rs.years_protected_from_rule_5, rs.pro_service_years,
              rs.mlb_service_years, rs.designated_for_assignment, rs.days_on_dfa_left,
              rs.is_on_waivers, rs.days_on_waivers_left
       FROM players p
       JOIN players_roster_status rs ON rs.player_id = p.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE p.organization_id = ? AND p.retired = 0`
    )
    .all(orgId) as Array<Record<string, number | string | null>>;

  const players = rows.map((r) => {
    const on26 = r.is_active === 1;
    // Secondary roster = the 40-man; MLB-level IL players also occupy 40-man spots
    const on40 =
      on26 || r.is_on_secondary === 1 ||
      ((r.is_on_dl === 1 || r.is_on_dl60 === 1) && r.level === 1);
    const optionsUsed = (r.options_used as number) ?? 0;
    const outOfOptions = on40 && !on26 && optionsUsed >= 3;
    const rule5Protected = (r.years_protected_from_rule_5 as number) ?? 0;
    const rule5Exposed = !on40 && rule5Protected <= 0 && ((r.pro_service_years as number) ?? 0) >= 4;
    const issues: string[] = [];
    if (r.designated_for_assignment === 1) issues.push(`DFA — ${r.days_on_dfa_left ?? '?'} days to resolve`);
    if (r.is_on_waivers === 1) issues.push(`on waivers — ${r.days_on_waivers_left ?? '?'} days left`);
    if (outOfOptions) issues.push('out of options');
    else if (on40 && !on26 && optionsUsed === 2) issues.push('last option year');
    if (rule5Exposed) issues.push('Rule 5 exposed');
    return {
      player_id: r.player_id,
      name: r.name,
      age: r.age,
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      levelName: LEVEL_NAMES[r.level as number] ?? 'R',
      on26,
      on40,
      optionsUsed,
      rule5Protected,
      issues,
    };
  });

  const fortyMan = players.filter((p) => p.on40);
  const withIssues = players.filter((p) => p.issues.length > 0);
  withIssues.sort((a, b) => b.issues.length - a.issues.length);

  res.json({
    counts: {
      active: players.filter((p) => p.on26).length,
      fortyMan: fortyMan.length,
      issues: withIssues.length,
    },
    issues: withIssues,
    fortyMan: fortyMan.sort((a, b) => (a.on26 === b.on26 ? 0 : a.on26 ? -1 : 1)),
  });
});

// ── Leaderboards ────────────────────────────────────────────────────────

rosterOpsRoutes.get('/leaderboards/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_career_batting_stats')) return res.status(400).json({ error: 'No data imported yet' });
  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!org) return res.status(404).json({ error: 'Unknown org' });
  const year = seasonYear(org.league_id);
  const games = ((db.prepare(`SELECT g FROM team_record WHERE team_id = ?`).get(orgId) as { g: number } | undefined)?.g ?? 20);
  const minPA = Math.round(games * 3.1);
  const minOuts = Math.round(games * 3); // 1 IP per team game

  const bat = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.organization_id AS org,
              t.abbr AS team,
              SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.d) AS d, SUM(s.t) AS t3,
              SUM(s.hr) AS hr, SUM(s.rbi) AS rbi, SUM(s.sb) AS sb, SUM(s.bb) AS bb,
              SUM(s.hp) AS hp, SUM(s.sf) AS sf, ROUND(SUM(s.war), 1) AS war
       FROM players_career_batting_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = 1 AND t.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, org.league_id) as Array<Record<string, number | string>>;
  const withRates = bat.map((r): Record<string, number | string> => {
    const ab = r.ab as number;
    const h = r.h as number;
    const singles = h - (r.d as number) - (r.t3 as number) - (r.hr as number);
    const obpDen = ab + (r.bb as number) + (r.hp as number) + (r.sf as number);
    const obp = obpDen ? (h + (r.bb as number) + (r.hp as number)) / obpDen : 0;
    const slg = ab ? (singles + 2 * (r.d as number) + 3 * (r.t3 as number) + 4 * (r.hr as number)) / ab : 0;
    return { ...r, avg: ab ? h / ab : 0, ops: obp + slg };
  });
  const qualified = withRates.filter((r) => (r.pa as number) >= minPA);
  const top = (
    rows: Array<Record<string, number | string>>,
    key: string,
    dir: 1 | -1 = -1,
    format: (v: number) => string | number = (v) => v
  ) =>
    [...rows]
      .sort((a, b) => dir * ((a[key] as number) - (b[key] as number)))
      .slice(0, 10)
      .map((r) => ({
        player_id: r.player_id, name: r.name, team: r.team,
        value: format(r[key] as number), isOrg: r.org === orgId,
      }));

  const pitch = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.organization_id AS org,
              t.abbr AS team,
              SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.k) AS k, SUM(s.bb) AS bb,
              SUM(s.ha) AS ha, SUM(s.w) AS w, SUM(s.s) AS sv, ROUND(SUM(s.war), 1) AS war
       FROM players_career_pitching_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = 1 AND t.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, org.league_id) as Array<Record<string, number | string>>;
  const withPitchRates = pitch.map((r): Record<string, number | string> => {
    const ip = (r.outs as number) / 3;
    return {
      ...r,
      ip,
      era: ip ? ((r.er as number) / ip) * 9 : 99,
      whip: ip ? ((r.bb as number) + (r.ha as number)) / ip : 99,
    };
  });
  const qualifiedP = withPitchRates.filter((r) => (r.outs as number) >= minOuts);

  const f3 = (v: number) => v.toFixed(3).replace(/^0\./, '.');
  const f2 = (v: number) => v.toFixed(2);
  res.json({
    seasonYear: year,
    minPA,
    minIP: Math.round(minOuts / 3),
    batting: {
      AVG: top(qualified, 'avg', -1, f3),
      OPS: top(qualified, 'ops', -1, f3),
      HR: top(withRates, 'hr'),
      RBI: top(withRates, 'rbi'),
      SB: top(withRates, 'sb'),
      WAR: top(withRates, 'war'),
    },
    pitching: {
      ERA: top(qualifiedP, 'era', 1, f2),
      WHIP: top(qualifiedP, 'whip', 1, f2),
      K: top(withPitchRates, 'k'),
      W: top(withPitchRates, 'w'),
      SV: top(withPitchRates, 'sv'),
      WAR: top(withPitchRates, 'war'),
    },
  });
});

// ── Staff evaluation ────────────────────────────────────────────────────

const COACH_FIELDS: Record<string, Array<[string, string]>> = {
  manager: [
    ['handle_players', 'Handle Players'], ['handle_veterans', 'Handle Veterans'],
    ['handle_rookies', 'Handle Rookies'],
  ],
  general_manager: [],
  pitching_coach: [['teach_pitching', 'Teach Pitching'], ['handle_players', 'Handle Players']],
  hitting_coach: [['teach_hitting', 'Teach Hitting'], ['handle_players', 'Handle Players']],
  bench_coach: [['teach_hitting', 'Teach Hitting'], ['teach_pitching', 'Teach Pitching']],
  head_scout: [
    ['scout_major', 'Scout Majors'], ['scout_minor', 'Scout Minors'],
    ['scout_amateur', 'Scout Amateurs'], ['scout_international', 'Scout Intl'],
  ],
  doctor: [
    ['heal_arms', 'Heal Arms'], ['heal_legs', 'Heal Legs'], ['heal_back', 'Heal Back'],
    ['prevent_arms', 'Prevent Arm Inj.'], ['prevent_legs', 'Prevent Leg Inj.'],
  ],
};
const ROLE_LABELS: Record<string, string> = {
  manager: 'Manager', general_manager: 'General Manager', pitching_coach: 'Pitching Coach',
  hitting_coach: 'Hitting Coach', bench_coach: 'Bench Coach', head_scout: 'Head Scout', doctor: 'Team Doctor',
};

rosterOpsRoutes.get('/staff/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('team_roster_staff') || !tableExists('coaches')) {
    return res.status(400).json({ error: 'No staff data imported yet' });
  }
  const staffRow = db.prepare(`SELECT * FROM team_roster_staff WHERE team_id = ?`).get(orgId) as
    | Record<string, number>
    | undefined;
  if (!staffRow) return res.status(404).json({ error: 'No staff found for this org' });

  const staff = Object.keys(ROLE_LABELS)
    .map((role) => {
      const coachId = staffRow[role];
      if (!coachId) return null;
      const c = db.prepare(`SELECT * FROM coaches WHERE coach_id = ?`).get(coachId) as
        | Record<string, number | string>
        | undefined;
      if (!c) return null;
      return {
        role: ROLE_LABELS[role],
        coach_id: coachId,
        name: `${c.first_name} ${c.last_name}`,
        age: c.age,
        experience: c.experience,
        salary: c.contract_salary,
        yearsLeft: c.contract_years,
        formerPlayer: !!c.former_player_id,
        ratings: COACH_FIELDS[role].map(([field, label]) => ({ label, value: c[field] as number })),
      };
    })
    .filter(Boolean);

  /*
   * The whole farm staff, not just the managers.
   *
   * Every affiliate carries a manager, a pitching coach and a hitting coach,
   * and only one of the three was being shown. The men teaching your prospects
   * to pitch and hit are arguably the ones who matter most down there.
   */
  const affiliates = db
    .prepare(
      `SELECT t.team_id, ${teamLabel} AS team_label, t.level,
              s.manager, s.pitching_coach, s.hitting_coach
       FROM teams t JOIN team_roster_staff s ON s.team_id = t.team_id
       WHERE t.parent_team_id = ? ORDER BY t.level`
    )
    .all(orgId) as Array<{
    team_id: number; team_label: string; level: number;
    manager: number; pitching_coach: number; hitting_coach: number;
  }>;

  const records = new Map(
    (db.prepare(`SELECT team_id, w, l, pct FROM team_record`).all() as Array<{
      team_id: number; w: number; l: number; pct: number;
    }>).map((r) => [r.team_id, r])
  );

  const coachById = (id: number): Record<string, number | string> | undefined =>
    id
      ? (db.prepare(`SELECT * FROM coaches WHERE coach_id = ?`).get(id) as
          | Record<string, number | string>
          | undefined)
      : undefined;

  const FARM_SEATS: Array<[key: 'manager' | 'pitching_coach' | 'hitting_coach', label: string]> = [
    ['manager', 'Manager'],
    ['pitching_coach', 'Pitching Coach'],
    ['hitting_coach', 'Hitting Coach'],
  ];

  const farmStaff = affiliates.map((a) => {
    const rec = records.get(a.team_id);
    return {
      team: a.team_label,
      team_id: a.team_id,
      levelName: LEVEL_NAMES[a.level] ?? 'R',
      record: rec && rec.w + rec.l > 0 ? { w: rec.w, l: rec.l, pct: rec.pct } : null,
      coaches: FARM_SEATS.map(([key, label]) => {
        const c = coachById(a[key]);
        if (!c) return null;
        return {
          role: label,
          coach_id: a[key],
          name: `${c.first_name} ${c.last_name}`,
          age: c.age as number,
          experience: c.experience as number,
          ratings: [
            { label: 'Teach Hitting', value: c.teach_hitting as number },
            { label: 'Teach Pitching', value: c.teach_pitching as number },
            { label: 'Handle Rookies', value: c.handle_rookies as number },
          ],
        };
      }).filter(Boolean),
    };
  });

  /*
   * Who down there is ready for a job up here.
   *
   * OOTP rates every coach for every seat, not only the one he occupies — a
   * hitting coach carries a manager rating too — so each farm man is measured
   * against the incumbent in each major-league seat rather than only against
   * his own. That is what turns this from a list into a decision: your A-ball
   * hitting coach out-rating the man managing your major-league club is worth
   * knowing, and it is not visible anywhere else.
   *
   * The club's record is reported alongside but deliberately not scored into
   * the ranking. A coach does not choose his roster, and a good man on a bad
   * affiliate should not be buried for it.
   */
  const MLB_SEATS: Array<[valueField: string, label: string, occupation: number]> = [
    ['manager_value', 'Manager', 2],
    ['pitching_coach_value', 'Pitching Coach', 4],
    ['hitting_coach_value', 'Hitting Coach', 5],
  ];
  /** Enough of a gap to be worth raising rather than noise in the ratings. */
  const PROMOTION_MARGIN = 10;

  const promotionCandidates = MLB_SEATS.flatMap(([field, label, occupation]) => {
    const incumbent = db
      .prepare(
        `SELECT first_name || ' ' || last_name AS name, "${field}" AS value
         FROM coaches WHERE team_id = ? AND occupation = ? LIMIT 1`
      )
      .get(orgId, occupation) as { name: string; value: number } | undefined;
    if (!incumbent) return [];

    return farmStaff
      .flatMap((club) =>
        (club.coaches as Array<Record<string, unknown>>).map((c) => {
          const full = coachById(c.coach_id as number);
          const value = Number(full?.[field] ?? 0);
          return {
            seat: label,
            incumbent: incumbent.name,
            incumbentValue: incumbent.value,
            coach_id: c.coach_id as number,
            name: c.name as string,
            currentRole: c.role as string,
            team: club.team,
            levelName: club.levelName,
            record: club.record,
            age: c.age as number,
            value,
            gap: value - incumbent.value,
          };
        })
      )
      .filter((c) => c.gap >= PROMOTION_MARGIN);
  }).sort((a, b) => b.gap - a.gap);

  res.json({ staff, farmStaff, promotionCandidates });
});

// ── Draft prep ──────────────────────────────────────────────────────────

/**
 * OOTP writes dates unpadded — "2026-4-12" — which sorts wrong as text. Padding
 * them makes plain string comparison a valid date comparison.
 */
export function padDate(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  // SQLite hands back whatever type the column holds, and a date OOTP left
  // blank arrives as a number. Anything unparseable becomes null rather than
  // throwing — a missing draft date should hide a line, not break the page.
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(raw).trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null;
}

interface DraftLeague {
  league_id: number;
  leagueName: string;
  /** The league runs an amateur draft at all. Reserve-era and custom leagues may not. */
  hasDraft: boolean;
  /**
   * OOTP's own switch for whether the draft pool screen is visible. Gating on
   * this means the app shows a prospect exactly when the game does — before the
   * class is published these players exist in the export but appear on no screen
   * in OOTP, so listing them here invented a scouting report out of thin air.
   */
  poolVisible: boolean;
  gameDate: string | null;
  draftDate: string | null;
  poolDate: string | null;
  combineDate: string | null;
  rounds: number;
}

/**
 * The amateur draft belongs to the top-level league, so an affiliate org has to
 * walk up to its parent before any of these settings mean anything.
 */
function draftLeague(orgId: number): DraftLeague | null {
  const team = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;
  if (!team) return null;

  type Row = {
    league_id: number; name: string; parent_league_id: number | null;
    rules_amateur_draft: number | null; show_draft_pool: number | null;
    draft_date: string | null; rules_amateur_draft_rounds: number | null; today: string | null;
  };
  const fetch = (id: number): Row | undefined =>
    db
      .prepare(
        `SELECT league_id, name, parent_league_id, rules_amateur_draft, show_draft_pool,
                draft_date, rules_amateur_draft_rounds, "current_date" AS today
         FROM leagues WHERE league_id = ?`
      )
      .get(id) as Row | undefined;

  let row = fetch(team.league_id);
  // Affiliates carry rules_amateur_draft = 0; the parent MLB league owns the draft
  const seen = new Set<number>();
  while (row && row.rules_amateur_draft !== 1 && row.parent_league_id && !seen.has(row.league_id)) {
    seen.add(row.league_id);
    row = fetch(row.parent_league_id);
  }
  if (!row) return null;

  // The pool announcement and combine are calendar events rather than columns
  const eventDate = (type: number): string | null => {
    if (!tableExists('league_events')) return null;
    const e = db
      .prepare(
        `SELECT start_date FROM league_events
         WHERE league_id = ? AND type = ? AND deleted = 0
         ORDER BY start_date LIMIT 1`
      )
      .get(row!.league_id, type) as { start_date: string } | undefined;
    return padDate(e?.start_date);
  };

  return {
    league_id: row.league_id,
    leagueName: row.name,
    hasDraft: row.rules_amateur_draft === 1,
    poolVisible: row.rules_amateur_draft === 1 && row.show_draft_pool === 1,
    gameDate: padDate(row.today),
    draftDate: padDate(row.draft_date),
    poolDate: eventDate(3),
    combineDate: eventDate(43),
    rounds: row.rules_amateur_draft_rounds ?? 0,
  };
}

interface Prospect {
  age: number;
  positionName: string;
  school: string;
  isPitcher: boolean;
  cur: number | null;
  pot: number | null;
  upside: number | null;
}

/**
 * A read on a draft prospect, in the same shape the Contracts page uses.
 *
 * Everything here comes from scouted ratings, which for amateurs your staff has
 * barely seen are the noisiest numbers in the game — so the labels describe the
 * KIND of bet a player is rather than pretending to rank them precisely. The
 * roster-need flag is deliberately the weakest signal: a draft pick is years
 * from the majors, and today's thin position rarely predicts the one you will
 * actually be short of when he arrives.
 */
function advise(p: Prospect, thin: Set<string>): { label: string; reasons: string[] } | null {
  const pot = p.pot ?? 0;
  const cur = p.cur ?? 0;
  const upside = p.upside ?? 0;
  if (pot < 45) return null;

  const reasons: string[] = [];
  let label: string;

  if (pot >= 55 && upside >= 15) {
    label = 'High ceiling, long wait';
    reasons.push(`${pot} ceiling, but ${upside} points of it is still projection`);
  } else if (upside <= 8 && cur >= 45) {
    label = 'Close to ready';
    reasons.push(`already at ${cur} of a ${pot} ceiling — least development left`);
  } else if (pot >= 52) {
    label = 'Everyday-regular ceiling';
    reasons.push(`${pot} ceiling`);
  } else {
    label = 'Depth piece';
    reasons.push(`${pot} ceiling — organizational depth rather than a future regular`);
  }

  // Age is read against the class, not the calendar: the draft pool runs 16-25,
  // so the same ceiling at 18 is a much better bet than at 22
  if (p.age <= 18) reasons.push(`only ${p.age} — years of development still ahead`);
  else if (p.age >= 23) reasons.push(`already ${p.age}, old for the class`);

  if (p.school === 'HS') reasons.push('high schooler — further away, more variance');
  if (thin.has(p.positionName)) reasons.push(`${p.positionName} is among your thinnest spots today`);

  return { label, reasons };
}

rosterOpsRoutes.get('/draft/:orgId', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const league = draftLeague(Number(req.params.orgId));
  if (!league) return res.status(404).json({ error: 'Unknown team' });

  // Nothing is read from the players table until OOTP itself publishes the class
  if (!league.poolVisible) {
    return res.json({ ...league, total: 0, batters: [], pitchers: [] });
  }

  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
              p.bats, p.throws, p.college,
              b.batting_ratings_overall_contact AS con, b.batting_ratings_overall_gap AS gap,
              b.batting_ratings_overall_power AS pow, b.batting_ratings_overall_eye AS eye,
              b.batting_ratings_overall_strikeouts AS avk, b.running_ratings_speed AS spd,
              b.batting_ratings_talent_contact AS conP, b.batting_ratings_talent_gap AS gapP,
              b.batting_ratings_talent_power AS powP, b.batting_ratings_talent_eye AS eyeP,
              b.batting_ratings_talent_strikeouts AS avkP,
              pi.pitching_ratings_overall_stuff AS stu, pi.pitching_ratings_overall_movement AS mov,
              pi.pitching_ratings_overall_control AS ctl,
              pi.pitching_ratings_talent_stuff AS stuP, pi.pitching_ratings_talent_movement AS movP,
              pi.pitching_ratings_talent_control AS ctlP
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       WHERE p.draft_eligible = 1 AND p.retired = 0 AND p.hidden = 0`
    )
    .all() as Array<Record<string, number | string | null>>;

  const avg = (vals: Array<number | string | null>): number | null => {
    const nums = vals.filter((v): v is number => typeof v === 'number' && v > 0);
    return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
  };
  const HANDS: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
  const prospects = rows
    .map((r) => {
      const isPitcher = r.position === 1;
      const cur = isPitcher ? avg([r.stu, r.mov, r.ctl]) : avg([r.con, r.gap, r.pow, r.eye, r.avk]);
      const pot = isPitcher
        ? avg([r.stuP, r.movP, r.ctlP])
        : avg([r.conP, r.gapP, r.powP, r.eyeP, r.avkP]);
      return {
        player_id: Number(r.player_id),
        name: String(r.name),
        age: Number(r.age ?? 0),
        positionName: POSITION_NAMES[r.position as number] ?? '?',
        bats: HANDS[r.bats as number] ?? '?',
        throws: HANDS[r.throws as number] ?? '?',
        // hsc_status is a fine-grained class code (4 = high school, 8-10 =
        // college years) that the export ships no lookup table for. The college
        // flag is the part that survives translation.
        school: r.college === 1 ? 'College' : 'HS',
        isPitcher,
        cur,
        pot,
        // How much of the ceiling is still projection rather than present
        // ability. A big gap is upside; it is also risk.
        upside: cur !== null && pot !== null ? pot - cur : null,
        speed: r.spd,
      };
    })
    .filter((p) => p.pot !== null)
    .sort((a, b) => (b.pot ?? 0) - (a.pot ?? 0) || (b.cur ?? 0) - (a.cur ?? 0));

  const needs = rosterHoles(Number(req.params.orgId));
  const thin = new Set(needs.slice(0, 3).map((h): string => h.positionName));

  const withAdvice = prospects.map((p, i) => ({
    ...p,
    // Board rank within the whole class, kept through client-side sorting so a
    // re-sorted table can still say where a player stood on ceiling
    boardRank: i + 1,
    recommendation: advise(p, thin),
  }));

  res.json({
    ...league,
    total: prospects.length,
    needs,
    prospects: withAdvice,
  });
});
