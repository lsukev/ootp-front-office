import { describe, expect, it } from 'vitest';
import { derivePalette } from '../src/theme.js';

/**
 * The palette is generated from whatever colours a club happens to use, so the
 * interface has to stay readable no matter how bright, dark or washed out those
 * are. `npm run check:theme` sweeps all thirty clubs in a real save; this covers
 * the same ground for CI, where there is no save to read, using the colours that
 * actually broke it — a pure-white primary, a low-luminance accent, and a pair
 * that is nearly black on nearly black.
 */

const HARD_CASES: Array<{ name: string; colors: Parameters<typeof derivePalette>[0] }> = [
  { name: 'white primary (White Sox)', colors: { bg: '#FFFFFF', fg: '#000000', secondary: '#C4CED4', cap: '#000000' } },
  { name: 'near-black on black', colors: { bg: '#111111', fg: '#1A1A1A', secondary: '#000000', cap: '#0A0A0A' } },
  { name: 'saturated orange (Giants)', colors: { bg: '#FD5A1E', fg: '#27251F', secondary: '#AE8F6F', cap: '#000000' } },
  { name: 'deep red (Nationals)', colors: { bg: '#AB0003', fg: '#FFFFFF', secondary: '#14225A', cap: '#0A2351' } },
  { name: 'pale yellow', colors: { bg: '#FFF9A6', fg: '#FFFFE0', secondary: '#FFFFFF', cap: '#FFFFF0' } },
  { name: 'missing colours', colors: { bg: null, fg: null, secondary: null, cap: null } },
];

function rgb(css: string): [number, number, number] {
  const m = /hsl\((-?[\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/.exec(css);
  if (!m) {
    const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim());
    if (!hex) throw new Error(`unreadable colour: ${css}`);
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

function contrast(a: string, b: string): number {
  const lum = (css: string): number => {
    const ch = (c: number): number => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const [r, g, bl] = rgb(css);
    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(bl);
  };
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const AA = 4.5;

describe('generated palettes stay readable', () => {
  for (const mode of ['dark', 'light'] as const) {
    for (const { name, colors } of HARD_CASES) {
      it(`${name} in ${mode} mode meets WCAG AA`, () => {
        const p = derivePalette(colors, mode);
        // Both modes are generated from the same club colours, and a palette
        // that reads on black can vanish on white
        expect(contrast(p['--text'], p['--bg'])).toBeGreaterThanOrEqual(AA);
        expect(contrast(p['--muted'], p['--bg'])).toBeGreaterThanOrEqual(AA);
        expect(contrast(p['--accent'], p['--bg'])).toBeGreaterThanOrEqual(AA);
        expect(contrast(p['--accent'], p['--panel'])).toBeGreaterThanOrEqual(AA);
        // Text printed ON the accent, which is the pair most easily forgotten
        expect(contrast(p['--accent-ink'], p['--accent'])).toBeGreaterThanOrEqual(AA);
      });
    }
  }
});
