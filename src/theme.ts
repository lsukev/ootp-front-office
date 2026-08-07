/**
 * Derives a full dark-mode palette from a team's colors as exported by OOTP.
 *
 * The design constraint: this app is dense with tables, so the page must stay
 * dark and readable no matter what a team's colors are. Team identity comes
 * through as a *tint* on the dark surfaces plus a vivid accent, rather than
 * letting (say) a white or yellow primary wash out the page.
 */

export interface TeamColors {
  bg: string | null;
  fg: string | null;
  secondary: string | null;
  cap: string | null;
}

interface HSL { h: number; s: number; l: number }

function hexToHsl(hex: string): HSL | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s: s * 100, l: l * 100 };
}

const hsl = ({ h, s, l }: HSL): string => `hsl(${h.toFixed(0)}, ${s.toFixed(0)}%, ${l.toFixed(0)}%)`;

const channel = (c: number) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminanceRgb = (r: number, g: number, b: number) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

function relativeLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return luminanceRgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
}

function hslLuminance({ h, s, l }: HSL): number {
  const sn = s / 100;
  const ln = l / 100;
  if (sn === 0) return luminanceRgb(ln * 255, ln * 255, ln * 255);
  const q = ln < 0.5 ? ln * (1 + sn) : ln + sn - ln * sn;
  const p = 2 * ln - q;
  const hn = h / 360;
  const toChannel = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return luminanceRgb(toChannel(hn + 1 / 3) * 255, toChannel(hn) * 255, toChannel(hn - 1 / 3) * 255);
}

const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/**
 * Raises an accent's lightness until it clears WCAG AA against the lightest
 * surface it sits on. Blue and purple hues are inherently dark, so a fixed
 * lightness that works for gold leaves them unreadable.
 */
function brightenUntilReadable(accent: HSL, against: HSL, target = 4.6): HSL {
  let candidate = accent;
  const surface = hslLuminance(against);
  for (let l = accent.l; l <= 86; l += 2) {
    candidate = { ...accent, l };
    if (contrast(hslLuminance(candidate), surface) >= target) return candidate;
  }
  return candidate;
}

const DEFAULT_TEAM = '#1a4a2e';
const DEFAULT_ACCENT: HSL = { h: 41, s: 78, l: 60 };
const DEFAULT_HUE = 152;
const DEFAULT_SAT = 30;
/** Cool slate + silver, for teams whose palette is pure greyscale (e.g. the White Sox). */
const NEUTRAL_HUE = 220;
const SILVER_ACCENT: HSL = { h: 220, s: 12, l: 76 };

/**
 * Picks the accent from the team's palette. Prefers colors that are already
 * near a usable lightness over very dark ones, so a team with both a mid-tone
 * and a near-black in its palette gets the mid-tone.
 */
function pickAccent(colors: TeamColors): { hsl: HSL; found: boolean } {
  const candidates = [colors.fg, colors.secondary, colors.cap, colors.bg]
    .map((c) => (c ? hexToHsl(c) : null))
    .filter((c): c is HSL => c !== null)
    // Reject near-white, near-black, and washed-out greys
    .filter((c) => c.s >= 25 && c.l >= 12 && c.l <= 88);

  if (candidates.length === 0) return { hsl: DEFAULT_ACCENT, found: false };
  const score = (c: HSL) => c.s - Math.abs(c.l - 55) * 0.8;
  const best = candidates.reduce((a, b) => (score(b) > score(a) ? b : a));
  // Normalize for legibility on a dark background
  return { hsl: { h: best.h, s: Math.min(92, Math.max(58, best.s)), l: 62 }, found: true };
}

