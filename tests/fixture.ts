import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

/**
 * A miniature league, written to a temp directory before the server modules
 * load so they open it instead of the developer's real save.
 *
 * It is hand-built rather than sampled from an export because the point is to
 * pin down the awkward cases: a man optioned to the affiliate, a player traded
 * away with nothing retained, a signed extension that has not started, a league
 * without a designated hitter. Every one of those shipped as a bug.
 */

export const IDS = {
  league: 100,
  mlbTeam: 1,
  aaaTeam: 2,
  otherMlbTeam: 3,
  /** On the major-league roster. */
  starter: 10,
  /** Bats and throws left, so the hand filters have something to find. */
  lefty: 60,
  /** Bats both, and must answer to a search for either side. */
  switcher: 61,
  /** Optioned to Triple-A, still on a major-league contract. */
  optioned: 11,
  /** Traded away, nothing retained — the old club owes nothing. */
  tradedAway: 12,
  /** Released, salary retained — genuinely dead money. */
  retainedGuy: 13,
  /** Signed an extension that begins after the current deal. */
  extended: 14,
  /** On the injured list — the best bat on the roster, and unavailable. */
  injured: 31,
  /** Just drafted out of high school and assigned to the farm. */
  draftee: 32,
  /** Parked on the club with no roster spot; must not appear on the roster. */
  unrostered: 15,
  /** On a minor-league contract — not payroll. */
  minorDeal: 16,
  /**
   * Deliberately sitting on the free-agency boundary: 5.1 years of service with
   * an expiring deal. Adding a whole service year would push him past six and
   * call him expiring; adding only the rest of THIS season leaves him with an
   * arbitration year. The difference is the bug this pins down.
   */
  boundary: 17,
} as const;

export const SEASON = 2030;

function contract(
  db: InstanceType<typeof Database>,
  opts: {
    player: number; team: number; contractTeam: number; years: number; done: number;
    salary: number; isMajor?: number; retained?: number;
  }
): void {
  const salaries = Array.from({ length: 15 }, (_, i) => (i < opts.years ? opts.salary : 0));
  db.prepare(
    `INSERT INTO players_contract
       (player_id, team_id, contract_team_id, season_year, years, current_year, is_major, retained,
        no_trade, last_year_team_option, last_year_player_option, last_year_vesting_option,
        ${salaries.map((_, i) => `salary${i}`).join(', ')})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ${salaries.map(() => '?').join(', ')})`
  ).run(
    opts.player, opts.team, opts.contractTeam, SEASON - opts.done, opts.years, opts.done,
    opts.isMajor ?? 1, opts.retained ?? 0, ...salaries
  );
}

