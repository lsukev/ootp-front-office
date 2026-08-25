import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The draft board between drafts, and what a page is allowed to do when it
 * cannot draw itself.
 *
 * A reader opened the board and got a blank screen — not an error, not a
 * spinner, nothing, and no navigation left to go anywhere else. Two faults, one
 * on each side.
 *
 * The endpoint answered a save whose class is not yet published with `batters`
 * and `pitchers`, names the page stopped using long ago, and no `prospects` at
 * all. The board filters and sorts the class as it renders, before it reaches
 * the line that would have said the class is not published — so it read
 * `filter` off nothing and threw. Between drafts, which is most of the year,
 * that was every visit to the page.
 *
 * The blank screen was the second fault and the worse one. Nothing caught the
 * throw, so React unmounted the whole window: one bad read on one page cost the
 * reader the entire app with no way back but quitting it.
 */

beforeAll(() => {
  db.prepare(`UPDATE leagues SET rules_amateur_draft = 1 WHERE league_id = ?`).run(IDS.league);
});

describe('a save whose draft class is not published yet', () => {
  it('answers in the same shape as one that is', async () => {
    /*
     * The page reads `prospects` and `needs` on every answer this endpoint can
     * give, so every answer has to carry them. Whether they are empty is the
     * page's business; whether they exist is not negotiable.
     */
    db.prepare(`UPDATE leagues SET show_draft_pool = 0 WHERE league_id = ?`).run(IDS.league);
    try {
      const d = await request(`/api/draft/${IDS.mlbTeam}`);
      expect(d.poolVisible, 'the pool was visible, so this proves nothing').toBe(false);
      expect(Array.isArray(d.prospects), 'no prospects array — the board would throw').toBe(true);
      expect(Array.isArray(d.needs), 'no needs array — the board would throw').toBe(true);
      expect(d.prospects).toEqual([]);
      expect(d.total).toBe(0);
    } finally {
      db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);
    }
  });

  it('does not still answer with the names the page stopped using', async () => {
    // `batters` and `pitchers` were the shape of an older board entirely
    db.prepare(`UPDATE leagues SET show_draft_pool = 0 WHERE league_id = ?`).run(IDS.league);
    try {
      const d = await request(`/api/draft/${IDS.mlbTeam}`);
      expect(d).not.toHaveProperty('batters');
      expect(d).not.toHaveProperty('pitchers');
    } finally {
      db.prepare(`UPDATE leagues SET show_draft_pool = 1 WHERE league_id = ?`).run(IDS.league);
    }
  });
});

/**
 * Read from the source rather than rendered, for the same reason the sortable
 * headers are: there is no React renderer in this suite, and the property that
 * matters is structural — that every page sits inside the boundary, and that
 * the board does not assume the arrays are there.
 */
const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('a page that cannot draw itself', () => {
  it('is caught rather than taking the window down', () => {
    const app = read('src/App.tsx');
    expect(app, 'no boundary around the pages').toMatch(/<PageBoundary/);
    expect(app, 'the boundary is never closed').toMatch(/<\/PageBoundary>/);
    const boundary = read('src/PageBoundary.tsx');
    // Both halves: one turns the throw into state, the other logs it for a report
    expect(boundary).toMatch(/getDerivedStateFromError/);
    expect(boundary).toMatch(/componentDidCatch/);
  });

  it('remounts cleanly when the reader moves to another page', () => {
    /*
     * Without a key the boundary holds its error across a page change, so
     * leaving the broken page and coming back leaves the reader looking at the
     * same failure on a page that would have rendered.
     */
    expect(read('src/App.tsx')).toMatch(/<PageBoundary\s+key=\{page\}/);
  });

  it('shows the reader what broke and a way out', () => {
    const boundary = read('src/PageBoundary.tsx');
    expect(boundary, 'the message is swallowed').toMatch(/error\.message/);
    expect(boundary, 'no way off the broken page').toMatch(/onLeave/);
  });
});

describe('the board itself', () => {
  it('does not assume the class arrays are there', () => {
    /*
     * Belt as well as braces. The endpoint is fixed, but the filter and the
     * shortlist run before the page decides there is nothing to show, and a
     * page that blanks the app is too expensive a way to learn about the next
     * endpoint that forgets.
     */
    const draft = read('src/pages/Draft.tsx');
    expect(draft).toMatch(/if \(!data\?\.prospects\) return \[\]/);
    expect(draft).toMatch(/data\.needs \?\? \[\]/);
  });
});
