import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { assembleDay, lastPlayedDate, sectionFault, usableSection } from '../server/recap.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Yesterday, around the league.
 *
 * A reader asked for what the morning paper gave him — who won, what it did to
 * the races, and who is out in front of the league in something — across the
 * whole league rather than his own club. The writing is the model's; everything
 * it writes from is gathered here, and these hold down the parts that can be
 * wrong without anybody noticing.
 */

const OTHER_DIVISION = 1;

beforeAll(() => {
  db.prepare(`INSERT INTO divisions VALUES (?, 0, 1, 'East Division', 0)`).run(IDS.league);
  db.prepare(`INSERT INTO divisions VALUES (?, 0, 2, 'West Division', 0)`).run(IDS.league);

  // Two clubs in a second division, so there is a division with no games in it
  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, ?, ?, ?, 1, ?, 0, ?, 0, 0)`
  );
  team.run(9800, 'Quiet', 'Ones', 'QUI', IDS.league, 2);
  team.run(9801, 'Idle', 'Nine', 'IDL', IDS.league, 2);
  db.prepare(`UPDATE teams SET division_id = ? WHERE team_id IN (?, ?, ?)`)
    .run(OTHER_DIVISION, IDS.mlbTeam, IDS.otherMlbTeam, 9800);
  db.prepare(`UPDATE teams SET division_id = 2 WHERE team_id IN (?, ?)`).run(9800, 9801);

  const rec = db.prepare(
    `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
     VALUES (?, 40, ?, ?, 0, ?, 0.5, ?, ?, 0)`
  );
  rec.run(IDS.mlbTeam, 25, 15, 1, 0, 3);
  rec.run(IDS.otherMlbTeam, 20, 20, 2, 5, -2);
  rec.run(9800, 22, 18, 1, 0, 1);
  rec.run(9801, 18, 22, 2, 4, -1);

  /*
   * Dates as OOTP writes them, which is not zero-padded. A plain string sort
   * puts "2027-9-3" after "2027-10-1", so the day picked as "yesterday" would
   * be a fortnight out for half of every September.
   */
  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type,
                        runs0, runs1, innings)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
  );
  game.run(8801, IDS.mlbTeam, IDS.otherMlbTeam, '2027-9-3', 1, IDS.league, 4, 2, 9);
  game.run(8802, IDS.otherMlbTeam, IDS.mlbTeam, '2027-10-1', 1, IDS.league, 5, 6, 11);
  // Played later but not yet played, so it must not become the day recapped
  game.run(8803, IDS.mlbTeam, IDS.otherMlbTeam, '2027-10-2', 0, IDS.league, 0, 0, 9);
  // An exhibition on the same day, which is not league action
  game.run(8804, IDS.mlbTeam, 9801, '2027-10-1', 1, IDS.league, 30, 0, 9);
  db.prepare(`UPDATE games SET game_type = 3 WHERE game_id = 8804`).run();
});

describe('the day worth writing up', () => {
  it('is the last one actually played', async () => {
    // Not the save's today: a save exported in the morning has not played it
    expect(lastPlayedDate(IDS.league)).toBe('2027-10-01');
  });

  it('reads OOTP\'s unpadded dates in the right order', async () => {
    /*
     * "2027-9-3" sorts after "2027-10-1" as a string. Getting this wrong would
     * recap a fortnight-old day for half of every September and give no sign
     * of it, since the recap would be perfectly coherent — about the wrong day.
     */
    const day = assembleDay(IDS.mlbTeam);
    expect(day.date).toBe('2027-10-01');
    expect(day.games.length, 'picked up games from another day').toBe(1);
    expect(day.games[0].awayRuns).toBe(5);
    expect(day.games[0].homeRuns).toBe(6);
  });

  it('leaves out exhibitions', async () => {
    // Same day, not league action; counting it would put a club in two games
    const day = assembleDay(IDS.mlbTeam);
    expect(day.games.map((g) => g.home)).not.toContain('Idle Nine');
  });
});

describe('the tables behind the day', () => {
  it('names divisions as the league names them', async () => {
    // "In the NL East" has to have been told what the NL East is
    const day = assembleDay(IDS.mlbTeam);
    expect(Object.keys(day.standings).join(' ')).toMatch(/East Division/);
    expect(Object.keys(day.standings).join(' ')).toMatch(/West Division/);
  });

  it('says which divisions had no games at all', async () => {
    /*
     * Worked out here rather than asked of the model. A division that simply
     * vanishes from a recap reads as an omission, and whether anybody played
     * is something the games table settles.
     */
    const day = assembleDay(IDS.mlbTeam);
    expect(day.idleDivisions.join(' ')).toMatch(/West Division/);
    expect(day.idleDivisions.join(' '), 'the division that played was called idle')
      .not.toMatch(/East Division/);
  });
});

describe('the league leaders', () => {
  it('says how many men share the top mark', async () => {
    /*
     * The first version returned only a ranking, and the model wrote "Kyle
     * Schwarber leads MLB with 13 home runs" on a day three men had thirteen.
     * Being first in a sorted list is not the same as leading.
     */
    const bat = db.prepare(
      `INSERT INTO players_career_batting_stats
         (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
          bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
       VALUES (?, ?, ?, ?, 1, 1, 300, 280, 80, 10, 1, ?, 15, 0, 2, 1, 50, ?, 1, 40, ?, 1.0)`
    );
    /*
     * Three men of their own rather than the fixture's, because the leaders
     * are summed per player and a second row for somebody who already has one
     * adds to his line instead of replacing it — which is how the first
     * version of this test read 68 home runs where it had written 60.
     *
     * Numbers well clear of anything the fixture carries, so the tie under
     * test is the one at the top of the league and not a coincidence further
     * down the list.
     */
    const slugger = db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Leader', ?, 28, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    );
    slugger.run(9810, 'One', 81, IDS.mlbTeam, IDS.mlbTeam);
    slugger.run(9811, 'Two', 82, IDS.mlbTeam, IDS.mlbTeam);
    slugger.run(9812, 'Runner', 83, IDS.mlbTeam, IDS.mlbTeam);
    bat.run(9810, SEASON, IDS.mlbTeam, IDS.league, 60, 3, 40);
    bat.run(9811, SEASON, IDS.mlbTeam, IDS.league, 60, 1, 35);
    bat.run(9812, SEASON, IDS.mlbTeam, IDS.league, 4, 99, 20);
    try {
      const leaders = assembleDay(IDS.mlbTeam).leaders as Record<string, {
        top: Array<{ name: string; value: number }>; sharedByCount: number;
      }>;
      expect(leaders.homeRuns.top[0].value).toBe(60);
      expect(leaders.homeRuns.sharedByCount, 'a shared lead was reported as one man\'s').toBe(2);
      expect(leaders.steals.sharedByCount, 'a clear lead was reported as shared').toBe(1);
    } finally {
      for (const id of [9810, 9811, 9812]) {
        db.prepare(`DELETE FROM players_career_batting_stats WHERE player_id = ?`).run(id);
        db.prepare(`DELETE FROM players WHERE player_id = ?`).run(id);
      }
    }
  });
});

describe('what the model sends back', () => {
  it('keeps a division with something to say', () => {
    expect(usableSection({
      division: 'American League East Division',
      body: 'Baltimore edged Boston 8-7 at Fenway and Tampa Bay outlasted Toronto 3-2 in ten innings.',
    })).toBe(true);
  });

  it('throws away filler', () => {
    // A user once reported a page reading "placeholder" over and over
    expect(sectionFault({ division: 'placeholder', body: 'x'.repeat(80) })).toBe('filler division');
    expect(sectionFault({ division: 'AL East', body: 'TBD' })).toMatch(/filler|too short/);
  });

  it('throws away a division with nothing in it', () => {
    expect(sectionFault({ division: 'AL East', body: 'They played.' })).toMatch(/too short/);
  });
});

describe('a recap the league has moved past', () => {
  it('is served with the day it covers and the day the league has reached', async () => {
    // Reading Saturday's recap on Monday is fine; not being told is not
    const d = await request(`/api/daily-recap/${IDS.mlbTeam}`);
    expect(d.latestPlayed).toBe('2027-10-01');
    expect(d).toHaveProperty('stale');
    expect(d).toHaveProperty('job');
  });
});
