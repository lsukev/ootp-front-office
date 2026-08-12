import { describe, expect, it } from 'vitest';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Building the order from production instead of talent.
 *
 * OOTP's offensive value is a projection from current ratings, and over the
 * rest of a season a projection beats a third of a season of results — so it
 * stays the default. This exists because a man on a .274 on-base percentage
 * batting cleanup on the strength of his ratings is defensible and still hard
 * to look at, and plenty of managers want the card to say what has happened.
 *
 * The failure this guards against is the one it shipped with in draft: the
 * starters are spread copies taken before the season lines are assembled, so
 * setting the sort key on the candidate list alone left every starter ranked
 * zero and the toggle did nothing whatsoever. A silent no-op looks exactly
 * like a working feature on a roster where the two orders agree.
 */

const card = (sort: string) => request(`/api/lineup/${IDS.mlbTeam}?vs=r&style=saber&sort=${sort}`);
const names = (r: { lineup: Array<{ name: string }> }) => r.lineup.map((l) => l.name);

describe('sorting the order', () => {
  it('accepts both and returns a full card either way', async () => {
    for (const sort of ['talent', 'production']) {
      const r = await card(sort);
      expect(r.lineup.length, sort).toBeGreaterThan(0);
      for (const l of r.lineup) expect(l.name, sort).toBeTruthy();
    }
  });

  it('gives every batter a rank that is not zero', async () => {
    // The no-op left them all at zero, and a sort of equal keys is stable —
    // so the order looked plausible while ignoring the request entirely
    const r = await card('production');
    const batters = r.lineup.filter((l: { positionName: string }) => l.positionName !== 'P');
    expect(batters.length).toBeGreaterThan(0);
    expect(batters.every((l: { off: number }) => typeof l.off === 'number')).toBe(true);
  });

  it('falls back to talent for anything it does not recognise', async () => {
    const odd = await card('nonsense');
    const talent = await card('talent');
    expect(names(odd)).toEqual(names(talent));
  });

  it('still fields a legal card — nine slots, no repeats', async () => {
    for (const sort of ['talent', 'production']) {
      const r = await card(sort);
      const ids = r.lineup.map((l: { player_id: number }) => l.player_id);
      expect(new Set(ids).size, sort).toBe(ids.length);
      const slots = r.lineup.map((l: { slot: number }) => l.slot);
      expect(slots, sort).toEqual([...slots].sort((a, b) => a - b));
    }
  });
});