/** Creates the database and returns the directory holding it. */
export function buildFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ootp-fo-test-'));
  const db = new Database(path.join(dir, 'league.db'));

  db.exec(`
    CREATE TABLE leagues (
      league_id INTEGER, name TEXT, abbr TEXT, parent_league_id INTEGER, league_level INTEGER,
      season_year INTEGER, "current_date" TEXT, rules_fa_minimum_years INTEGER,
      rules_salary_arbitration_minimum_years INTEGER, rules_minimum_salary INTEGER,
      financial_coefficient REAL, rules_amateur_draft INTEGER, show_draft_pool INTEGER,
      draft_date TEXT, rules_amateur_draft_rounds INTEGER,
      -- Quoted deliberately: SQLite's own CURRENT_DATE keyword shadows a
      -- column of that name, so an unquoted read returns the real-world date
      trade_deadline_date TEXT,
      -- How long a season is: standings reads it to work out games remaining
      rules_schedule_games_per_team INTEGER DEFAULT 162
    );
    -- Runs for and against, which the buy/hold/sell read takes talent from.
    -- On the pitching side the runs-allowed column is r, not ra
    CREATE TABLE team_batting_stats (
      team_id INTEGER, year INTEGER, split_id INTEGER, level_id INTEGER, g INTEGER, r INTEGER
    );
    CREATE TABLE team_pitching_stats (
      team_id INTEGER, year INTEGER, split_id INTEGER, level_id INTEGER, g INTEGER, r INTEGER
    );
    CREATE TABLE games (
      game_id INTEGER, home_team INTEGER, away_team INTEGER, date TEXT, played INTEGER,
      -- The staff page finds today by asking for the last played game in the
      -- league, so the column has to be here as it is in the export
      league_id INTEGER,
      -- The dashboard orders the fixture list by date then first pitch, and
      -- reads game_type to keep exhibitions out of it
      time INTEGER DEFAULT 1300, game_type INTEGER DEFAULT 0,
      -- Storylines reads the recent results off these
      runs0 INTEGER DEFAULT 0, runs1 INTEGER DEFAULT 0, innings INTEGER DEFAULT 9
    );
    CREATE TABLE sub_leagues (league_id INTEGER, sub_league_id INTEGER, name TEXT, designated_hitter INTEGER);
    -- Standings, the recap and the dashboard all read this; the fixture never
    -- had it, so every one of them was being exercised down its no-divisions
    -- path and the standings endpoint failed outright when a test asked for it
    CREATE TABLE divisions (
      league_id INTEGER, sub_league_id INTEGER, division_id INTEGER, name TEXT, gender INTEGER
    );
    CREATE TABLE teams (
      team_id INTEGER, name TEXT, nickname TEXT, abbr TEXT, level INTEGER, league_id INTEGER,
      sub_league_id INTEGER, division_id INTEGER, parent_team_id INTEGER, allstar_team INTEGER,
      -- Which club the save is being played as. Several endpoints fall back to
      -- it when no team is named, and it was missing here entirely
      human_team INTEGER DEFAULT 0, human_id INTEGER DEFAULT 0,
      -- The club picker reads these for the team colours it themes the app with
      background_color_id TEXT, text_color_id TEXT,
      jersey_secondary_color_id TEXT, ballcaps_main_color_id TEXT
    );
    -- This season's standing. The wild-card race is worked out from it, since
    -- the export carries only the division gb and OOTP's magic number
    CREATE TABLE team_record (
      team_id INTEGER, g INTEGER, w INTEGER, l INTEGER, t INTEGER, pos INTEGER,
      pct REAL, gb REAL, streak INTEGER, magic_number INTEGER
    );
    CREATE TABLE league_playoffs (
      league_id INTEGER, num_wild_cards INTEGER
    );
    -- The club's past, which the Franchise page reads and the staff can now be
    -- asked about
    CREATE TABLE team_history_record (
      team_id INTEGER, year INTEGER, g INTEGER, w INTEGER, l INTEGER, pct REAL,
      pos INTEGER, gb REAL
    );
    CREATE TABLE team_history (
      team_id INTEGER, year INTEGER, name TEXT, made_playoffs INTEGER, won_playoffs INTEGER,
      best_hitter_id INTEGER, best_pitcher_id INTEGER
    );
    CREATE TABLE players (
      player_id INTEGER, first_name TEXT, last_name TEXT, age INTEGER, position INTEGER, role INTEGER,
      bats INTEGER, throws INTEGER, uniform_number INTEGER, team_id INTEGER, organization_id INTEGER,
      retired INTEGER, hidden INTEGER, draft_eligible INTEGER, college INTEGER,
      -- Set once a man has been taken, and stamped with which draft he belongs
      -- to. A universe with high-school and college leagues runs more than one
      picked_in_draft INTEGER DEFAULT 0, draft_league_id INTEGER DEFAULT 0,
      -- School class. A league with its own high-school and college
      -- competitions never sets draft_eligible; eligibility is the class:
      -- 4 is a high-school senior, 9 and 10 the college upperclassmen
      hsc_status INTEGER DEFAULT 0, injury_career_ending INTEGER DEFAULT 0,
      injury_is_injured INTEGER DEFAULT 0, injury_dtd_injury INTEGER DEFAULT 0,
      injury_left INTEGER DEFAULT 0,
      -- Player Search reads this to offer free agents, and had no coverage at
      -- all until the search filters were tested
      free_agent INTEGER DEFAULT 0
    );
    CREATE TABLE players_roster_status (
      player_id INTEGER, is_active INTEGER, is_on_dl INTEGER, is_on_dl60 INTEGER,
      is_on_secondary INTEGER, mlb_service_years REAL, mlb_service_days REAL,
      mlb_service_days_this_year REAL,
      designated_for_assignment INTEGER DEFAULT 0, days_on_dfa_left INTEGER DEFAULT 0,
      is_on_waivers INTEGER DEFAULT 0,
      -- OOTP's trading block: 2 is listed for trade, 0 is everybody else
      trade_status INTEGER DEFAULT 0,
      -- Days spent on the injured list this season, which the dashboard reads
      dl_days_this_year INTEGER DEFAULT 0
    );
    CREATE TABLE team_roster (team_id INTEGER, player_id INTEGER, list_id INTEGER);
    CREATE TABLE human_managers (
      human_manager_id INTEGER, first_name TEXT, last_name TEXT, team_id INTEGER,
      organization_id INTEGER
    );
    CREATE TABLE coaches (
      coach_id INTEGER, first_name TEXT, last_name TEXT, age INTEGER, city_of_birth_id INTEGER,
      nation_id INTEGER, occupation INTEGER, team_id INTEGER, experience INTEGER,
      former_player_id INTEGER, contract_salary INTEGER, contract_years INTEGER,
      teach_hitting INTEGER, teach_pitching INTEGER, scout_amateur INTEGER, scout_major INTEGER,
      handle_players INTEGER, personality INTEGER, player_loyalty INTEGER,
      bunt INTEGER, opener INTEGER, stealing INTEGER, shift_if INTEGER,
      favor_pitching_to_hitting INTEGER, value_stats INTEGER, ratings_value INTEGER,
      trade_aggressiveness INTEGER
    );
    CREATE TABLE players_value (
      player_id INTEGER, overall_value REAL, talent_value REAL, offensive_value REAL,
      offensive_value_vsl REAL, offensive_value_vsr REAL, pitching_value REAL,
      oa_rating REAL, pot_rating REAL, oa REAL, pot REAL
    );
    CREATE TABLE players_contract (
      player_id INTEGER, team_id INTEGER, contract_team_id INTEGER, season_year INTEGER,
      years INTEGER, current_year INTEGER, is_major INTEGER, retained INTEGER,
      no_trade INTEGER, last_year_team_option INTEGER, last_year_player_option INTEGER,
      last_year_vesting_option INTEGER,
      ${Array.from({ length: 15 }, (_, i) => `salary${i} REAL`).join(', ')}
    );
    CREATE TABLE players_contract_extension (
      player_id INTEGER, years INTEGER, season_year INTEGER,
      ${Array.from({ length: 15 }, (_, i) => `salary${i} REAL`).join(', ')}
    );
    CREATE TABLE players_batting (
      player_id INTEGER, batting_ratings_overall_contact INTEGER, batting_ratings_overall_gap INTEGER,
      batting_ratings_overall_power INTEGER, batting_ratings_overall_eye INTEGER,
      batting_ratings_overall_strikeouts INTEGER, running_ratings_speed INTEGER,
      batting_ratings_talent_contact INTEGER, batting_ratings_talent_gap INTEGER,
      batting_ratings_talent_power INTEGER, batting_ratings_talent_eye INTEGER,
      batting_ratings_talent_strikeouts INTEGER
    );
    CREATE TABLE players_pitching (
      player_id INTEGER, pitching_ratings_overall_stuff INTEGER,
      pitching_ratings_overall_movement INTEGER, pitching_ratings_overall_control INTEGER,
      pitching_ratings_talent_stuff INTEGER, pitching_ratings_talent_movement INTEGER,
      pitching_ratings_talent_control INTEGER, pitching_ratings_misc_stamina INTEGER,
      pitching_ratings_misc_velocity INTEGER
    );
    CREATE TABLE players_fielding (
      player_id INTEGER, position INTEGER,
      ${Array.from({ length: 9 }, (_, i) => `fielding_rating_pos${i + 1} INTEGER`).join(', ')},
      ${Array.from({ length: 9 }, (_, i) => `fielding_rating_pos${i + 1}_pot INTEGER`).join(', ')},
      ${Array.from({ length: 10 }, (_, i) => `fielding_experience${i} INTEGER`).join(', ')},
      fielding_ratings_infield_range INTEGER, fielding_ratings_infield_arm INTEGER,
      fielding_ratings_turn_doubleplay INTEGER, fielding_ratings_infield_error INTEGER,
      fielding_ratings_outfield_range INTEGER, fielding_ratings_outfield_arm INTEGER,
      fielding_ratings_outfield_error INTEGER, fielding_ratings_catcher_arm INTEGER,
      fielding_ratings_catcher_ability INTEGER, fielding_ratings_catcher_framing INTEGER
    );
    CREATE TABLE players_career_batting_stats (
      player_id INTEGER, year INTEGER, team_id INTEGER, league_id INTEGER, level_id INTEGER,
      split_id INTEGER, pa INTEGER, ab INTEGER, h INTEGER, d INTEGER, t INTEGER, hr INTEGER,
      bb INTEGER, ibb INTEGER, hp INTEGER, sf INTEGER, k INTEGER, sb INTEGER, cs INTEGER,
      r INTEGER, rbi INTEGER, war REAL
    );
    CREATE TABLE players_career_pitching_stats (
      player_id INTEGER, year INTEGER, team_id INTEGER, league_id INTEGER, level_id INTEGER,
      split_id INTEGER, outs INTEGER, er INTEGER, ra INTEGER, ha INTEGER, bb INTEGER, k INTEGER,
      hra INTEGER, hp INTEGER, bf INTEGER, g INTEGER, gs INTEGER, w INTEGER, l INTEGER,
      s INTEGER, hld INTEGER, war REAL
    );
    -- One row per outing. Rest and recent workload are read from these rather
    -- than from the season line, which is the whole point of the staff page
    CREATE TABLE players_game_pitching_stats (
      player_id INTEGER, game_id INTEGER, pi INTEGER, outs INTEGER, gs INTEGER
    );
    CREATE TABLE players_career_fielding_stats (
      player_id INTEGER, year INTEGER, level_id INTEGER, split_id INTEGER, position INTEGER,
      g INTEGER, gs INTEGER, ip REAL, po INTEGER, a INTEGER, e INTEGER, dp INTEGER
    );
    -- OOTP's own tracked runs. streak_id 0 is a hitting streak and 9 an
    -- on-base one; a hot player is usually carrying both at once
    -- league_id matters: a man carries a row per competition he has played in,
    -- so a run in a feeder league is indistinguishable from one in the majors
    -- until you filter on it. Defaulted to this league so a row that does not
    -- name one is the ordinary case.
    CREATE TABLE players_streak (
      player_id INTEGER, league_id INTEGER DEFAULT 100, streak_id INTEGER, value INTEGER,
      started TEXT, has_ended INTEGER
    );
    -- OOTP's own record of every deal, with the summary already written and
    -- the names marked up as <Name:player#id> so they can be linked
    CREATE TABLE trade_history (
      date TEXT, summary TEXT, message_id INTEGER, team_id_0 INTEGER, team_id_1 INTEGER,
      player_id_0_0 INTEGER, player_id_0_1 INTEGER, player_id_1_0 INTEGER, player_id_1_1 INTEGER
    );
    -- The league's news. Trades appear here as well and are excluded by the id
    -- the trade table carries; what is left is the signings and waiver claims.
    CREATE TABLE messages (
      message_id INTEGER, subject TEXT, date TEXT, message_type INTEGER,
      team_id_0 INTEGER, team_id_1 INTEGER, player_id_0 INTEGER,
      league_id_0 INTEGER, deleted INTEGER DEFAULT 0,
      -- The dashboard counts trade approaches from these: who sent it and to
      -- whom. Present here because a table the app reads should be the shape
      -- the app reads it in
      recipient_id INTEGER DEFAULT 0, sender_type INTEGER DEFAULT 0
    );
    CREATE TABLE projected_starting_pitchers (
      team_id INTEGER, starter_0 INTEGER, starter_1 INTEGER, starter_2 INTEGER, starter_3 INTEGER,
      starter_4 INTEGER, starter_5 INTEGER, starter_6 INTEGER, starter_7 INTEGER
    );
    CREATE TABLE team_financials (
      team_id INTEGER, budget REAL, player_payroll REAL, player_payroll_next_season REAL,
      cash REAL, market REAL, owner_expectation REAL, total_revenue REAL, total_expenses REAL,
      budget_balance REAL, cash_trades_available REAL, fan_interest REAL
    );
  `);

  db.prepare(
    // Columns named rather than positional: adding one to the table above used
    // to break this insert and with it every test in the suite
    `INSERT INTO leagues
       (league_id, name, abbr, parent_league_id, league_level, season_year, "current_date",
        rules_fa_minimum_years, rules_salary_arbitration_minimum_years, rules_minimum_salary,
        financial_coefficient, rules_amateur_draft, show_draft_pool, draft_date,
        rules_amateur_draft_rounds, trade_deadline_date, rules_schedule_games_per_team)
     VALUES (?, 'Test League', 'TL', 0, 1, ?, '2030-06-01', 6, 3, 700000, 1, 1, 1,
             '2030-07-10', 20, '2030-07-31', 162)`
  ).run(IDS.league, SEASON);
  db.prepare(`INSERT INTO sub_leagues VALUES (?, 0, 'Only', 1)`).run(IDS.league);

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team, human_team)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0, ?)`
  );
  team.run(IDS.mlbTeam, 'Test', 'Nine', 'TST', 1, IDS.league, 0, 1);
  team.run(IDS.aaaTeam, 'Farm', 'Hands', 'FRM', 2, IDS.league, IDS.mlbTeam, 0);
  team.run(IDS.otherMlbTeam, 'Other', 'Club', 'OTH', 1, IDS.league, 0, 0);

  // Three seasons behind them, one of which they won
  const past = db.prepare(`INSERT INTO team_history_record VALUES (?, ?, 162, ?, ?, ?, ?, ?)`);
  const pastName = db.prepare(`INSERT INTO team_history VALUES (?, ?, 'Test', ?, ?, NULL, NULL)`);
  for (const [year, w, l, madePlayoffs, wonTitle] of [
    [2023, 95, 67, 1, 1], [2024, 81, 81, 0, 0], [2025, 88, 74, 1, 0],
  ] as number[][]) {
    past.run(IDS.mlbTeam, year, w, l, w / (w + l), madePlayoffs ? 1 : 3, madePlayoffs ? 0 : 8);
    pastName.run(IDS.mlbTeam, year, madePlayoffs, wonTitle);
  }

  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const status = db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, ?, 0, 0, 1, ?, ?, ?)`
  );
  // oa/pot are the exact grades OOTP shows; oa_rating/pot_rating are those
  // rounded to fives, which is the relationship in a real export
  const value = db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, ?, ?, 100, 100, 100, ?, ?, ?, ?, ?)`
  );
  const roster = db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`);

  //                 id            first        last         age pos role  num team           org
  player.run(IDS.starter, 'Reg', 'Ular', 28, 6, 0, 1, IDS.mlbTeam, IDS.mlbTeam);

  /*
   * Somebody who does not bat right-handed. Every other player here does, so a
   * search for left-handed hitters returned nothing and read as a broken
   * filter — and the switch hitter is the one that matters, because he must
   * answer to a search for either side.
   */
  const handed = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, ?, ?, ?, ?, 0, ?, ?, 60, ?, ?, 0, 0, 0, 0)`
  );
  handed.run(IDS.lefty, 'Lefty', 'Swinger', 27, 6, 2, 2, IDS.mlbTeam, IDS.mlbTeam);
  handed.run(IDS.switcher, 'Switch', 'Hitter', 24, 6, 3, 1, IDS.mlbTeam, IDS.mlbTeam);
  player.run(IDS.optioned, 'Op', 'Tioned', 23, 6, 0, 2, IDS.aaaTeam, IDS.mlbTeam);
  player.run(IDS.tradedAway, 'Gone', 'Away', 30, 3, 0, 3, IDS.otherMlbTeam, IDS.otherMlbTeam);
  player.run(IDS.retainedGuy, 'Paid', 'Off', 33, 3, 0, 4, IDS.otherMlbTeam, IDS.otherMlbTeam);
  player.run(IDS.extended, 'Locked', 'Up', 26, 1, 11, 5, IDS.mlbTeam, IDS.mlbTeam);
  player.run(IDS.unrostered, 'No', 'Spot', 19, 7, 0, 6, IDS.mlbTeam, IDS.mlbTeam);
  player.run(IDS.minorDeal, 'Minor', 'Deal', 22, 4, 0, 7, IDS.aaaTeam, IDS.mlbTeam);

  // Service: the regular is mid-arbitration, the extended man is close to free agency
  status.run(IDS.starter, 1, 4.0, 4 * 172 + 40, 40);
  status.run(IDS.optioned, 0, 1.0, 172, 40);
  status.run(IDS.tradedAway, 1, 8.0, 8 * 172, 40);
  status.run(IDS.retainedGuy, 0, 9.0, 9 * 172, 0);
  status.run(IDS.extended, 1, 5.2, Math.round(5.2 * 172), 40);
  status.run(IDS.unrostered, 0, 0, 0, 0);
  status.run(IDS.minorDeal, 0, 0, 0, 0);

  for (const [id, overall, talent, oa] of [
    [IDS.starter, 1200, 1300, 60], [IDS.optioned, 800, 1400, 45],
    [IDS.tradedAway, 900, 850, 50], [IDS.retainedGuy, 400, 380, 35],
    [IDS.extended, 1500, 1500, 70], [IDS.unrostered, 200, 900, 20],
    [IDS.minorDeal, 300, 700, 30],
  ] as const) {
    value.run(id, overall, talent, overall, oa, oa, oa, oa);
  }

  // Only these are on the club's roster list; the unrostered man is not
  roster.run(IDS.mlbTeam, IDS.starter);
  roster.run(IDS.mlbTeam, IDS.extended);
  /*
   * The other club's men are rostered too. Being on a roster is what tells an
   * assigned player from a signing nobody has placed yet, so a fixture where
   * nobody is rostered makes every club look full of unassigned teenagers.
   */
  roster.run(IDS.otherMlbTeam, IDS.tradedAway);
  roster.run(IDS.otherMlbTeam, IDS.retainedGuy);
  roster.run(IDS.aaaTeam, IDS.optioned);
  roster.run(IDS.aaaTeam, IDS.minorDeal);

  // A full nine, so a lineup can actually be built. Positions 2-9 plus a
  // pitcher; ratings descend so the ordering is deterministic.
  const fielders: Array<[id: number, pos: number, last: string]> = [
    [20, 2, 'Catcher'], [21, 3, 'First'], [22, 4, 'Second'], [23, 5, 'Third'],
    [24, 7, 'Leftie'], [25, 8, 'Centre'], [26, 9, 'Rightie'], [27, 10, 'Designated'],
  ];
  for (const [i, [id, pos, last]] of fielders.entries()) {
    player.run(id, 'Fill', last, 27, pos, 0, 20 + i, IDS.mlbTeam, IDS.mlbTeam);
    status.run(id, 1, 3.0, 3 * 172, 40);
    value.run(id, 900 - i * 10, 900 - i * 10, 900 - i * 10, 50, 50, 50, 50);
    roster.run(IDS.mlbTeam, id);
    contract(db, {
      player: id, team: IDS.mlbTeam, contractTeam: IDS.mlbTeam, years: 2, done: 0, salary: 900_000,
    });
  }

  player.run(IDS.boundary, 'Near', 'Boundary', 29, 6, 0, 30, IDS.mlbTeam, IDS.mlbTeam);
  status.run(IDS.boundary, 1, 5.0, Math.round(5.1 * 172), 40);
  value.run(IDS.boundary, 1000, 1000, 1000, 55, 55, 55, 55);
  roster.run(IDS.mlbTeam, IDS.boundary);
  contract(db, {
    player: IDS.boundary, team: IDS.mlbTeam, contractTeam: IDS.mlbTeam,
    years: 1, done: 0, salary: 4_000_000,
  });

  // The best bat on the roster, and on the injured list. A lineup that starts
  // him is unmistakable, and one that drops him without saying so is worse.
  player.run(IDS.injured, 'Hurt', 'Star', 29, 9, 0, 31, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(
    `UPDATE players SET injury_is_injured = 1, injury_left = 12 WHERE player_id = ?`
  ).run(IDS.injured);
  db.prepare(
    `INSERT INTO players_roster_status
       (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
        mlb_service_years, mlb_service_days, mlb_service_days_this_year)
     VALUES (?, 0, 1, 0, 1, 4.0, ?, 40)`
  ).run(IDS.injured, 4 * 172);
  // Exact 62, which OOTP would round to 60 — the case the app used to show
  value.run(IDS.injured, 2000, 2000, 2000, 60, 60, 62, 62);
  roster.run(IDS.mlbTeam, IDS.injured);
  contract(db, {
    player: IDS.injured, team: IDS.mlbTeam, contractTeam: IDS.mlbTeam,
    years: 3, done: 0, salary: 20_000_000,
  });

  // A manager with a playing career and firm opinions, so the persona built
  // from him can be checked against facts rather than vibes
  db.prepare(
    `INSERT INTO coaches VALUES (900, 'Skip', 'Ratchet', 58, 0, 0, 2, ?, 12, ?, 1500000, 2,
                                 130, 40, 0, 0, 140, 3, 5, -4, -5, 4, 0, 5, 8, -2, 0)`
  ).run(IDS.mlbTeam, IDS.starter);

  // The front office, so the voice the trade desk answers in can be checked.
  // The general manager is somebody else here; the assistant is the fallback
  // for a save where the human took the job himself.
  db.prepare(
    `INSERT INTO coaches VALUES (901, 'Web', 'Ivey', 55, 0, 0, 1, ?, 20, 0, 900000, 3,
                                 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 4, 7, -1, 6)`
  ).run(IDS.mlbTeam);
  db.prepare(
    `INSERT INTO coaches VALUES (902, 'Del', 'Faraday', 44, 0, 0, 3, ?, 6, 0, 400000, 2,
                                 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 3)`
  ).run(IDS.mlbTeam);
  db.prepare(`INSERT INTO human_managers VALUES (1, 'Sam', 'Player', ?, ?)`)
    .run(IDS.mlbTeam, IDS.mlbTeam);

  const batting = db.prepare(
    `INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  /*
   * Named rather than positional, because this table now carries the potentials
   * and the experience counters beside the current grades and a positional
   * insert of forty columns is a transcription error waiting to happen.
   */
  const insertFielding = (row: Record<string, number>): void => {
    const keys = Object.keys(row);
    db.prepare(
      `INSERT INTO players_fielding (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`
    ).run(row);
  };
  const fielding = {
    run: (id: number, ...current: number[]) => {
      const row: Record<string, number> = { player_id: id, position: 4 };
      current.forEach((v, i) => { row[`fielding_rating_pos${i + 1}`] = v; });
      insertFielding(row);
    },
  };
  const allBatters = [IDS.starter, IDS.optioned, IDS.unrostered, IDS.minorDeal, IDS.boundary,
                      IDS.injured,
                      ...fielders.map(([id]) => id)];
  for (const id of allBatters) {
    batting.run(id, 50, 50, 50, 50, 50, 50, 55, 55, 55, 55, 55);
    // Competent everywhere, so position assignment is driven by the bat
    fielding.run(id, 20, 50, 50, 50, 50, 50, 50, 50, 50);
  }
  db.prepare(
    `INSERT INTO players_pitching VALUES (?, 55, 50, 50, 60, 55, 55, 60, 93)`
  ).run(IDS.extended);
  db.prepare(`INSERT INTO projected_starting_pitchers VALUES (?, ?, 0, 0, 0, 0, 0, 0, 0)`)
    .run(IDS.mlbTeam, IDS.extended);

  contract(db, { player: IDS.starter, team: IDS.mlbTeam, contractTeam: IDS.mlbTeam, years: 3, done: 1, salary: 10_000_000 });
  contract(db, { player: IDS.optioned, team: IDS.aaaTeam, contractTeam: IDS.mlbTeam, years: 2, done: 0, salary: 1_000_000 });
  // Traded away with nothing retained: contract_team_id still points at us
  contract(db, { player: IDS.tradedAway, team: IDS.otherMlbTeam, contractTeam: IDS.mlbTeam, years: 4, done: 2, salary: 20_000_000, retained: 0 });
  // Released with money retained: genuinely still owed
  contract(db, { player: IDS.retainedGuy, team: IDS.otherMlbTeam, contractTeam: IDS.mlbTeam, years: 3, done: 1, salary: 5_000_000, retained: 1 });
  // Final year of the old deal, with an extension waiting
  contract(db, { player: IDS.extended, team: IDS.mlbTeam, contractTeam: IDS.mlbTeam, years: 1, done: 0, salary: 8_000_000 });
  contract(db, { player: IDS.unrostered, team: IDS.mlbTeam, contractTeam: IDS.mlbTeam, years: 1, done: 0, salary: 700_000 });
  contract(db, { player: IDS.minorDeal, team: IDS.aaaTeam, contractTeam: IDS.mlbTeam, years: 1, done: 0, salary: 100_000, isMajor: 0 });

  const ext = Array.from({ length: 15 }, (_, i) => (i < 5 ? 25_000_000 : 0));
  db.prepare(
    `INSERT INTO players_contract_extension (player_id, years, season_year, ${ext.map((_, i) => `salary${i}`).join(', ')})
     VALUES (?, 5, ?, ${ext.map(() => '?').join(', ')})`
  ).run(IDS.extended, SEASON + 1, ...ext);

  // Two seasons at different levels, so the "current line" logic has something
  // to get wrong: the older row is the gaudier one, exactly as in a real career.
  const bat = db.prepare(
    `INSERT INTO players_career_batting_stats
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 5, 1, ?, 10, 0, 1, 1, 30, 2, 1, 20, 25, 1.0)`
  );
  bat.run(IDS.starter, SEASON, IDS.mlbTeam, IDS.league, 1, 200, 180, 45, 8);

  // A signed high-school draftee: on a farm club, with a monstrous school line
  // and not one professional plate appearance. OOTP files the school season
  // under no league at all, and counting it made him look ready for a promotion
  // on the strength of what he did to schoolboys.
  player.run(IDS.draftee, 'Prep', 'Draftee', 18, 6, 0, 32, IDS.aaaTeam, IDS.mlbTeam);
  status.run(IDS.draftee, 0, 0, 0, 0);
  value.run(IDS.draftee, 400, 900, 400, 30, 60, 30, 60);
  roster.run(IDS.aaaTeam, IDS.draftee);
  batting.run(IDS.draftee, 50, 50, 50, 50, 50, 50, 55, 55, 55, 55, 55);
  fielding.run(IDS.draftee, 20, 50, 50, 50, 50, 50, 50, 50, 50);
  //           player          year    team          league  level  pa   ab   h    hr
  bat.run(IDS.draftee, SEASON, 0, 0, 11, 220, 190, 95, 25);
  bat.run(IDS.starter, SEASON - 6, IDS.aaaTeam, IDS.league, 4, 400, 360, 130, 20);

  db.prepare(`INSERT INTO team_financials VALUES (?, 200000000, 18700000, 0, 0, 1, 1, 0, 0, 0, 0, 50)`).run(IDS.mlbTeam);

  db.close();
  return dir;
}
