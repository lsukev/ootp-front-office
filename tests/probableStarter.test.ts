import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The pitcher the lineup card is built against.
 *
 * "I can see you've flagged who the likely next pitcher they will face is. If
 * possible it would be good to be able to set a line up or at least see your
 * best lineup against that pitcher."
 *
 * It already does, and had for a long time: the page reads tonight's probable
 * starter and defaults the platoon side to his hand. What it never did was say
 * so — the confirmation only appeared as a button, and only once the reader had
 * wandered off the default. So the feature he asked for was the one he was
 * already looking at, silently.
 *
 * I also went looking for a bug here that is not one. `projected_starting_
 * pitchers` is the rotation as it stands on the export's own date, so slot zero
 * is whoever pitches next; the schedule's Plan panel counts along that array
 * only because it is asked about games days out. For the next unplayed game
 * there is nothing to count. These pin that down so the next person to think
 * it is wrong can find out cheaply.
 */

const OPP = IDS.otherMlbTeam;
const ACE = 9900;
const SECOND = 9901;

beforeAll(() => {
  const arm = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Their', ?, 29, 1, 11, 1, ?, ?, ?, ?, 0, 0, 0, 0)`
  );
  arm.run(ACE, 'Ace', 1, 51, OPP, OPP);
  arm.run(SECOND, 'Second', 2, 52, OPP, OPP);
  db.prepare(`DELETE FROM projected_starting_pitchers WHERE team_id = ?`).run(OPP);
  db.prepare(`INSERT INTO projected_starting_pitchers VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0)`)
    .run(OPP, ACE, SECOND);

  db.prepare(`DELETE FROM games WHERE home_team = ? OR away_team = ?`).run(IDS.mlbTeam, IDS.mlbTeam);
  const game = db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  );
  game.run(8100, IDS.mlbTeam, OPP, '2030-6-1', 1, IDS.league);
  game.run(8101, IDS.mlbTeam, OPP, '2030-6-2', 0, IDS.league);
  game.run(8102, IDS.mlbTeam, OPP, '2030-6-3', 0, IDS.league);
});

interface Next {
  date: string;
  theirStarter: { player_id: number; name: string; throws: string } | null;
  ourStarter: { name: string } | null;
}

const next = (): Promise<Next> => request(`/api/next-game/${IDS.mlbTeam}`);

describe('tonight\'s probable starter', () => {
  it('is the next game, not the next one on the calendar', async () => {
    // The first game of the series has been played
    expect((await next()).date).toBe('2030-6-2');
  });

  it('is the top of the rotation as the export left it', async () => {
    /*
     * Not "the ace regardless": OOTP rewrites this array every time it is
     * exported, so slot zero is the next man up whatever point of a series the
     * save was taken at. Reading further along it would name somebody pitching
     * the day after tomorrow.
     */
    expect((await next()).theirStarter?.name).toBe('Their Ace');
  });

  it('carries the hand, which is what the card is built against', async () => {
    const g = await next();
    expect(g.theirStarter?.throws).toBe('R');
  });

  it('names our own probable too', async () => {
    expect((await next()).ourStarter).not.toBeNull();
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the lineup page', () => {
  const page = () => read('src/pages/Lineup.tsx');

  it('builds against tonight\'s man by default', () => {
    // It has done this for a long time; the reader asking for it is the tell
    // that it was doing it silently
    expect(page()).toMatch(/if \(g\?\.theirStarter\?\.throws === 'L'\) setVs\('l'\)/);
  });

  it('says so, rather than only offering a button when you have wandered off', () => {
    const src = page();
    expect(src).toMatch(/Card built for/);
    expect(src).toMatch(/Build vs \{next\.theirStarter/);
  });
});
