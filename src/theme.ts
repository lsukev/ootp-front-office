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
/**
 * Walks the accent's lightness until it clears AA against the surface it sits
 * on. Direction depends on the surface: on a dark panel the accent has to get
 * lighter, on a pale one it has to get darker.
 */
function shiftUntilReadable(accent: HSL, against: HSL, target = 4.6): HSL {
  const surface = hslLuminance(against);
  const goLighter = surface < 0.35;
  let candidate = accent;
  for (
    let l = accent.l;
    goLighter ? l <= 92 : l >= 8;
    l += goLighter ? 2 : -2
  ) {
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
export type ThemeMode = 'dark' | 'light';

/**
 * Surface lightness for each mode. The team's hue and accent are shared; only
 * the surfaces flip, so a club still looks like itself in either mode.
 */
const SURFACES = {
  dark: { bg: 8, deep: 5.5, glow: 13, panel: 13, raised: 17, border: 25, text: 93, muted: 66, ink: 12 },
  light: { bg: 96, deep: 92, glow: 99, panel: 100, raised: 97, border: 78, text: 15, muted: 38, ink: 98 },
} as const;

export function derivePalette(
  colors: TeamColors | null,
  mode: ThemeMode = 'dark'
): Record<string, string> {
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

  const s = SURFACES[mode];
  // Pale surfaces need far less tint or the whole page reads as coloured paper
  const surfaceTint = mode === 'light' ? Math.min(tint, 14) : tint;

  const panel = { h: hue, s: surfaceTint * 0.8, l: s.panel };
  // The accent must clear AA against its worst-case surface, and which surface
  // that is flips with the mode: a light accent on dark struggles against the
  // lightest panel, a dark accent on light struggles against the darkest page.
  const worstSurface = mode === 'light' ? s.bg : s.raised;
  const accent = shiftUntilReadable(baseAccent, { h: hue, s: surfaceTint * 0.8, l: worstSurface });

  set('--bg', hsl({ h: hue, s: surfaceTint, l: s.bg }));
  set('--bg-deep', hsl({ h: hue, s: surfaceTint, l: s.deep }));
  set('--bg-glow', hsl({ h: hue, s: surfaceTint, l: s.glow }));
  set('--panel', hsl(panel));
  set('--panel-raised', hsl({ h: hue, s: surfaceTint * 0.8, l: s.raised }));
  set('--border', hsl({ h: hue, s: surfaceTint * 0.7, l: s.border }));
  set('--text', hsl({ h: hue, s: mode === 'light' ? 18 : 22, l: s.text }));
  set('--muted', hsl({ h: hue, s: 14, l: s.muted }));
  set('--accent', hsl(accent));
  // Text sitting on the accent: dark ink in dark mode, near-white on the
  // darkened accent light mode produces
  set('--accent-ink', hsl({ h: accent.h, s: Math.min(60, accent.s), l: s.ink }));
  /*
   * Good/bad need to flip too: pastel greens vanish on white.
   *
   * Deep enough in light mode to clear AA on a TABLE ROW rather than on the
   * page. A table paints itself a shade darker than the background, which is
   * roughly a tenth of the contrast, and every one of these three is drawn
   * inside one. The old values cleared the page at 5.6 and the row at 4.3.
   */
  set('--good', mode === 'light' ? 'hsl(145, 58%, 25%)' : 'hsl(120, 40%, 64%)');
  set('--bad', mode === 'light' ? 'hsl(2, 65%, 39%)' : 'hsl(5, 100%, 79%)');
  /*
   * The middle verdict — not a problem, not clear either. It had no token at
   * all, so the one place that needed it used a fixed amber picked for a dark
   * background and measured 1.4 against a light one.
   */
  set('--warn', mode === 'light' ? 'hsl(30, 95%, 26%)' : 'hsl(42, 80%, 66%)');
  return out;
}

export function applyTeamTheme(colors: TeamColors | null, mode: ThemeMode = 'dark'): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(derivePalette(colors, mode))) {
    root.style.setProperty(key, value);
  }
  // Tells the browser which way to render scrollbars, form controls and inputs
  root.style.setProperty('color-scheme', mode);
  root.dataset.theme = mode;
}