/** Pure palette derivation — exported so it can be tested without a DOM. */
export function derivePalette(colors: TeamColors | null): Record<string, string> {
  const out: Record<string, string> = {};
  const set = (k: string, v: string) => {
    out[k] = v;
  };

  const primary = colors?.bg && hexToHsl(colors.bg) ? colors.bg : DEFAULT_TEAM;
  const primaryHsl = hexToHsl(primary) ?? { h: DEFAULT_HUE, s: DEFAULT_SAT, l: 20 };
  const picked = colors ? pickAccent(colors) : { hsl: DEFAULT_ACCENT, found: false };

  // Team plate uses the real primary, with text that genuinely contrasts on it.
  // The team's own secondary is preferred, but only if it actually clears AA —
  // several clubs pair two mid-tones (orange on navy) that fail as text.
  const INK = '#0d1014';
  const PAPER = '#f7f3ea';
  const primaryLum = relativeLuminance(primary);
  const teamFgCandidate = colors?.fg;
  const fgOk = teamFgCandidate && contrast(relativeLuminance(teamFgCandidate), primaryLum) >= 4.5;

  let plate = primary;
  let plateFg = fgOk ? teamFgCandidate : primaryLum > 0.25 ? INK : PAPER;
  if (!fgOk) {
    // Some primaries (bright mid-tone reds) fail against BOTH black and white.
    // Deepen or lift the plate along its own hue until the text clears AA, so
    // the club's color survives while staying readable.
    const best = Math.max(contrast(relativeLuminance(INK), primaryLum), contrast(relativeLuminance(PAPER), primaryLum));
    if (best < 4.5) {
      const goDarker = primaryLum < 0.4;
      plateFg = goDarker ? PAPER : INK;
      const targetLum = relativeLuminance(plateFg);
      for (let l = primaryHsl.l; goDarker ? l >= 6 : l <= 94; l += goDarker ? -2 : 2) {
        const candidate = { ...primaryHsl, l };
        if (contrast(hslLuminance(candidate), targetLum) >= 4.6) {
          plate = hsl(candidate);
          break;
        }
      }
    }
  }
  set('--team', plate);
  set('--team-fg', plateFg);

  // Choose the hue that carries the team's identity. A greyscale primary
  // (white/black/silver clubs) borrows the accent's hue when there is one,
  // and otherwise falls back to a neutral slate rather than an unrelated color.
  const primaryIsGrey = primaryHsl.s < 8;
  const monochrome = primaryIsGrey && !picked.found;
  const baseAccent = monochrome ? SILVER_ACCENT : picked.hsl;

  const hue = primaryIsGrey ? (picked.found ? baseAccent.h : NEUTRAL_HUE) : primaryHsl.h;
  // Saturation is capped so a vivid primary doesn't wash out dense tables
  const tint = monochrome
    ? 8
    : primaryIsGrey
      ? 20
      : Math.min(38, Math.max(18, primaryHsl.s * 0.55));

  const panel = { h: hue, s: tint * 0.8, l: 13 };
  // The accent must clear AA against the lightest surface it appears on
  const accent = brightenUntilReadable(baseAccent, { h: hue, s: tint * 0.8, l: 17 });

  set('--bg', hsl({ h: hue, s: tint, l: 8 }));
  set('--bg-deep', hsl({ h: hue, s: tint, l: 5.5 }));
  set('--bg-glow', hsl({ h: hue, s: tint, l: 13 }));
  set('--panel', hsl(panel));
  set('--panel-raised', hsl({ h: hue, s: tint * 0.8, l: 17 }));
  set('--border', hsl({ h: hue, s: tint * 0.7, l: 25 }));
  set('--text', hsl({ h: hue, s: 22, l: 93 }));
  set('--muted', hsl({ h: hue, s: 14, l: 66 }));
  set('--accent', hsl(accent));
  // Dark ink for text sitting on the accent; keep it readable on pale accents
  set('--accent-ink', hsl({ h: accent.h, s: Math.min(60, accent.s), l: 12 }));
  return out;
}

export function applyTeamTheme(colors: TeamColors | null): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(derivePalette(colors))) {
    root.style.setProperty(key, value);
  }
}
