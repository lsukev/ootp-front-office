/**
 * The catalog of every stat the app can display, and the user's column choices.
 *
 * Keys match the computed stat blocks the server returns, so adding a column
 * here is all it takes to make a new stat selectable.
 */

export type StatGroup = 'batting' | 'pitching';
export type StatFormat = 'int' | 'avg3' | 'dec1' | 'dec2' | 'pct' | 'plus';

export interface StatDef {
  key: string;
  label: string;
  desc: string;
  format: StatFormat;
  section: 'Counting' | 'Rate' | 'Advanced' | 'Fielding';
  /** Lower is better — flips the color scale on plus/rate stats. */
  lowerIsBetter?: boolean;
}

export const BATTING_STATS: StatDef[] = [
  { key: 'pa', label: 'PA', desc: 'Plate appearances', format: 'int', section: 'Counting' },
  { key: 'ab', label: 'AB', desc: 'At bats', format: 'int', section: 'Counting' },
  { key: 'h', label: 'H', desc: 'Hits', format: 'int', section: 'Counting' },
  { key: 'd', label: '2B', desc: 'Doubles', format: 'int', section: 'Counting' },
  { key: 't3', label: '3B', desc: 'Triples', format: 'int', section: 'Counting' },
  { key: 'hr', label: 'HR', desc: 'Home runs', format: 'int', section: 'Counting' },
  { key: 'xbh', label: 'XBH', desc: 'Extra-base hits (2B + 3B + HR)', format: 'int', section: 'Counting' },
  { key: 'r', label: 'R', desc: 'Runs scored', format: 'int', section: 'Counting' },
  { key: 'rbi', label: 'RBI', desc: 'Runs batted in', format: 'int', section: 'Counting' },
  { key: 'bb', label: 'BB', desc: 'Walks', format: 'int', section: 'Counting' },
  { key: 'k', label: 'K', desc: 'Strikeouts', format: 'int', section: 'Counting', lowerIsBetter: true },
  { key: 'sb', label: 'SB', desc: 'Stolen bases', format: 'int', section: 'Counting' },
  { key: 'cs', label: 'CS', desc: 'Caught stealing', format: 'int', section: 'Counting', lowerIsBetter: true },

  { key: 'avg', label: 'AVG', desc: 'Batting average — hits per at bat', format: 'avg3', section: 'Rate' },
  { key: 'obp', label: 'OBP', desc: 'On-base percentage. The single best simple measure of a hitter avoiding outs.', format: 'avg3', section: 'Rate' },
  { key: 'slg', label: 'SLG', desc: 'Slugging percentage — total bases per at bat', format: 'avg3', section: 'Rate' },
  { key: 'ops', label: 'OPS', desc: 'On-base plus slugging. Quick overall offensive value, but unadjusted for league or park.', format: 'avg3', section: 'Rate' },
  { key: 'iso', label: 'ISO', desc: 'Isolated power (SLG − AVG) — extra-base ability with singles stripped out', format: 'avg3', section: 'Rate' },
  { key: 'babip', label: 'BABIP', desc: 'Batting average on balls in play. Far from league average (~.300) often signals luck that will regress.', format: 'avg3', section: 'Rate' },
  { key: 'bbPct', label: 'BB%', desc: 'Walk rate — walks per plate appearance', format: 'pct', section: 'Rate' },
  { key: 'kPct', label: 'K%', desc: 'Strikeout rate — strikeouts per plate appearance', format: 'pct', section: 'Rate', lowerIsBetter: true },
  { key: 'sbPct', label: 'SB%', desc: 'Stolen base success rate. Below ~70% costs more runs than it creates.', format: 'pct', section: 'Rate' },

  { key: 'woba', label: 'wOBA', desc: 'Weighted on-base average. Like OBP, but each way of reaching base is weighted by how many runs it actually produces. Scaled so league average matches league OBP.', format: 'avg3', section: 'Advanced' },
  { key: 'opsPlus', label: 'OPS+', desc: 'OPS adjusted for league run environment and ballpark, scaled so 100 = league average. 130 means 30% better than average.', format: 'plus', section: 'Advanced' },
  { key: 'wrcPlus', label: 'wRC+', desc: 'Weighted Runs Created Plus — the most complete rate stat here. Total offensive value per plate appearance, park- and league-adjusted, where 100 = league average.', format: 'plus', section: 'Advanced' },
  { key: 'war', label: 'WAR', desc: 'Wins Above Replacement, as calculated by OOTP', format: 'dec1', section: 'Advanced' },
];

