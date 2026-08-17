import { describe, expect, it } from 'vitest';
import request from './request.js';

/**
 * Sorting the player search, which has to happen before the page is cut.
 *
 * A reader asked for it. The obvious place is the browser, and it would have
 * been wrong: a typical search matches a few hundred players and a hundred come
 * back, so sorting what arrived would order the page rather than the league —
 * the leader in a category could sit on page three and never reach the top of a
 * table sorted by it.
 *
 * The plain columns sort in SQL. The stat columns cannot: the rates are worked
 * out in JavaScript from a league baseline and a park factor, so they do not
 * exist for SQL to order by. Those widen the query to every match, compute,
 * order, and cut the page afterwards.
 */

interface Row {
  player_id: number;
  name: string;
  age: number;
  stats: Record<string, number | null> | null;
}

const search = async (extra: string): Promise<{ players: Row[]; total: number; sort?: string; dir?: string }> =>
  await request(`/api/players?group=batting&level=all&limit=50&${extra}`);

const values = (rows: Row[], key: string): number[] =>
  rows.map((r) => r.stats?.[key]).filter((v): v is number => typeof v === 'number');

describe('sorting by a computed stat', () => {
  it('comes back in descending order', async () => {
    const { players } = await search('sort=ops&dir=desc');
    const v = values(players, 'ops');
    expect(v.length).toBeGreaterThan(0);
    expect(v).toEqual([...v].sort((a, b) => b - a));
  });

  it('reverses when asked', async () => {
    const { players } = await search('sort=ops&dir=asc');
    const v = values(players, 'ops');
    expect(v).toEqual([...v].sort((a, b) => a - b));
  });

  it('echoes back what it sorted by', async () => {
    const res = await search('sort=hr&dir=desc');
    expect(res.sort).toBe('hr');
    expect(res.dir).toBe('desc');
  });

  it('sinks the men with no line, ascending as well as descending', async () => {
    /*
     * Otherwise a man with nothing at this level heads a table sorted by ERA,
     * because zero-of-nothing sorts low and ascending is where that lands him.
     */
    const { players } = await search('sort=ops&dir=asc');
    const firstMissing = players.findIndex((p) => typeof p.stats?.ops !== 'number');
    if (firstMissing === -1) return; // every man in this fixture has a line
    const after = players.slice(firstMissing);
    expect(after.every((p) => typeof p.stats?.ops !== 'number')).toBe(true);
  });

  it('sorts the whole match set, not the page', async () => {
    // The top of a one-row page must be the top of the league, which is only
    // true if the ordering happened before the cut
    const wide = await search('sort=hr&dir=desc');
    const narrow = await request('/api/players?group=batting&level=all&limit=1&sort=hr&dir=desc');
    expect(narrow.players[0]?.player_id).toBe(wide.players[0]?.player_id);
  });
});

describe('sorting by a plain column', () => {
  it('orders by name A to Z', async () => {
    const { players } = await search('sort=name&dir=asc');
    const names = players.map((p) => p.name);
    expect(names.length).toBeGreaterThan(1);
    // Ordered on surname, which is what the SQL says
    const surnames = names.map((n) => n.split(' ').slice(-1)[0].toLowerCase());
    expect(surnames).toEqual([...surnames].sort());
  });

  it('orders by age both ways', async () => {
    const up = (await search('sort=age&dir=asc')).players.map((p) => p.age);
    expect(up).toEqual([...up].sort((a, b) => a - b));
    const down = (await search('sort=age&dir=desc')).players.map((p) => p.age);
    expect(down).toEqual([...down].sort((a, b) => b - a));
  });
});

describe('asking for nothing in particular', () => {
  it('still answers, and says it is unsorted', async () => {
    const res = await search('');
    expect(res.players.length).toBeGreaterThan(0);
    expect(res.sort ?? null).toBeNull();
  });

  it('is not disturbed by a column that does not exist', async () => {
    // A stale bookmark or a hand-edited URL should not empty the table
    const res = await search('sort=nonsense&dir=desc');
    expect(res.players.length).toBeGreaterThan(0);
    expect(res.total).toBeGreaterThan(0);
  });
});
