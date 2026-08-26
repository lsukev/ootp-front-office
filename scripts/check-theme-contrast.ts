import Database from 'better-sqlite3';
import { derivePalette } from '../src/theme.js';

const db = new Database(
  './data/league.db',
  { readonly: true }
);

function hslToRgb(css: string): [number, number, number] {
  const m = /hsl\((-?[\d.]+),\s*([\d.]+)%,\s*([\d.]+)%\)/.exec(css);
  if (!m) {
    const hex = /^#?([0-9a-f]{6})$/i.exec(css.trim());
    if (!hex) throw new Error('bad color ' + css);
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const h = Number(m[1]) / 360;
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255];
}

function lum(css: string): number {
  const [r, g, b] = hslToRgb(css);
  const ch = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
const ratio = (a: string, b: string) => {
  const l1 = lum(a);
  const l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
};

/**
 * The colour plusColor mixes for a stat, resolved so Node can weigh it.
 *
 * That function returns a color-mix() between the theme's good/bad and the body
 * text, which only a browser evaluates — so this reproduces the interpolation.
 * It is here because the check reported 60/60 while every stat column in light
 * mode was an unreadable neon green: plusColor was building its own fixed
 * hsl(), nothing in this script looked at it, and a reader had to notice.
 *
 * The weakest visible mix is the hardest case, since it is the one closest to
 * plain text and furthest from a colour chosen for contrast.
 */
function statMix(end: string, text: string, sharePct: number): string {
  const a = hslToRgb(end);
  const b = hslToRgb(text);
  const f = sharePct / 100;
  const mixed = a.map((v, i) => Math.round(v * f + b[i] * (1 - f)));
  return `#${mixed.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

const teams = db
  .prepare(
    `SELECT name, nickname, background_color_id AS bg, text_color_id AS fg,
            jersey_secondary_color_id AS secondary, ballcaps_main_color_id AS cap
     FROM teams WHERE level = 1 AND allstar_team = 0 ORDER BY name`
  )
  .all() as Array<{ name: string; nickname: string; bg: string; fg: string; secondary: string; cap: string }>;

/**
 * What a table row is drawn on: `rgba(0, 0, 0, 0.12)` over the page, which is
 * what `table` paints in styles.css. Anything measured against the bare
 * background is measured against a surface the app never puts text on.
 */
function rowSurface(background: string): string {
  const [r, g, b] = hslToRgb(background);
  // Returned as hex because that is the other notation the parser above reads
  const over = (c: number) => Math.round(c * 0.88).toString(16).padStart(2, '0');
  return `#${over(r)}${over(g)}${over(b)}`;
}

const AA = 4.5;
let failures = 0;
// Both modes are generated from the same team colors, so both have to be
// checked — a palette that reads well on black can vanish on white.
const MODES = ['dark', 'light'] as const;
for (const mode of MODES) {
console.log(`\n── ${mode} mode ──`);
for (const t of teams) {
  const p = derivePalette(t, mode);
  const checks: Record<string, number> = {
    text: ratio(p['--text'], p['--bg']),
    muted: ratio(p['--muted'], p['--bg']),
    accentBg: ratio(p['--accent'], p['--bg']),
    accentPanel: ratio(p['--accent'], p['--panel']),
    ink: ratio(p['--accent-ink'], p['--accent']),
    plate: ratio(p['--team-fg'], p['--team']),
    good: ratio(p['--good'], p['--bg']),
    bad: ratio(p['--bad'], p['--bg']),
    /*
     * The verdict colours where they are actually drawn.
     *
     * Against the page background is not the test that matters: every one of
     * these is used inside a table, and a table paints itself a shade darker
     * than the page. This check reported 60/60 while the availability pills on
     * the pitching page sat at 1.4 in light mode, because it had never looked
     * at the surface they were on — or at the amber, which had no token and so
     * could not be looked at.
     */
    goodRow: ratio(p['--good'], rowSurface(p['--bg'])),
    warnRow: ratio(p['--warn'], rowSurface(p['--bg'])),
    badRow: ratio(p['--bad'], rowSurface(p['--bg'])),
    // The stat columns, at the faintest mix the app will actually draw
    statGood: ratio(statMix(p['--good'], p['--text'], 45), p['--bg']),
    statBad: ratio(statMix(p['--bad'], p['--text'], 45), p['--bg']),
    // And at full strength, which is what an outlier gets
    statGoodMax: ratio(statMix(p['--good'], p['--text'], 100), p['--bg']),
    statBadMax: ratio(statMix(p['--bad'], p['--text'], 100), p['--bg']),
  };
  const bad = Object.entries(checks).filter(([, v]) => v < AA);
  if (bad.length) failures++;
  const flag = bad.length ? '❌' : '✓';
  console.log(
    `${flag} ${(t.name + ' ' + t.nickname).padEnd(26)} ` +
      Object.entries(checks)
        .map(([k, v]) => `${k} ${v.toFixed(1)}`)
        .join('  ') +
      `   accent=${p['--accent']}`
  );
}
}
const total = teams.length * MODES.length;
console.log(`\n${total - failures}/${total} team/mode combinations pass WCAG AA on every pair`);
if (failures > 0) process.exit(1);
