import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { derivePalette } from '../src/theme.js';

/**
 * The verdict colours, measured where they are actually drawn.
 *
 * A reader sent a screenshot of the pitching page and said the availability
 * column was too blurry to read. It was: the three pills carried fixed colours
 * chosen for a dark background, over a tint of themselves, and in light mode
 * the text and its own backing were within a whisker of the same brightness.
 * Measured against a table row they came to 1.36, 1.36 and 2.05. The floor is
 * 4.5.
 *
 * The theme check reported sixty out of sixty the whole time, for two reasons
 * worth keeping in mind. It only measured colours against the PAGE background,
 * and a table paints itself a shade darker than the page — so it was checking a
 * surface the app never puts these on. And the amber had no token at all, so
 * there was nothing for it to check even in principle.
 *
 * Both are fixed, and this holds them: the arithmetic runs here rather than
 * only in the script, so a palette change that fails cannot be shipped by
 * anybody who forgets to run it.
 */

const channel = (c: number): number => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

function rgb(css: string): [number, number, number] {
  const hsl = /hsl\((-?[\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/.exec(css);
  if (!hsl) {
    const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim());
    if (!hex) throw new Error(`cannot read colour ${css}`);
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const h = Number(hsl[1]) / 360;
  const s = Number(hsl[2]) / 100;
  const l = Number(hsl[3]) / 100;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

const luminance = (css: string): number => {
  const [r, g, b] = rgb(css);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** What `table` in styles.css paints: rgba(0, 0, 0, 0.12) over the page. */
function tableRow(background: string): string {
  const [r, g, b] = rgb(background).map((c) => Math.round(c * 0.88));
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

const AA = 4.5;

/** A club of each kind: dark, light, and one whose colours are nearly white. */
const CLUBS = [
  { name: 'Boston Red Sox', bg: '#BD3039', fg: '#FFFFFF', secondary: '#0C2340', cap: '#0C2340' },
  { name: 'a pale club', bg: '#FFFFFF', fg: '#000000', secondary: '#C4CED4', cap: '#FFFFFF' },
  { name: 'a dark club', bg: '#000000', fg: '#FFFFFF', secondary: '#333333', cap: '#000000' },
];

describe('the colours a verdict is drawn in', () => {
  for (const mode of ['light', 'dark'] as const) {
    for (const club of CLUBS) {
      for (const token of ['--good', '--warn', '--bad'] as const) {
        it(`${token} clears AA on a table row — ${club.name}, ${mode}`, () => {
          const palette = derivePalette(club, mode);
          const value = palette[token];
          expect(value, `${token} is not in the palette at all`).toBeTruthy();
          const measured = contrast(value, tableRow(palette['--bg']));
          expect(
            measured,
            `${token} reads at ${measured.toFixed(2)} on a ${mode} table row`
          ).toBeGreaterThanOrEqual(AA);
        });
      }
    }
  }

  it('is what the old fixed colours failed', () => {
    /*
     * The three the reader was looking at, against his own club's light table.
     * Kept as a record of the size of the problem: this is not a near miss
     * being tightened, it is text that was very nearly invisible.
     */
    const row = tableRow(derivePalette(CLUBS[0], 'light')['--bg']);
    expect(contrast('#6fcf90', row)).toBeLessThan(2);
    expect(contrast('#e2b552', row)).toBeLessThan(2);
    expect(contrast('#e07b7b', row)).toBeLessThan(3);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('the stylesheet', () => {
  it('draws every verdict from the theme', () => {
    const css = read('src/styles.css');
    // The three that were wrong, and nothing else left carrying a dark palette
    expect(css).not.toMatch(/#6fcf90|#e2b552|#e07b7b/);
    expect(css).toMatch(/\.avail-ok \{ color: var\(--good\)/);
    expect(css).toMatch(/\.avail-warn \{ color: var\(--warn\)/);
    expect(css).toMatch(/\.avail-bad \{ color: var\(--bad\)/);
  });
});

describe('the check that missed it', () => {
  it('looks at the surface these are drawn on, not just the page', () => {
    const script = read('scripts/check-theme-contrast.ts');
    expect(script).toMatch(/rowSurface/);
    expect(script).toMatch(/goodRow/);
    expect(script).toMatch(/badRow/);
  });

  it('looks at the amber, which it could not before', () => {
    expect(read('scripts/check-theme-contrast.ts')).toMatch(/warnRow/);
  });
});
