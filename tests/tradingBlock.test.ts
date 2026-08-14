import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { blockedIds, tradingBlock } from '../server/tradingblock.js';
import { IDS } from './fixture.js';

/**
 * The trading block, which the export has carried all along.
 *
 * OOTP writes it into players_roster_status.trade_status and nothing read it,
 * so the assistants reasoned about the league as though every player were
 * equally gettable. In the save this was built against they were not: 153 men
 * were listed, the four best clubs had listed nobody, and the desk had
 * recommended chasing an outfielder who was not on the market while calling
 * two men it would "not touch" — both of whom their own club had listed.
 *
 * What the flag means is read off the data rather than assumed. Clubs listing
 * players are the ones out of the race and the men listed are aging regulars
 * on expiring deals, which is a selling list and nothing else.
 */

const LISTED = 8700;
const NOT_LISTED = 8701;

beforeAll(() => {
  const add = (id: number, last: string, status: number) => {
    db.prepare(
      `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                            uniform_number, team_id, organization_id, retired, hidden,
                            draft_eligible, college)
       VALUES (?, 'Block', ?, 30, 7, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
    ).run(id, last, id - 8600, IDS.otherMlbTeam, IDS.otherMlbTeam);
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year, trade_status)
       VALUES (?, 1, 0, 0, 0, 6.0, ?, 40, ?)`
    ).run(id, 6 * 172, status);
    db.prepare(
      `INSERT INTO players_value
         (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
          offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
       VALUES (?, 1100, 1100, 100, 100, 100, 0, 55, 55, 55, 55)`
    ).run(id);
  };
  add(LISTED, 'Available', 2);
  add(NOT_LISTED, 'Untouchable', 0);
});

describe('the trading block', () => {
  it('lists the man his club has put up', () => {
    const names = tradingBlock().listed.map((p) => p.name);
    expect(names).toContain('Block Available');
  });

  it('leaves out the man nobody has listed', () => {
    const names = tradingBlock().listed.map((p) => p.name);
    expect(names).not.toContain('Block Untouchable');
  });

  it('says who he plays for, so a deal can be aimed at somebody', () => {
    const him = tradingBlock().listed.find((p) => p.name === 'Block Available');
    expect(him?.teamAbbr).toBeTruthy();
    expect(him?.levelName).toBe('MLB');
  });

  it('narrows to one club when asked', () => {
    const mine = tradingBlock({ teamId: IDS.mlbTeam });
    expect(mine.listed.every((p) => p.name !== 'Block Available')).toBe(true);
    const theirs = tradingBlock({ teamId: IDS.otherMlbTeam });
    expect(theirs.listed.map((p) => p.name)).toContain('Block Available');
  });

  it('counts the clubs doing the selling, not just the players', () => {
    const all = tradingBlock();
    expect(all.sellingClubs).toBeGreaterThan(0);
    expect(all.total).toBeGreaterThanOrEqual(all.listed.length);
  });

  it('honours a limit while keeping the best of them', () => {
    expect(tradingBlock({ limit: 1 }).listed.length).toBeLessThanOrEqual(1);
  });
});

describe('the set used to mark a man already in a deal', () => {
  it('holds the listed player and not the other', () => {
    const ids = blockedIds();
    expect(ids.has(LISTED)).toBe(true);
    expect(ids.has(NOT_LISTED)).toBe(false);
  });
});
