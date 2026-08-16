import { describe, expect, it } from 'vitest';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Whose player he is, carried in the data rather than left to be recalled.
 *
 * A reader asked his assistant about a man at Norfolk and was told he was not
 * in the organisation — it had the club filed under the Astros, from real
 * baseball. The export was right and always had been. The row the assistant
 * was reading named the club and stopped, so whose club it was could only come
 * from memory, and memory is the one source certainly wrong about a simulated
 * league.
 *
 * Telling a model not to guess is advice, and the reader's own experiment
 * showed how far that goes: the same question answered correctly on Opus and
 * wrongly on Haiku. Leaving it nothing to guess at is not advice. Every player
 * these tools return now names his parent club, so an assistant that gets the
 * affiliation wrong has to contradict the line it is quoting.
 */

interface Found {
  name: string;
  team: string | null;
  organization: string | null;
  inYourOrg: boolean | null;
}

const search = async (q: string): Promise<Found[]> =>
  (await request(`/api/players?q=${q}&group=batting&level=all&limit=25`)).players as Found[];

describe('a player found by search', () => {
  it('names the club he plays for and the organisation that owns him', async () => {
    const him = (await search('Op')).find((p) => p.name === 'Op Tioned');
    expect(him, 'the optioned man was not found').toBeDefined();
    // He is at the affiliate; the organisation is the parent club
    expect(him?.team).toContain('Farm Hands');
    expect(him?.organization).toContain('Test Nine');
  });

  it('says outright whether he is one of ours', async () => {
    const him = (await search('Op')).find((p) => p.name === 'Op Tioned');
    expect(him?.inYourOrg).toBe(true);
  });

  it('says so for a man who is not', async () => {
    const him = (await search('Gone')).find((p) => p.name === 'Gone Away');
    expect(him, 'the traded man was not found').toBeDefined();
    expect(him?.inYourOrg).toBe(false);
    expect(him?.organization).toContain('Other Club');
  });

  it('never leaves the organisation unsaid for a rostered player', async () => {
    for (const p of await search('a')) {
      if (!p.team || p.team === 'Free Agent') continue;
      expect(p.organization, `${p.name} carried a club but no organisation`).toBeTruthy();
    }
  });
});

describe('a player dossier', () => {
  it('names the organisation too, so the deeper lookup is no weaker', async () => {
    const bio = await request(`/api/player/${IDS.optioned}`);
    const b = bio.bio ?? bio;
    expect(b.team).toContain('Farm Hands');
    expect(b.organization).toContain('Test Nine');
  });
});
