import { describe, expect, it, beforeEach } from 'vitest';
import { db } from '../server/db.js';
import { deadlineRead } from '../server/posture.js';
import { playoffPicture, regularSeasonSchedule } from '../server/playoffs.js';
import { IDS } from './fixture.js';

/**
 * The card after the last game of the year.
 *
 * "This is at conclusion of the regular season — every game of the regular
 * season has been played by everyone... Ideally should have 'reached playoffs'
 * or some other wording to indicate moving on instead of it still saying 'buy
 * 99% to reach the postseason'... Or, when a team gets mathematically
 * eliminated, it should state that fact somehow."
 *
 * His screenshot carried three faults in four lines: a club that had played
 * all 162 was told it had 28 games left, its magic number read -1, and the
 * card was still offering odds on a question the season had already answered.
 *
 * The 28 was not arbitrary. The schedule count included the exhibition slate,
 * so a club with its whole season in the books had exactly its spring games
 * left to play — and every odds calculation the card ever made ran with them
 * in it.
 */

const OTHERS = [9101, 9102, 9103, 9104];
/** His club's line, to the game. */
const CHAMPION = { w: 116, l: 46 };

function league(options: { played: number; scheduled?: number; rivalWins?: number; exhibition?: number }) {
  const { played, scheduled = 162, rivalWins = 70, exhibition = 28 } = options;
  db.prepare(`DELETE FROM games`).run();
  db.prepare(`DELETE FROM team_record`).run();
  db.prepare(`DELETE FROM teams WHERE team_id IN (${OTHERS.join(',')})`).run();

  const record = db.prepare(
    `INSERT INTO team_record (team_id, g, w, l, t, pos, pct, gb, streak, magic_number)
     VALUES (?, ?, ?, ?, 0, ?, ?, ?, 0, ?)`
  );
  const wins = Math.round((CHAMPION.w * played) / 162);
  const losses = played - wins;
  // The magic number OOTP writes for a club whose race is already settled
  record.run(IDS.mlbTeam, played, wins, losses, 1, wins / Math.max(1, played), 0, played === 162 ? -1 : 12);

  const team = db.prepare(
    `INSERT INTO teams (team_id, name, nickname, abbr, level, league_id, sub_league_id,
                        division_id, parent_team_id, allstar_team)
     VALUES (?, ?, 'Club', ?, 1, ?, 0, 1, 0, 0)`
  );
  db.prepare(`UPDATE teams SET division_id = 1, sub_league_id = 0 WHERE team_id IN (?, ?)`)
    .run(IDS.mlbTeam, IDS.otherMlbTeam);
  record.run(IDS.otherMlbTeam, played, rivalWins, played - rivalWins, 2, 0.5, 10, 1000);
  for (const id of OTHERS) {
    try { team.run(id, `Club ${id}`, `C${id}`, IDS.league); } catch { /* already there */ }
    record.run(id, played, rivalWins - 5, played - (rivalWins - 5), 3, 0.45, 15, 1000);
  }

  const g = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, game_type, league_id)
     VALUES (?, ?, ?, '2027-9-28', ?, 0, ?)`
  );
  let id = 20000;
  for (const club of [IDS.mlbTeam, IDS.otherMlbTeam, ...OTHERS]) {
    for (let i = 0; i < scheduled; i += 1) {
      g.run(id += 1, club, 999, i < played ? 1 : 0, IDS.league);
    }
  }
  // March, and long since played
  const ex = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, game_type, league_id)
     VALUES (?, ?, 999, '2027-3-1', 1, 5, ?)`
  );
  for (let i = 0; i < exhibition; i += 1) ex.run(id += 1, IDS.mlbTeam, IDS.league);
}

