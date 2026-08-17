import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { define } from '../src/glossary.js';
import { BATTING_STATS, PITCHING_STATS } from '../src/stats.js';

/**
 * A sortable header still explains itself.
 *
 * Making the headers clickable took the hover definitions away with them: the
 * first version handed the explanation to the browser's title attribute
 * instead of the Tip component, so every stat column on Player Search silently
 * lost the definition it had. The sort arrived and the documentation left, and
 * nothing failed — it just quietly stopped being there, which is how a reader
 * came to report it rather than a test.
 *
 * This reads the page's source, because that is where the mistake lived. The
 * behaviour is a composition of two components and a CSS hover; what can be
 * pinned down cheaply is that the header still reaches for Tip and the
 * glossary at all.
 */

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/pages/Players.tsx'), 'utf8'
);

describe('the sortable header on player search', () => {
  it('renders the hover explanation rather than a title attribute', () => {
    const header = source.slice(source.indexOf('function SortTh'));
    const body = header.slice(0, header.indexOf('\n  }\n'));
    expect(body, 'SortTh no longer renders a Tip').toContain('<Tip');
    expect(body, 'SortTh went back to the browser title attribute').not.toMatch(/title=\{/);
  });

  it('consults the glossary, so a documented column needs no second entry', () => {
    const header = source.slice(source.indexOf('function SortTh'));
    expect(header.slice(0, header.indexOf('\n  }\n'))).toContain('define(');
  });

  it('is used for the fixed columns as well as the stats', () => {
    for (const label of ['Player', 'Age', 'Pos', 'Team']) {
      expect(source, `${label} is no longer sortable`).toMatch(
        new RegExp(`<SortTh sortKey="[a-z]+">${label}</SortTh>`)
      );
    }
  });
});

describe('the columns a header can offer', () => {
  it('every fixed column it documents has a glossary entry', () => {
    // The four fixed headers rely on the glossary rather than a passed tip, so
    // a missing entry means a silently undocumented column
    for (const label of ['Player', 'Age', 'Pos', 'Team']) {
      expect(define(label), `${label} has no glossary entry`).toBeTruthy();
    }
  });

  it('every batting and pitching stat carries its own description', () => {
    for (const [group, stats] of [['batting', BATTING_STATS], ['pitching', PITCHING_STATS]] as const) {
      for (const stat of stats) {
        expect(stat.desc, `${group} ${stat.key} has no description to show`).toBeTruthy();
      }
    }
  });
});
