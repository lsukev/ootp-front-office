import { describe, expect, it } from 'vitest';
import request from './request.js';

/**
 * Narrowing a league down to the men you are actually looking for.
 *
 * The page listed four hundred and sixty players and offered a name box, which
 * answers "where is Judge" and nothing else. A left-handed shortstop under 25
 * was a question it could not be asked.
 *
 * Two things here are easy to get wrong and both would pass a glance at the
 * screen. A switch hitter must answer to both sides — he does bat left, and
 * leaving him out of that search hides exactly the players a platoon question
 * is about. And the total above the table has to describe the same set as the
 * rows beneath it: they are separate queries, and a filter applied to one and
 * not the other reads as a paging bug rather than a wrong count.
 */

const search = (query: string) => request(`/api/players?${query}`);

describe('filtering the league', () => {
  it('narrows to one position', async () => {
    const all = await search('group=batting&level=1');
    const short = await search('group=batting&level=1&position=6');
    expect(short.total).toBeGreaterThan(0);
    expect(short.total).toBeLessThan(all.total);
    for (const p of short.players) expect(p.positionName).toBe('SS');
  });

  it('counts a switch hitter as batting left, because he does', async () => {
    const left = await search('group=batting&level=1&bats=2');
    expect(left.players.length).toBeGreaterThan(0);
    for (const p of left.players) expect(['L', 'S']).toContain(p.bats);
    expect(left.players.some((p: { bats: string }) => p.bats === 'S')).toBe(true);
  });

  it('narrows by throwing hand, where there is no third option', async () => {
    const lefties = await search('group=pitching&level=1&throws=2');
    for (const p of lefties.players) expect(p.throws).toBe('L');
  });

  it('takes an age range from either end', async () => {
    const young = await search('group=batting&level=1&maxAge=25');
    for (const p of young.players) expect(p.age).toBeLessThanOrEqual(25);
    const old = await search('group=batting&level=1&minAge=33');
    for (const p of old.players) expect(p.age).toBeGreaterThanOrEqual(33);
  });

  it('combines them rather than letting the last one win', async () => {
    const combined = await search('group=batting&level=1&position=6&bats=2&maxAge=25');
    const justPosition = await search('group=batting&level=1&position=6');
    expect(combined.total).toBeLessThanOrEqual(justPosition.total);
    for (const p of combined.players) {
      expect(p.positionName).toBe('SS');
      expect(['L', 'S']).toContain(p.bats);
      expect(p.age).toBeLessThanOrEqual(25);
    }
  });

  it('keeps the total and the rows describing the same players', async () => {
    // Separate queries: a filter applied to one and not the other looks like a
    // paging fault and is a great deal harder to spot than a wrong list
    const r = await search('group=batting&level=1&position=6&bats=2&maxAge=25&limit=300');
    expect(r.players.length).toBe(r.total);
  });

  it('ignores a filter left empty rather than matching nothing', async () => {
    const bare = await search('group=batting&level=1');
    const empty = await search('group=batting&level=1&position=&bats=&minAge=&maxAge=&minPt=');
    expect(empty.total).toBe(bare.total);
  });

  it('survives a filter that is not a number', async () => {
    const r = await search('group=batting&level=1&position=abc&minAge=NaN');
    expect(r.total).toBeGreaterThan(0);
  });
});