describe('games left', () => {
  beforeEach(() => league({ played: 162 }));

  it('is nought when every game of the season has been played', () => {
    expect(deadlineRead(IDS.mlbTeam)!.gamesLeft).toBe(0);
  });

  /*
   * The reported number, and where it came from. 162 played, 28 exhibition
   * games in March, and a card promising 28 more to settle it.
   */
  it('does not count the exhibition slate the club played in March', () => {
    expect(regularSeasonSchedule(IDS.mlbTeam)).toEqual({ total: 162, left: 0 });
    expect(deadlineRead(IDS.mlbTeam)!.gamesLeft).not.toBe(28);
  });

  it('counts what is unplayed mid-season', () => {
    league({ played: 100 });
    expect(deadlineRead(IDS.mlbTeam)!.gamesLeft).toBe(62);
  });

  /*
   * A schedule that does not even cover the games already played cannot be
   * used to declare a season over — better to fall back than to tell a club
   * in May that its year is finished.
   */
  it('will not call a season over on a schedule that cannot be read', () => {
    league({ played: 100, scheduled: 20 });
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.settled).toBeNull();
    expect(read.gamesLeft).toBeGreaterThan(0);
  });

  /*
   * Some independent and winter leagues in a save carry records and no
   * schedule at all. The card keeps a horizon for the odds, which need one,
   * but does not print a figure the export cannot support — the reported "28
   * games left" was exactly that kind of number.
   */
  it('does not state a games-left figure it had to invent', () => {
    league({ played: 30, scheduled: 0 });
    db.prepare(`UPDATE leagues SET rules_schedule_games_per_team = 0 WHERE league_id = ?`).run(IDS.league);
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.gamesLeftKnown).toBe(false);
    expect(read.reasons.join(' ')).not.toMatch(/games left/);
    db.prepare(`UPDATE leagues SET rules_schedule_games_per_team = 162 WHERE league_id = ?`).run(IDS.league);
  });

  it('uses the length OOTP was configured with when the schedule is missing', () => {
    league({ played: 30, scheduled: 0 });
    db.prepare(`UPDATE leagues SET rules_schedule_games_per_team = 55 WHERE league_id = ?`).run(IDS.league);
    const read = deadlineRead(IDS.mlbTeam)!;
    // 55-game complex-league season, not the 162 the old fallback assumed
    expect(read.gamesLeft).toBe(25);
    expect(read.gamesLeftKnown).toBe(true);
    db.prepare(`UPDATE leagues SET rules_schedule_games_per_team = 162 WHERE league_id = ?`).run(IDS.league);
  });
});

describe('a season that has been played out', () => {
  beforeEach(() => league({ played: 162 }));

  it('says the postseason was reached rather than offering odds on it', () => {
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.settled).toBe('in');
    expect(read.headline).toBe('Reached the postseason.');
    expect(read.caption).toBe('reached the postseason');
    expect(read.verdict).toBe('in');
  });

  it('never offers to buy a season that has finished', () => {
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.caption).not.toBe('to reach the postseason');
    for (const line of [read.headline, ...read.reasons]) {
      expect(line).not.toMatch(/deadline/i);
    }
  });

  it('says the season is over instead of counting games left to settle it', () => {
    const reasons = deadlineRead(IDS.mlbTeam)!.reasons.join(' ');
    expect(reasons).toMatch(/regular season is over/);
    expect(reasons).not.toMatch(/games left to settle/);
  });

  it('reports the division as won rather than as being led', () => {
    expect(playoffPicture(IDS.mlbTeam)!.summary).toBe('Won the division.');
  });

  /*
   * OOTP counts the magic number down past zero once the race is settled, and
   * a negative number is a truthy one — so the line printed itself.
   */
  it('never prints a negative magic number', () => {
    const picture = playoffPicture(IDS.mlbTeam)!;
    expect(picture.magicNumber).toBeNull();
    expect(picture.summary).not.toMatch(/magic number/);
  });

  it('says the postseason was missed when it was', () => {
    league({ played: 162, rivalWins: 150 });
    db.prepare(`UPDATE team_record SET w = 50, l = 112, pos = 2 WHERE team_id = ?`).run(IDS.mlbTeam);
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.settled).toBe('out');
    expect(read.headline).toBe('Missed the postseason.');
  });
});

describe('a race decided before the season is', () => {
  it('states elimination as a fact rather than as long odds', () => {
    league({ played: 150, rivalWins: 140 });
    db.prepare(`UPDATE team_record SET w = 40, l = 110, pos = 2 WHERE team_id = ?`).run(IDS.mlbTeam);
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.settled).toBe('out');
    expect(read.caption).toBe('eliminated from the race');
    expect(read.headline).toMatch(/^Eliminated with 12 to play/);
    expect(read.posture).toBe('sell');
  });

  it('says a place is secured when nobody left can take it', () => {
    league({ played: 150, rivalWins: 40 });
    db.prepare(`UPDATE team_record SET w = 120, l = 30, pos = 1 WHERE team_id = ?`).run(IDS.mlbTeam);
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.settled).toBe('in');
    expect(read.caption).toBe('a postseason place is clinched');
    expect(playoffPicture(IDS.mlbTeam)!.summary).toBe('Clinched the division.');
  });

  /*
   * The ordinary case, and the one that must not become a verdict: a club in a
   * real race is not settled either way, and the card should still be a card.
   */
  it('leaves a live race alone', () => {
    league({ played: 100, rivalWins: 55 });
    db.prepare(`UPDATE team_record SET w = 56, l = 44, pos = 1 WHERE team_id = ?`).run(IDS.mlbTeam);
    const read = deadlineRead(IDS.mlbTeam)!;
    expect(read.settled).toBeNull();
    expect(read.caption).toBe('to reach the postseason');
    expect(read.odds).toBeGreaterThan(0);
    expect(read.odds).toBeLessThan(1);
  });
});
