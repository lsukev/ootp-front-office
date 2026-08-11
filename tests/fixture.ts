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
      draft_date TEXT, rules_amateur_draft_rounds INTEGER
    );
    CREATE TABLE sub_leagues (league_id INTEGER, sub_league_id INTEGER, name TEXT, designated_hitter INTEGER);
    CREATE TABLE teams (
      team_id INTEGER, name TEXT, nickname TEXT, abbr TEXT, level INTEGER, league_id INTEGER,
      sub_league_id INTEGER, division_id INTEGER, parent_team_id INTEGER, allstar_team INTEGER
    );
    CREATE TABLE players (
      player_id INTEGER, first_name TEXT, last_name TEXT, age INTEGER, position INTEGER, role INTEGER,
      bats INTEGER, throws INTEGER, uniform_number INTEGER, team_id INTEGER, organization_id INTEGER,
      retired INTEGER, hidden INTEGER, draft_eligible INTEGER, college INTEGER,
      injury_is_injured INTEGER DEFAULT 0, injury_dtd_injury INTEGER DEFAULT 0,
      injury_left INTEGER DEFAULT 0
    );
    CREATE TABLE players_roster_status (
      player_id INTEGER, is_active INTEGER, is_on_dl INTEGER, is_on_dl60 INTEGER,
      is_on_secondary INTEGER, mlb_service_years REAL, mlb_service_days REAL,
      mlb_service_days_this_year REAL,
      designated_for_assignment INTEGER DEFAULT 0, days_on_dfa_left INTEGER DEFAULT 0,
      is_on_waivers INTEGER DEFAULT 0
    );
    CREATE TABLE team_roster (team_id INTEGER, player_id INTEGER, list_id INTEGER);
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
      player_id INTEGER,
      ${Array.from({ length: 9 }, (_, i) => `fielding_rating_pos${i + 1} INTEGER`).join(', ')}
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
    CREATE TABLE players_career_fielding_stats (
      player_id INTEGER, year INTEGER, level_id INTEGER, split_id INTEGER, position INTEGER,
      g INTEGER, gs INTEGER, ip REAL, po INTEGER, a INTEGER, e INTEGER, dp INTEGER
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
    `INSERT INTO leagues VALUES (?, 'Test League', 'TL', 0, 1, ?, '2030-06-01', 6, 3, 700000, 1, 1, 1, '2030-07-10', 20)`
  ).run(IDS.league, SEASON);
  db.prepare(`INSERT INTO sub_leagues VALUES (?, 0, 'Only', 1)`).run(IDS.league);

  const team = db.prepare(`INSERT INTO teams VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, 0)`);
  team.run(IDS.mlbTeam, 'Test', 'Nine', 'TST', 1, IDS.league, 0);
  team.run(IDS.aaaTeam, 'Farm', 'Hands', 'FRM', 2, IDS.league, IDS.mlbTeam);
  team.run(IDS.otherMlbTeam, 'Other', 'Club', 'OTH', 1, IDS.league, 0);

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

  const batting = db.prepare(
    `INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const fielding = db.prepare(
    `INSERT INTO players_fielding VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
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
