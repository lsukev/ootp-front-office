import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Streaks that are actually running, in the league you are managing.
 *
 * "Ed Kaiser shows 17 games on-base active streak, but the game year is 2006
 * and the streak is from 2001 when he played in the feeder prospect league. And
 * then — he is shown as having a 26 on-base games streak, while actually he had
 * that streak ended at 27 and it was a season ago. There is no way to know from
 * what is shown, which is an active streak and which one has ended."
 *
 * Three complaints, and `has_ended = 0` was being trusted to answer all three.
 * It answers none of them on its own:
 *
 *  - It is not one league. A man carries a row per competition he has played
 *    in, so a run in a feeder league arrives looking exactly like one in the
 *    majors.
 *  - It is not this season. OOTP leaves last year's streaks open rather than
 *    closing them at the final out — on my own save 6,994 of the rows flagged
 *    unfinished began in the season before the current one.
 *  - It is not one row per man per kind, which is how one name came to carry
 *    "26 game on-base streak · 17-game on-base streak": the same streak type
 *    from two different leagues, printed as though the second were his other
 *    kind.
 */

const FEEDER_LEAGUE = 777;
const STREAK_HITTING = 0;
const STREAK_ON_BASE = 9;

/** Running now, in the league the club plays in. The only kind worth showing. */
const GENUINE = 9300;
/** A long run, in a feeder competition. The reporter's Ed Kaiser. */
const FEEDER_ONLY = 9301;
/** Left open by OOTP at the end of last season and never closed. */
const LAST_SEASON = 9302;
/** Rows in both leagues at once — the pair that printed as one man's two kinds. */
const TWO_LEAGUES = 9303;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Streak', ?, 27, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const streak = db.prepare(
    `INSERT INTO players_streak (player_id, league_id, streak_id, value, started, has_ended)
     VALUES (?, ?, ?, ?, ?, 0)`
  );
  const add = (id: number, last: string) => {
    player.run(id, last, id - 9200, IDS.mlbTeam, IDS.mlbTeam);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, id);
  };

  add(GENUINE, 'Running');
  streak.run(GENUINE, IDS.league, STREAK_ON_BASE, 12, `${SEASON}-6-2`);

  add(FEEDER_ONLY, 'Feeder');
  streak.run(FEEDER_ONLY, FEEDER_LEAGUE, STREAK_ON_BASE, 17, `${SEASON}-5-1`);

  add(LAST_SEASON, 'Stale');
  streak.run(LAST_SEASON, IDS.league, STREAK_ON_BASE, 26, `${SEASON - 1}-8-14`);

  add(TWO_LEAGUES, 'Doubled');
  streak.run(TWO_LEAGUES, IDS.league, STREAK_ON_BASE, 9, `${SEASON}-6-10`);
  streak.run(TWO_LEAGUES, FEEDER_LEAGUE, STREAK_ON_BASE, 21, `${SEASON}-6-10`);
});

interface Streak {
  player_id: number; name: string; games: number; kind: string;
  since: string; also: string | null;
}

const streaks = async (): Promise<Streak[]> =>
  ((await request(`/api/dashboard/${IDS.mlbTeam}`)).streaks ?? []) as Streak[];

const of = async (id: number): Promise<Streak | undefined> =>
  (await streaks()).find((s) => s.player_id === id);

describe('a streak in another competition', () => {
  it('is not reported as a run in this league', async () => {
    // A seventeen-game run in the feeder league is not news from the major-
    // league dashboard, and it looked identical to one that was
    expect(await of(FEEDER_ONLY), 'a feeder-league streak reached the dashboard').toBeUndefined();
  });
});

describe('a streak from an earlier season', () => {
  it('is not reported as still running', async () => {
    /*
     * The flag says unfinished because OOTP never closed it, not because the
     * man is still on it. Twenty-six games last August is history.
     */
    expect(await of(LAST_SEASON), 'last season\'s streak was shown as active').toBeUndefined();
  });
});

describe('a man carrying the same kind of streak in two leagues', () => {
  it('is reported once, from the league he is being managed in', async () => {
    const him = await of(TWO_LEAGUES);
    expect(him, 'the man vanished entirely').toBeDefined();
    expect(him!.games, 'the feeder-league run won out over the real one').toBe(9);
  });

  it('does not have his other league printed as his other kind', async () => {
    // "26 game on-base streak · 17-game on-base streak" against one name
    expect(await of(TWO_LEAGUES).then((h) => h!.also)).toBeNull();
  });
});

describe('a streak that really is running', () => {
  it('is still reported, with the day it began', async () => {
    // The whole point of keeping the feature rather than dropping it
    const him = await of(GENUINE);
    expect(him).toBeDefined();
    expect(him!.games).toBe(12);
    expect(him!.kind).toBe('on-base streak');
    expect(String(him!.since)).toContain(String(SEASON));
  });
});

describe('a man on both kinds at once', () => {
  it('still has the second named beside the first', async () => {
    /*
     * The pairing this field exists for, and which the fix must not have cost:
     * reaching base every night and hitting in most of those games is two
     * facts about one man, worth one line rather than two.
     */
    const BOTH = 9310;
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Streak', 'Bothways', 27, 7, 0, 1, 1, 77, ?, ?, 0, 0, 0, 0)`
    ).run(BOTH, IDS.mlbTeam, IDS.mlbTeam);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, BOTH);
    const streak = db.prepare(
      `INSERT INTO players_streak (player_id, league_id, streak_id, value, started, has_ended)
       VALUES (?, ?, ?, ?, ?, 0)`
    );
    streak.run(BOTH, IDS.league, STREAK_ON_BASE, 11, `${SEASON}-6-1`);
    streak.run(BOTH, IDS.league, STREAK_HITTING, 7, `${SEASON}-6-5`);
    try {
      const him = await of(BOTH);
      expect(him!.kind).toBe('on-base streak');
      expect(him!.also, 'his hitting streak went unmentioned').toMatch(/7-game hitting streak/);
    } finally {
      db.prepare(`DELETE FROM players_streak WHERE player_id = ?`).run(BOTH);
      db.prepare(`DELETE FROM players WHERE player_id = ?`).run(BOTH);
    }
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the probables in Up Next', () => {
  it('wrap instead of running out of the panel', () => {
    // Two full names and a hand fit no fixed width; the tables here are nowrap
    // by default, which is right for numbers and wrong for a cell of names
    expect(read('src/pages/Dashboard.tsx')).toMatch(/className="muted wrap-cell"/);
    expect(read('src/styles.css')).toMatch(/td\.wrap-cell \{ white-space: normal; \}/);
  });
});
