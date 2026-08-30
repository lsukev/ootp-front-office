import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Money somebody else is paying.
 *
 * "Blake Leask was acquired in a trade, and his former team retained 100% of
 * his remaining salary. Payroll and Budget page says that his salary will be
 * off the books, if he leaves the team at the conclusion of the season."
 *
 * It will not, because it was never on them. `retained` is a percentage and
 * nothing was reading it as one — the flag was being used as a yes-or-no and
 * the whole salary charged either way. My own save has the mirror of his and
 * worse: the Yankees retained fifteen per cent of Carlos Rodón and were
 * charged the entire $27.8m, an overstatement of twenty-three and a half
 * million on one man.
 *
 * `contract_team_id` is the club of record, which is the club that did the
 * retaining. It pays its retained share of a man who has gone; a club holding
 * somebody else's retained player pays the rest. Where nothing was retained
 * both come to the whole salary, so a club of record merely left behind on a
 * player who moved is unaffected.
 */

/** Acquired in a trade, his old club keeping all of it — the reader's man. */
const FULLY_RETAINED = 9950;
/** The same, but the old club kept only a quarter. */
const PART_RETAINED = 9951;
/** Ours, gone elsewhere, and we kept a fifth of him. */
const WE_KEPT_A_SHARE = 9952;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Blake', ?, 29, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  const deal = db.prepare(
    `INSERT INTO players_contract
       (player_id, team_id, contract_team_id, season_year, years, current_year, is_major,
        retained, salary0, salary1, salary2)
     VALUES (?, ?, ?, ?, 1, 0, 1, ?, ?, 0, 0)`
  );

  // On our roster; the club of record is somebody else, who kept the lot
  player.run(FULLY_RETAINED, 'Leask', 61, IDS.mlbTeam, IDS.mlbTeam);
  deal.run(FULLY_RETAINED, IDS.mlbTeam, IDS.otherMlbTeam, SEASON, 100, 392_000);

  // Same again, a quarter kept, so we pay three quarters
  player.run(PART_RETAINED, 'Quarter', 62, IDS.mlbTeam, IDS.mlbTeam);
  deal.run(PART_RETAINED, IDS.mlbTeam, IDS.otherMlbTeam, SEASON, 25, 4_000_000);

  // Ours by contract, playing elsewhere, a fifth of him still ours to pay
  player.run(WE_KEPT_A_SHARE, 'Ours', 63, IDS.otherMlbTeam, IDS.otherMlbTeam);
  deal.run(WE_KEPT_A_SHARE, IDS.otherMlbTeam, IDS.mlbTeam, SEASON, 20, 10_000_000);
});

interface Payroll {
  players: Array<{ name: string; byYear: Array<number | null>; deadMoney: boolean }>;
  deadMoney: { players: Array<{ name: string; salary: number }>; total: number };
  comingOff?: { players?: Array<{ name: string }> };
}

const payroll = (): Promise<Payroll> => request(`/api/payroll/${IDS.mlbTeam}`);
const find = async (last: string) =>
  (await payroll()).players.find((p) => p.name.endsWith(last));

describe('a man acquired with all of his salary retained', () => {
  it('costs this club nothing', async () => {
    // The reader's case exactly: $392K on the page, $0 in reality
    const him = await find('Leask');
    expect(him, 'the player never reached the payroll page').toBeDefined();
    expect(him!.byYear[0]).toBe(0);
  });

  it('is not counted as money that comes off the books when he leaves', async () => {
    /*
     * "Payroll and Budget page says that his salary will be off the books."
     * Nothing comes off a bill you were not paying.
     */
    const him = await find('Leask');
    expect(him!.byYear[0]).toBe(0);
  });
});

describe('a man acquired with part of his salary retained', () => {
  it('costs this club the rest of it', async () => {
    // A quarter kept by the old club leaves three quarters here
    expect((await find('Quarter'))!.byYear[0]).toBe(3_000_000);
  });
});

describe('a man of ours playing elsewhere', () => {
  it('costs us only the share we kept', async () => {
    /*
     * The mirror, and the one that was costing my own save twenty-three
     * million: the club of record pays what it retained, not the whole deal.
     */
    const him = await find('Ours');
    expect(him, 'the retained man is missing from the ledger').toBeDefined();
    expect(him!.byYear[0]).toBe(2_000_000);
    expect(him!.deadMoney).toBe(true);
  });
});

describe('a contract nobody retained anything on', () => {
  it('is charged in full, whichever club is on the paperwork', async () => {
    /*
     * OOTP leaves the club of record behind when a player simply moves, so a
     * foreign contract_team_id with nothing retained still means we pay all of
     * it. Getting this wrong in the other direction would empty the payroll.
     */
    const him = await find('Ular');
    expect(him, 'an ordinary contract went missing').toBeDefined();
    expect(him!.byYear[0]).toBeGreaterThan(0);
  });
});
