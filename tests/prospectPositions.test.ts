import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * Two small things a reader asked for on the same day.
 *
 * "Is it possible to make Current and Potential Ability on Development screen
 * sortable?" and "Prospects page would benefit from getting primary positions
 * shown, please. Just like Development page now does."
 *
 * Both were already in the data. The farm page is read looking for a catcher
 * or an arm, the same as the development page is, and it was the one page that
 * knew the position and did not print it.
 */

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

const FARM_BAT = 9850;
const FARM_ARM = 9851;

beforeAll(() => {
  // The base fixture's farm hands fall short of the sample minimums, so the
  // page is empty and an empty check is not a pass
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Farm', ?, 22, ?, ?, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  );
  player.run(FARM_BAT, 'Catcher', 2, 0, 85, IDS.aaaTeam, IDS.mlbTeam);
  player.run(FARM_ARM, 'Arm', 1, 11, 86, IDS.aaaTeam, IDS.mlbTeam);
  for (const id of [FARM_BAT, FARM_ARM]) {
    db.prepare(`INSERT INTO team_roster VALUES (?, ?, 1)`).run(IDS.aaaTeam, id);
  }
  db.prepare(
    `INSERT INTO players_career_batting_stats
       (player_id, year, team_id, league_id, level_id, split_id, pa, ab, h, d, t, hr,
        bb, ibb, hp, sf, k, sb, cs, r, rbi, war)
     VALUES (?, ?, ?, ?, 2, 1, 300, 270, 90, 18, 2, 12, 25, 0, 3, 2, 55, 4, 1, 45, 50, 1.5)`
  ).run(FARM_BAT, SEASON, IDS.aaaTeam, IDS.league);
  db.prepare(
    `INSERT INTO players_career_pitching_stats
       (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k,
        hra, hp, bf, g, gs, w, l, s, hld, war)
     VALUES (?, ?, ?, ?, 2, 1, 210, 15, 18, 55, 20, 80, 4, 3, 290, 14, 14, 6, 2, 0, 0, 1.8)`
  ).run(FARM_ARM, SEASON, IDS.aaaTeam, IDS.league);
});

describe('the farm page', () => {
  it('names every prospect\'s position', async () => {
    const d = await request(`/api/prospects/${IDS.mlbTeam}`);
    const all = [...(d.batters ?? []), ...(d.pitchers ?? [])] as Array<{ positionName: string }>;
    expect(all.length, 'no prospects to check').toBeGreaterThan(0);
    for (const p of all) expect(typeof p.positionName).toBe('string');
  });

  it('calls a pitcher a pitcher', async () => {
    const d = await request(`/api/prospects/${IDS.mlbTeam}`);
    const arms = (d.pitchers ?? []) as Array<{ positionName: string }>;
    for (const p of arms) expect(p.positionName).toBe('P');
  });

  it('shows it', () => {
    expect(read('src/pages/Prospects.tsx')).toMatch(/<Th>Pos<\/Th>/);
    expect(read('src/pages/Prospects.tsx')).toMatch(/\{p\.positionName\}/);
  });
});

describe('the development page', () => {
  const dev = () => read('src/pages/Development.tsx');

  it('can be sorted by current and potential change', () => {
    // The two he asked for by name
    const src = dev();
    expect(src).toMatch(/key: 'cur'.*curDelta/s);
    expect(src).toMatch(/key: 'pot'.*potDelta/s);
  });

  it('sorts a number biggest-first and a name alphabetically', () => {
    /*
     * Somebody sorting by a rating change came for the big movers; somebody
     * sorting by name came for the alphabet.
     */
    expect(dev()).toMatch(/setDir\(key === 'name' \|\| key === 'pos' \? 1 : -1\)/);
  });

  it('leaves the prose column alone', () => {
    // "What changed" sorts to nothing useful, so it is not offered
    const src = dev();
    expect(src).toMatch(/<Th>What changed<\/Th>/);
    expect(src).not.toMatch(/key: 'details'/);
  });

  it('gives each table its own order', () => {
    /*
     * Stock Up and Stock Down are two questions. Ordering one by potential
     * should not reorder the other underneath the reader.
     */
    expect(dev()).toMatch(/function DevTable[^]*?const \[sortKey, setSortKey\] = useState/);
  });
});

describe('the sortable header', () => {
  it('lives in one place rather than a third private copy', () => {
    /*
     * Player Search grew one and the draft board grew another. The position
     * names and the date key were each copied into ten files before anybody
     * noticed, and the date key copies drifted.
     */
    expect(read('src/Th.tsx')).toMatch(/export function SortableTh/);
    expect(read('src/pages/Development.tsx')).toMatch(/import \{ Th, SortableTh \} from '\.\.\/Th'/);
  });

  it('keeps the glossary definition a plain header would have had', () => {
    // A column that explains itself should not stop doing so on becoming sortable
    expect(read('src/Th.tsx')).toMatch(/const definition = tip \?\? \(label \? define\(label\) : undefined\);[^]*?SortableTh|SortableTh[^]*?define\(label\)/);
  });
});
