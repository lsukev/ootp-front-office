import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every page that prints a grade must print it the way the setting asks.
 *
 * The increments-of-five toggle worked on the player card and the hover card
 * and nowhere else: the depth chart, the farm system and the draft board all
 * rendered the raw number, so turning it on changed one screen out of four and
 * looked broken rather than partial. A setting is only as honest as the last
 * page that remembered it, and remembering is not something to leave to
 * whoever writes the next table.
 *
 * So this walks the source instead. Any file interpolating a grade has to pull
 * in the formatter — which is not proof it used it on that line, but it does
 * catch the case that actually happened: a new table written without the
 * setting in mind at all.
 */

const SRC = new URL('../src/', import.meta.url).pathname;

/** Grades. Deltas are excluded: a change of +1 is movement, not a grade. */
const GRADE = /\{[^}]*\b\w+\.(cur|pot|oaRating|potRating)\b(?!Delta|ential)/;

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(entry)) found.push(path);
  }
  return found;
}

describe('showing a grade', () => {
  const files = sources(SRC);

  it('finds the pages to check', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('DepthChart.tsx'))).toBe(true);
  });

  it('goes through the formatter on every page that shows one', () => {
    const offenders = files.filter((path) => {
      const text = readFileSync(path, 'utf8');
      if (path.endsWith('ratingScale.ts')) return false;
      /*
       * Either formatter counts. formatOverallPair is the composite one — it
       * carries the hide-overall setting as well as the rounding — and a page
       * that calls it is as safe as one calling formatRating. Matching only
       * the older name failed three pages the day the second one arrived.
       */
      return GRADE.test(text) && !/\bformat(Rating|OverallPair)\b/.test(text);
    });
    expect(
      offenders.map((f) => f.replace(SRC, '')),
      'these render a grade without going through a formatter'
    ).toEqual([]);
  });

  it('is a check that would have caught the pages that were missed', () => {
    // The exact shape the depth chart used: a raw grade, no formatter in sight
    const wasWrong = `<span>{p.cur ?? '?'}{p.pot !== null ? \`→\${p.pot}\` : ''}</span>`;
    expect(GRADE.test(wasWrong)).toBe(true);
  });

  it('does not flag a delta, which is movement rather than a grade', () => {
    expect(GRADE.test('<td>{c.curDelta > 0 ? "+" : ""}{c.curDelta}</td>')).toBe(false);
    expect(GRADE.test('<td>{c.potDelta}</td>')).toBe(false);
  });
});
