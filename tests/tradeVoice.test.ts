import { describe, expect, it } from 'vitest';
import { tradeVoice } from '../server/staff.js';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who answers on the trade desk.
 *
 * It reads as "the AI" only until you notice the save already contains the man
 * whose job this is. The one case worth guarding is the save where you took
 * that job yourself: speaking as the general manager would then have the app
 * arguing with you in your own name, so it steps down to the assistant.
 */

const beHuman = (first: string, last: string) =>
  db.prepare(`UPDATE human_managers SET first_name = ?, last_name = ?`).run(first, last);

describe('the trade voice', () => {
  it('is the general manager, by name', () => {
    beHuman('Sam', 'Player');
    const v = tradeVoice(IDS.mlbTeam);
    expect(v.name).toBe('Web Ivey');
    expect(v.role).toBe('general manager');
  });

  it('knows who he is, so he can answer as himself', () => {
    beHuman('Sam', 'Player');
    expect(tradeVoice(IDS.mlbTeam).facts.length).toBeGreaterThan(0);
  });

  it('steps down to the assistant when you hold the job yourself', () => {
    beHuman('Web', 'Ivey');
    const v = tradeVoice(IDS.mlbTeam);
    expect(v.name).toBe('Del Faraday');
    expect(v.role).toBe('assistant general manager');
    beHuman('Sam', 'Player');
  });

  it('does not care how the name is capitalised', () => {
    beHuman('web', 'IVEY');
    expect(tradeVoice(IDS.mlbTeam).name).toBe('Del Faraday');
    beHuman('Sam', 'Player');
  });

  it('speaks as the office rather than inventing a man', () => {
    expect(tradeVoice(999_999).name).toBe('the front office');
  });

  it('tells the page who to put on the button', async () => {
    beHuman('Sam', 'Player');
    const r = await request(`/api/trade/voice/${IDS.mlbTeam}`);
    expect(r).toEqual({ name: 'Web Ivey', role: 'general manager' });
  });
});
