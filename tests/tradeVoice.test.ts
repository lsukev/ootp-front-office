import { describe, expect, it } from 'vitest';
import { personasFor, tradeVoice } from '../server/staff.js';
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

/**
 * The same man on the staff list.
 *
 * The general manager was reachable only through a trade verdict, which is a
 * narrow way to talk to the person whose job the rest of it is. He is a voice
 * you can pick now — and he must be the same voice, because a club whose
 * verdict comes from one man and whose chat comes from another has two front
 * offices.
 */
describe('the general manager on the staff list', () => {
  const listed = () => personasFor(IDS.mlbTeam);

  it('is offered alongside the coaches', () => {
    beHuman('Sam', 'Player');
    const gm = listed().find((p) => p.id === 'gm');
    expect(gm).toBeDefined();
    expect(gm!.name).toBe('Web Ivey');
  });

  it('is the man the trade desk answers as', () => {
    beHuman('Sam', 'Player');
    const gm = listed().find((p) => p.id === 'gm')!;
    const desk = tradeVoice(IDS.mlbTeam);
    expect(gm.name).toBe(desk.name);
    expect(gm.role).toBe(desk.role);
  });

  it('steps down to the assistant here too when you hold the chair', () => {
    beHuman('Web', 'Ivey');
    const gm = listed().find((p) => p.id === 'gm')!;
    expect(gm.name).toBe('Del Faraday');
    expect(gm.role).toBe('assistant general manager');
    beHuman('Sam', 'Player');
  });

  it('knows his own record, so he answers as himself', () => {
    beHuman('Sam', 'Player');
    expect(listed().find((p) => p.id === 'gm')!.facts.length).toBeGreaterThan(0);
  });

  it('does not appear at all where the save names nobody', () => {
    // Better absent than a chat tab addressed to "the front office"
    expect(personasFor(999_999).some((p) => p.id === 'gm')).toBe(false);
  });

  it('leaves the rest of the staff where they were', () => {
    beHuman('Sam', 'Player');
    const ids = listed().map((p) => p.id);
    // The seats this fixture actually fills; the others are absent here for
    // want of a coach rather than for anything this change did
    for (const id of ['analyst', 'manager']) expect(ids).toContain(id);
  });
});
