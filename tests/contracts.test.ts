import { describe, expect, it } from 'vitest';
import request from './request';
import { IDS } from './fixture';

describe('contract status', () => {
  it('does not call an extended player expiring', async () => {
    const { players } = await request(`/api/contracts/${IDS.mlbTeam}`);
    const locked = players.find((p: { name: string }) => p.name === 'Locked Up');
    expect(locked.flags.some((f: string) => f.startsWith('extended thru'))).toBe(true);
    expect(locked.flags).not.toContain('expiring');
    expect(locked.yearsAfterThis).toBeGreaterThan(0);
  });

  it('projects service time only to the end of the season', async () => {
    // 5.1 years of service with 40 of 172 service days already banked. Adding a
    // whole year reaches 6.1 and reads as free agency; adding only the rest of
    // this season reaches 5.87, and he still owes the club an arbitration year.
    const { players } = await request(`/api/contracts/${IDS.mlbTeam}`);
    const near = players.find((p: { name: string }) => p.name === 'Near Boundary');
    expect(near.serviceYears).toBeCloseTo(5.1, 1);
    expect(near.yearsAfterThis).toBe(0);
    expect(near.arbYear).not.toBeNull();
    expect(near.flags).not.toContain('expiring');
    expect(near.flags.some((f: string) => f.startsWith('arbitration'))).toBe(true);
  });
});
