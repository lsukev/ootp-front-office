import { describe, expect, it } from 'vitest';
import request from './request';
import { IDS, SEASON } from './fixture';

/**
 * Every case here shipped as a bug and was reported by a user. The payroll page
 * decides who a club owes money to, and it kept answering that question with
 * the wrong field.
 */
describe('payroll: who the club is actually paying', () => {
  it('does not call a player optioned to the affiliate dead money', async () => {
    const { deadMoney, players } = await request(`/api/payroll/${IDS.mlbTeam}`);
    const names = deadMoney.players.map((p: { name: string }) => p.name);
    expect(names).not.toContain('Op Tioned');

    // He is still on the books — the club pays his major-league salary while he
    // is down there. Only the label was wrong.
    const optioned = players.find((p: { name: string }) => p.name === 'Op Tioned');
    expect(optioned).toBeDefined();
    expect(optioned.deadMoney).toBe(false);
    expect(optioned.salaryNow).toBe(1_000_000);
  });

  it('drops a player traded away with nothing retained', async () => {
    const { deadMoney, players } = await request(`/api/payroll/${IDS.mlbTeam}`);
    // contract_team_id still points at this club, which is not the same as owing
    expect(deadMoney.players.map((p: { name: string }) => p.name)).not.toContain('Gone Away');
    expect(players.map((p: { name: string }) => p.name)).not.toContain('Gone Away');
  });

  it('keeps a released player whose salary was retained', async () => {
    const { deadMoney } = await request(`/api/payroll/${IDS.mlbTeam}`);
    const paid = deadMoney.players.find((p: { name: string }) => p.name === 'Paid Off');
    expect(paid).toBeDefined();
    expect(paid.salary).toBe(5_000_000);
    expect(deadMoney.total).toBe(5_000_000);
  });

  it('leaves minor-league contracts out of payroll', async () => {
    const { players } = await request(`/api/payroll/${IDS.mlbTeam}`);
    expect(players.map((p: { name: string }) => p.name)).not.toContain('Minor Deal');
  });

  it('counts a signed extension in future seasons', async () => {
    const { players, years } = await request(`/api/payroll/${IDS.mlbTeam}`);
    const locked = players.find((p: { name: string }) => p.name === 'Locked Up');
    expect(locked.endYear).toBe(SEASON + 5);
    expect(locked.expiring).toBe(false);

    // The old deal covers this season; the extension picks up from the next
    const nextSeason = years.indexOf(SEASON + 1);
    expect(locked.byYear[0]).toBe(8_000_000);
    expect(locked.byYear[nextSeason]).toBe(25_000_000);
  });

  it('does not list an extended player as coming off the books', async () => {
    const { comingOff } = await request(`/api/payroll/${IDS.mlbTeam}`);
    expect(comingOff.players.map((p: { name: string }) => p.name)).not.toContain('Locked Up');
  });
});
