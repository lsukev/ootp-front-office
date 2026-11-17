import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every page that prints the composite must be able to stop printing it.
 *
 * The toggle shipped working on four screens and leaking on two. The hover
 * card wrote "OA 57→63" over every name on every page, and the draft board —
 * three grade columns, a ceiling filter and a default sort on potential — did
 * not know the setting existed. Both passed the older display check, because
 * that one accepts `formatRating`, which carries the rounding setting and not
 * this one. A reader who turned the setting on saw it honoured on the roster
 * and ignored the moment he hovered a name.
 *
 * So the composite gets its own check, and a stricter one: printing
 * `oaRating`, `potRating` or a draft prospect's `cur`/`pot` obliges a file to
 * reach for `formatOverallPair` or `overallHidden` — the two things that can
 * actually suppress it. It is a tripwire rather than a proof: it cannot tell
 * which line used them. What it catches is the case that happened twice, a
 * table written without the setting in mind at all.
 *
 * The per-position defensive grades are deliberately outside it. They are
 * `current`/`potential` on a position row, they go through
 * `formatRatingPair`, and they are the ratings the reader who asked for this
 * still plays by.
 */

const SRC = new URL('../src/', import.meta.url).pathname;

/** The composite, interpolated. Deltas are movement, not a grade. */
const COMPOSITE = /\{[^}]*\b\w+\.(cur|pot|oaRating|potRating)\b(?!Delta|ential)/;

/** The two things that can actually suppress it. */
const SUPPRESSOR = /\b(formatOverallPair|overallHidden)\b/;

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe('hiding the composite, page by page', () => {
  const files = sources(SRC).filter((f) => !f.endsWith('ratingScale.ts'));

  it('finds the pages to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('playerHover.tsx'))).toBe(true);
    expect(files.some((f) => f.endsWith('Draft.tsx'))).toBe(true);
  });

  it('leaves every page that shows one able to suppress it', () => {
    const offenders = files.filter((path) => {
      const text = readFileSync(path, 'utf8');
      return COMPOSITE.test(text) && !SUPPRESSOR.test(text);
    });
    expect(
      offenders.map((f) => f.replace(SRC, '')),
      'these print the composite with nothing that can hide it'
    ).toEqual([]);
  });

  it('would have caught both pages that leaked', () => {
    // The hover card, verbatim: formatRating satisfies the older check and
    // carries the rounding setting only
    const hover = 'OA <b>{formatRating(data.oaRating)}</b>';
    expect(COMPOSITE.test(hover)).toBe(true);
    expect(SUPPRESSOR.test(hover)).toBe(false);

    // The draft board's two grade columns
    const board = '<td className="num">{formatRating(p.cur)}</td>';
    expect(COMPOSITE.test(board)).toBe(true);
    expect(SUPPRESSOR.test(board)).toBe(false);
  });

  it('does not ask it of a delta or a position grade', () => {
    expect(COMPOSITE.test('<td>{c.potDelta}</td>')).toBe(false);
    expect(COMPOSITE.test('<td>{c.curDelta > 0 ? "+" : ""}{c.curDelta}</td>')).toBe(false);
    expect(COMPOSITE.test('{formatRatingPair(p.current, p.potential)}')).toBe(false);
  });
});

/**
 * The board without its grades.
 *
 * The three columns, the ceiling filter and the default sort all read from the
 * composite, so the page has to do more than blank a cell — and the colspan on
 * the empty-board row has to count the columns that are actually there. It was
 * a literal 10 against eleven columns from the day the Taken box arrived.
 */
describe('the draft board with the composite hidden', () => {
  const board = readFileSync(join(SRC, 'pages/Draft.tsx'), 'utf8');

  it('drops the grade columns rather than filling them with dashes', () => {
    expect(board).toMatch(/\{!hidden && \(\s*<>\s*<th className="num" onClick=\{\(\) => setSort\('cur'\)\}/);
  });

  it('drops the ceiling filter, which sets a floor on a hidden number', () => {
    expect(board).toContain("if (!hidden && (p.pot ?? 0) < minPot) return false;");
  });

  it('does not order the board by a column nobody can see', () => {
    expect(board).toContain("? 'boardRank'");
    // ...and reads a rank low-first, rather than keeping potential's descending
    expect(board).toContain('const dir = key === sortKey ? sortDir : 1;');
  });

  it('counts the columns for the empty row instead of hardcoding them', () => {
    expect(board).toContain('colSpan={hidden ? 8 : 11}');
    expect(board, 'the stale literal is back').not.toContain('colSpan={10}');
  });
});
