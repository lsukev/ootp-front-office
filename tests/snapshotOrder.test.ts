import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { historyDb, snapshotDates } from '../server/history.js';
import { loadConfig } from '../server/config.js';

/**
 * Snapshots in the order they were taken.
 *
 * A reader sent a screenshot of the development page: eight snapshots kept,
 * seven of them offered in the menu, listed in an order with no meaning, and
 * everything measured against June the ninth when his newest export was June
 * the twenty-third. He asked, reasonably, why that particular date.
 *
 * Because OOTP writes dates without padding and they were sorted as text. Nine
 * beats two on the first character, so "2006-6-9" sorted after "2006-6-23" and
 * the page was certain the ninth was the newest thing it had. Three symptoms,
 * one ORDER BY — and a save whose snapshots all fall on two-digit days, like
 * mine, never shows any of them.
 *
 * The dates below are his, exactly as the screenshot listed them.
 */

const HIS_SNAPSHOTS = [
  '2006-5-5', '2006-5-12', '2006-5-19', '2006-5-26',
  '2006-6-2', '2006-6-9', '2006-6-16', '2006-6-23',
];

beforeAll(() => {
  const save = loadConfig().saveName ?? 'unknown';
  historyDb.prepare(`DELETE FROM rating_snapshots WHERE save_name = ?`).run(save);
  const put = historyDb.prepare(
    `INSERT INTO rating_snapshots (save_name, game_date, player_id, name, team_id, org_id,
                                   level, position, age, cur, pot)
     VALUES (?, ?, 1, 'Someone', 1, 1, 1, 7, 24, 50, 60)`
  );
  for (const d of HIS_SNAPSHOTS) put.run(save, d);
});

describe('the order snapshots come back in', () => {
  it('is the order they were taken, not alphabetical', () => {
    expect(snapshotDates()).toEqual(HIS_SNAPSHOTS);
  });

  it('puts the ninth of June before the twenty-third', () => {
    /*
     * The single comparison the whole report came down to. As text the ninth
     * wins, and it did.
     */
    const dates = snapshotDates();
    expect(dates.indexOf('2006-6-9')).toBeLessThan(dates.indexOf('2006-6-23'));
  });

  it('knows which snapshot is the newest', () => {
    // The page measures everything against this one and calls it your current
    // export; his said June the ninth while he was looking at the twenty-third
    const dates = snapshotDates();
    expect(dates[dates.length - 1]).toBe('2006-6-23');
  });

  it('offers every snapshot but the newest to compare against', () => {
    // Eight kept, seven to choose from — comparing the newest with itself
    // would show nothing at all
    expect(snapshotDates().length).toBe(8);
    expect(snapshotDates().slice(0, -1)).toHaveLength(7);
  });

  it('leaves the stored dates exactly as OOTP wrote them', () => {
    /*
     * They are the key the rows are written under and the value the page hands
     * back to ask for a comparison. Rewriting somebody's history to tidy a sort
     * would be a migration to fix a display problem.
     */
    expect(snapshotDates()).toContain('2006-6-9');
    expect(snapshotDates()).not.toContain('2006-06-09');
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the page that shows them', () => {
  it('pads the dates for reading', () => {
    // Correctly ordered is not the same as legibly ordered: "2006-6-2" above
    // "2006-6-16" reads as a mistake until the eye works out why it is not
    const dev = read('src/pages/Development.tsx');
    expect(dev).toMatch(/padStart\(2, '0'\)/);
    expect(dev).toMatch(/readable\(d\)/);
  });

  it('puts the most recent comparison at the top of the menu', () => {
    expect(read('src/pages/Development.tsx')).toMatch(/\.slice\(0, -1\)\.reverse\(\)/);
  });
});

describe('a way back', () => {
  it('exists at all', () => {
    /*
     * "I also dare to dream that one day there would be a Back button." There
     * was nothing to dream about: the page was one piece of state in an app
     * with no browser chrome around it, so returning meant finding the page
     * again in the menus.
     */
    const app = read('src/App.tsx');
    expect(app, 'no trail of where the reader has been').toMatch(/const \[trail, setTrail\]/);
    expect(app, 'nothing walks it back').toMatch(/const goBack = useCallback/);
    expect(app, 'no button to press').toMatch(/onClick=\{goBack\}/);
  });

  it('unwinds one step at a time rather than toggling', () => {
    // Several pages deep, back should retrace, not flip between the last two
    const app = read('src/App.tsx');
    expect(app).toMatch(/setTrail\(\(t\) => \[\.\.\.t, current\]\)/);
    expect(app).toMatch(/t\.slice\(0, -1\)/);
  });
});

describe('everywhere else a date OOTP wrote is ordered', () => {
  /*
   * The third time this month. The recap picked the wrong day the same way,
   * and the snapshots above were the same fault again — so the sweep is worth
   * pinning rather than repeating.
   */
  const server = (rel: string) => read(path.join('server', rel));

  it('sorts a man\'s injury history by date, not by spelling', () => {
    // The twelve kept were not always the twelve most recent
    expect(server('player.ts')).toMatch(/ORDER BY \$\{DATE_KEY\('date'\)\} DESC LIMIT 12/);
  });

  it('sorts the league calendar by date, not by spelling', () => {
    // These are the draft day and pool date the board counts down to. As text
    // "2006-10-1" sorts before "2006-6-9", so the earliest could be neither
    expect(server('rosterops.ts')).toMatch(/ORDER BY \$\{DATE_KEY\('start_date'\)\} LIMIT 1/);
  });

  it('does not keep a second copy of the same expression', () => {
    // history.ts had its own before this; one of these in the codebase is enough
    expect(server('history.ts')).not.toMatch(/SNAPSHOT_KEY/);
    expect(server('history.ts')).toMatch(/DATE_KEY\('game_date'\)/);
  });
});

/**
 * "I think the Development screen should show positions." — Karen
 *
 * The snapshot has carried the position since the day it was first taken; the
 * endpoint was handing back the raw number and the page was not printing it at
 * all. So this is a column, not a calculation.
 */
describe('the development page', () => {
  it('names the position rather than handing over a number', () => {
    /*
     * Named on the server, the way every other endpoint in the app hands one
     * over, rather than leaving the page to keep its own copy of the map. This
     * file's snapshots carry no ratings, so the wiring is read from the source
     * rather than from a response that would be empty either way.
     */
    const history = read('server/history.ts');
    expect(history).toMatch(/positionName: POSITION_NAMES\[r\.position as number\]/);
  });

  it('shows it', () => {
    const dev = read('src/pages/Development.tsx');
    expect(dev).toMatch(/<Th>Pos<\/Th>/);
    expect(dev).toMatch(/\{c\.positionName\}/);
  });
});

describe('the position names', () => {
  it('come from one place now, not an eleventh copy', () => {
    /*
     * Ten files declare this privately and none has ever disagreed, so this is
     * not a fix — it is somewhere for the next one to come from. The date key
     * was copied the same way and the copies did drift.
     */
    expect(read('server/valuation.ts')).toMatch(/export const POSITION_NAMES/);
    expect(read('server/history.ts')).toMatch(/import \{ POSITION_NAMES \} from '\.\/valuation\.js'/);
  });
});