export const PITCHING_STATS: StatDef[] = [
  { key: 'g', label: 'G', desc: 'Games pitched', format: 'int', section: 'Counting' },
  { key: 'gs', label: 'GS', desc: 'Games started', format: 'int', section: 'Counting' },
  { key: 'w', label: 'W', desc: 'Wins', format: 'int', section: 'Counting' },
  { key: 'l', label: 'L', desc: 'Losses', format: 'int', section: 'Counting', lowerIsBetter: true },
  { key: 'sv', label: 'SV', desc: 'Saves', format: 'int', section: 'Counting' },
  { key: 'hld', label: 'HLD', desc: 'Holds', format: 'int', section: 'Counting' },
  { key: 'ip', label: 'IP', desc: 'Innings pitched', format: 'dec1', section: 'Counting' },
  { key: 'h', label: 'H', desc: 'Hits allowed', format: 'int', section: 'Counting', lowerIsBetter: true },
  { key: 'er', label: 'ER', desc: 'Earned runs allowed', format: 'int', section: 'Counting', lowerIsBetter: true },
  { key: 'hr', label: 'HR', desc: 'Home runs allowed', format: 'int', section: 'Counting', lowerIsBetter: true },
  { key: 'bb', label: 'BB', desc: 'Walks allowed', format: 'int', section: 'Counting', lowerIsBetter: true },
  { key: 'k', label: 'K', desc: 'Strikeouts', format: 'int', section: 'Counting' },

  { key: 'era', label: 'ERA', desc: 'Earned run average per nine innings', format: 'dec2', section: 'Rate', lowerIsBetter: true },
  { key: 'whip', label: 'WHIP', desc: 'Walks and hits per inning pitched — baserunners allowed', format: 'dec2', section: 'Rate', lowerIsBetter: true },
  { key: 'k9', label: 'K/9', desc: 'Strikeouts per nine innings', format: 'dec1', section: 'Rate' },
  { key: 'bb9', label: 'BB/9', desc: 'Walks per nine innings', format: 'dec1', section: 'Rate', lowerIsBetter: true },
  { key: 'hr9', label: 'HR/9', desc: 'Home runs per nine innings', format: 'dec1', section: 'Rate', lowerIsBetter: true },
  { key: 'kbb', label: 'K/BB', desc: 'Strikeout-to-walk ratio. Around 3.0 is excellent command.', format: 'dec2', section: 'Rate' },
  { key: 'kPct', label: 'K%', desc: 'Strikeouts per batter faced', format: 'pct', section: 'Rate' },
  { key: 'bbPct', label: 'BB%', desc: 'Walks per batter faced', format: 'pct', section: 'Rate', lowerIsBetter: true },

  { key: 'fip', label: 'FIP', desc: 'Fielding Independent Pitching — what ERA should be based only on strikeouts, walks, and home runs, with defense and batted-ball luck removed. Scaled to the league ERA.', format: 'dec2', section: 'Advanced', lowerIsBetter: true },
  { key: 'eraPlus', label: 'ERA+', desc: 'ERA adjusted for league run environment and ballpark, scaled so 100 = league average. 130 means 30% better than average.', format: 'plus', section: 'Advanced' },
  { key: 'war', label: 'WAR', desc: 'Wins Above Replacement, as calculated by OOTP', format: 'dec1', section: 'Advanced' },
];

/**
 * Season fielding, summed across every position a man played.
 *
 * A utility player's total workload is what belongs in a roster row; the split
 * by position lives on his card, where there is room for it.
 */
