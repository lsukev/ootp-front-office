import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * The streak strip should name six players, not three players twice.
 *
 * A hitter on a run is usually on two streaks at once — reaching base every
 * night and hitting in most of those games — and both were being listed. On
 * the club this was found on, five chips carried three men: Bellinger at 9 and
 * 6, Luciano at 7 and 6, and half the panel repeating itself.
 *
 * Keeping only the longest would have hidden the second fact rather than
 * fixing the first, and since an on-base streak is the longer of the two by
 * its nature, every chip would have said "on-base" and none would ever have
 * mentioned a man was hitting. So both are kept and the chip says so.
 */

const DOUBLE = 9000;
const SINGLE = 9001;
const STREAK_HITTING = 0;
const STREAK_ON_BASE = 9;

beforeAll(() => {
  const add = (id: number, last: string) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Streak', ?, 27, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, id - 8900, IDS.mlbTeam, IDS.mlbTeam);
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.mlbTeam, id);
  };
  const streak = db.prepare(
    // Dated inside the current season, because a streak that began in an
    // earlier one is no longer running whatever the ended flag says
    `INSERT INTO players_streak (player_id, streak_id, value, started, has_ended)
     VALUES (?, ?, ?, '${SEASON}-7-20', 0)`
  );

  add(DOUBLE, 'Both');
  streak.run(DOUBLE, STREAK_ON_BASE, 14);
  streak.run(DOUBLE, STREAK_HITTING, 9);

  add(SINGLE, 'Onlyone');
  streak.run(SINGLE, STREAK_HITTING, 7);
});

interface Chip { player_id: number; name: string; games: number; kind: string; also?: string | null }

const streaks = async (): Promise<Chip[]> =>
  ((await request(`/api/dashboard/${IDS.mlbTeam}`)).streaks ?? []) as Chip[];

describe('the streak strip', () => {
  it('gives a man one place, however many streaks he is on', async () => {
    const ids = (await streaks()).map((s) => s.player_id);
    expect(new Set(ids).size, 'the same player took more than one chip').toBe(ids.length);
  });

  it('leads with his longer streak', async () => {
    const him = (await streaks()).find((s) => s.player_id === DOUBLE);
    expect(him?.games).toBe(14);
    expect(him?.kind).toContain('on-base');
  });

  it('still says he is hitting too', async () => {
    const him = (await streaks()).find((s) => s.player_id === DOUBLE);
    expect(him?.also, 'his second streak went unmentioned').toContain('hitting');
    expect(him?.also).toContain('9');
  });

  it('leaves a man with one streak carrying nothing extra', async () => {
    const him = (await streaks()).find((s) => s.player_id === SINGLE);
    expect(him?.games).toBe(7);
    expect(him?.also ?? null).toBeNull();
  });
});