export const FIELDING_STATS: StatDef[] = [
  { key: 'fg', label: 'G', desc: 'Games played in the field', format: 'int', section: 'Fielding' },
  { key: 'fgs', label: 'GS', desc: 'Games started in the field', format: 'int', section: 'Fielding' },
  { key: 'finn', label: 'Inn', desc: 'Innings played in the field', format: 'int', section: 'Fielding' },
  { key: 'po', label: 'PO', desc: 'Putouts', format: 'int', section: 'Fielding' },
  { key: 'a', label: 'A', desc: 'Assists', format: 'int', section: 'Fielding' },
  { key: 'e', label: 'E', desc: 'Errors', format: 'int', section: 'Fielding' },
  { key: 'dp', label: 'DP', desc: 'Double plays turned', format: 'int', section: 'Fielding' },
  {
    key: 'fpct',
    label: 'FPCT',
    desc:
      'Fielding percentage — putouts plus assists over total chances. It says how often a player ' +
      'handled what he reached, and nothing about how much he reached, so a statue with safe hands ' +
      'can lead the league in it.',
    format: 'avg3',
    section: 'Fielding',
  },
  {
    key: 'rf9',
    label: 'RF/9',
    desc:
      'Range factor — putouts plus assists per nine innings. It measures how much a fielder is ' +
      'involved, which is the part fielding percentage misses. Compare it only within a position: ' +
      'a first baseman handles far more chances than a left fielder.',
    format: 'dec2',
    section: 'Fielding',
  },
];

export const DEFAULT_BATTING = ['pa', 'avg', 'obp', 'slg', 'ops', 'opsPlus', 'wrcPlus', 'hr', 'rbi', 'sb', 'war'];
export const DEFAULT_PITCHING = ['g', 'gs', 'w', 'l', 'sv', 'ip', 'era', 'eraPlus', 'fip', 'whip', 'k9', 'war'];

const STORAGE_KEY = (group: StatGroup) => `ootp-fo:columns:${group}`;

export function loadColumns(group: StatGroup): string[] {
  const fallback = group === 'batting' ? DEFAULT_BATTING : DEFAULT_PITCHING;
  try {
    const raw = localStorage.getItem(STORAGE_KEY(group));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as string[];
    const valid = new Set(statsFor(group).map((s) => s.key));
    // Drop keys from older versions so a renamed stat can't wedge the table
    const cleaned = parsed.filter((k) => valid.has(k));
    return cleaned.length ? cleaned : fallback;
  } catch {
    return fallback;
  }
}

export function saveColumns(group: StatGroup, keys: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY(group), JSON.stringify(keys));
  } catch {
    // storage unavailable (private mode) — selection just won't persist
  }
}

/** Fielding is offered in both groups — everyone on the field has a glove. */
export const statsFor = (group: StatGroup): StatDef[] =>
  group === 'batting'
    ? [...BATTING_STATS, ...FIELDING_STATS]
    : [...PITCHING_STATS, ...FIELDING_STATS];

const FIELDING_KEYS = new Set(FIELDING_STATS.map((f) => f.key));
/** Fielding lives in its own block on the payload, not with the hitting line. */
export const isFieldingStat = (key: string): boolean => FIELDING_KEYS.has(key);

export const findStat = (group: StatGroup, key: string): StatDef | undefined =>
  statsFor(group).find((s) => s.key === key);

/** Formats a value for display. `raw` is the whole stat block, for context-aware cases. */
export function formatStat(
  def: StatDef,
  value: number | null | undefined,
  raw?: Record<string, number | null>
): string {
  // A pitcher with a 0.00 ERA has a mathematically infinite ERA+
  if (def.key === 'eraPlus' && value === null && raw && raw.era === 0 && (raw.ip ?? 0) > 0) return '∞';
  if (value === null || value === undefined) return '';
  switch (def.format) {
    case 'avg3':
      return value.toFixed(3).replace(/^0\./, '.').replace(/^-0\./, '-.');
    case 'dec1':
      return value.toFixed(1);
    case 'dec2':
      return value.toFixed(2);
    case 'pct':
      return `${value.toFixed(1)}%`;
    case 'plus':
    case 'int':
    default:
      return String(Math.round(value));
  }
}

/** Subtle color for plus stats so 100 reads as the midpoint at a glance. */
export function plusColor(def: StatDef, value: number | null | undefined): string | undefined {
  if (def.format !== 'plus' || value === null || value === undefined) return undefined;
  const delta = Math.max(-60, Math.min(60, value - 100));
  const hue = delta >= 0 ? 120 : 0;
  const strength = Math.abs(delta) / 60;
  if (strength < 0.12) return undefined;
  return `hsl(${hue}, ${45 + strength * 30}%, ${62 + strength * 8}%)`;
}
