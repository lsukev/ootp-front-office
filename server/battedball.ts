import { db, hasColumns } from './db.js';

/**
 * Contact quality, from the pitch-by-pitch table OOTP exports and never shows.
 *
 * `players_at_bat_batting_stats` carries one row per plate appearance with the
 * exit velocity, launch angle and sprint speed of every batted ball — 191,000
 * of them in a season. Nothing in OOTP's own screens surfaces it, which makes
 * this the one place the app can say something the game cannot.
 *
 * The outcome codes were verified against the season stat line rather than
 * assumed: Judge, Chisholm and Bellinger each reconcile exactly on home runs,
 * doubles, triples, singles, strikeouts, walks and hit-by-pitches.
 *
 * Deliberately absent: a spray chart. The table has hit_loc and hit_xy, but
 * hit_xy is uniform across its whole range with no left/right split by
 * handedness, so whatever it encodes is not a field position — and a spray
 * diagram drawn from a misread column would be confidently wrong.
 */

const T = 'players_at_bat_batting_stats';

/** Verified against season totals; see the note above. */
const RESULT = { K: 1, BB: 2, GB_OUT: 4, AIR_OUT: 5, SINGLE: 6, DOUBLE: 7, TRIPLE: 8, HR: 9, HBP: 10 } as const;

/*
 * The table is not enough on its own: the ball-tracking columns are a newer
 * addition to the export, and a save that has the at-bat rows without them
 * passed a plain existence check and then threw "no such column" from every
 * query in this file. Ask for the columns the work actually needs.
 */
export const hasBattedBalls = (): boolean =>
  hasColumns(T, 'player_id', 'team_id', 'exit_velo', 'launch_angle', 'sprint_speed', 'result');

/**
 * A barrel: struck hard enough, at an angle that rewards it.
 *
 * The window opens at 98 mph over 26-30 degrees and widens as the ball is hit
 * harder, which is the shape of the real definition rather than a flat box —
 * a ball at 110 can leave at a much wider range of angles and still be a
 * disaster for the defence.
 */
function isBarrel(ev: number, la: number): boolean {
  if (ev < 98) return false;
  const spread = (ev - 98) * 1.5;
  return la >= 26 - spread && la <= 30 + spread;
}

/** Launch-angle families, the way batted balls are normally grouped. */
function battedType(la: number): 'gb' | 'ld' | 'fb' | 'pu' {
  if (la < 10) return 'gb';
  if (la < 25) return 'ld';
  if (la <= 50) return 'fb';
  return 'pu';
}

const bucketKey = (ev: number, la: number): string =>
  `${Math.floor(ev / 3)}:${Math.floor((la + 90) / 5)}`;

interface Bucket { n: number; hits: number; bases: number }

/** Buckets are per level: see the note on {@link buckets}. */
let bucketCache: Map<number, Map<string, Bucket>> | null = null;

/**
 * What a batted ball of a given speed and angle is actually worth in THIS
 * league, measured rather than modelled.
 *
 * Every batted ball in the save is put in a small exit-velocity and launch-angle
 * bucket, and the bucket remembers how often balls like it fell in and how many
 * bases they went for. A hitter's expected line is then the sum of what his own
 * contact usually produces. That is the same idea as expected batting average
 * without importing anyone else's coefficients: the league calibrates itself,
 * so it stays honest in a high-offence save and a dead-ball one alike.
 *
 * Kept separately per level, because defence is not the same everywhere. The
 * identical batted ball falls in 33.2% of the time in the majors and 35.5% at
 * A-ball in this save, so pooling the levels quietly marks every major leaguer
 * unlucky and every prospect fortunate — an artefact that would look exactly
 * like a finding.
 */
function buckets(level: number): Map<string, Bucket> {
  if (!bucketCache) bucketCache = new Map();
  const cached = bucketCache.get(level);
  if (cached) return cached;
  const rows = db
    .prepare(
      `SELECT a.exit_velo AS ev, a.launch_angle AS la, a.result
       FROM "${T}" a JOIN teams t ON t.team_id = a.team_id
       WHERE a.exit_velo > 0 AND t.level = ?`
    )
    .all(level) as Array<{ ev: number; la: number; result: number }>;
  const map = new Map<string, Bucket>();
  for (const r of rows) {
    const k = bucketKey(r.ev, r.la);
    let b = map.get(k);
    if (!b) map.set(k, (b = { n: 0, hits: 0, bases: 0 }));
    b.n++;
    const bases =
      r.result === RESULT.SINGLE ? 1 :
      r.result === RESULT.DOUBLE ? 2 :
      r.result === RESULT.TRIPLE ? 3 :
      r.result === RESULT.HR ? 4 : 0;
    if (bases > 0) b.hits++;
    b.bases += bases;
  }
  bucketCache.set(level, map);
  return map;
}

export function clearBattedBallCache(): void {
  bucketCache = null;
  leagueCache = null;
}

export interface ContactProfile {
  player_id: number;
  battedBalls: number;
  avgExitVelo: number | null;
  maxExitVelo: number | null;
  hardHitPct: number | null;
  barrelPct: number | null;
  sweetSpotPct: number | null;
  gbPct: number | null;
  ldPct: number | null;
  fbPct: number | null;
  sprintSpeed: number | null;
  /** What his contact usually produces, and what it actually produced. */
  xba: number | null;
  ba: number | null;
  xslg: number | null;
  slg: number | null;
  /** Positive means the results have run ahead of the contact. */
  baLuck: number | null;
  slgLuck: number | null;
}

const pct = (n: number, d: number): number | null => (d > 0 ? Number(((n / d) * 100).toFixed(1)) : null);
const rate = (n: number, d: number): number | null => (d > 0 ? Number((n / d).toFixed(3)) : null);

/**
 * Contact profiles for a set of players. Batted balls only — a strikeout has no
 * exit velocity and belongs in neither the numerator nor the denominator.
 */
export function contactProfiles(playerIds: number[]): Map<number, ContactProfile> {
  const out = new Map<number, ContactProfile>();
  if (!hasBattedBalls() || playerIds.length === 0) return out;

  const rows = db
    .prepare(
      `SELECT a.player_id, a.exit_velo AS ev, a.launch_angle AS la, a.sprint_speed AS speed,
              a.result, COALESCE(t.level, 1) AS level
       FROM "${T}" a LEFT JOIN teams t ON t.team_id = a.team_id
       WHERE a.exit_velo > 0 AND a.player_id IN (${playerIds.map(() => '?').join(',')})`
    )
    .all(...playerIds) as Array<{
    player_id: number; ev: number; la: number; speed: number | null; result: number; level: number;
  }>;

  interface Acc {
    n: number; ev: number; maxEv: number; hard: number; barrel: number; sweet: number;
    gb: number; ld: number; fb: number; speedSum: number; speedN: number;
    hits: number; bases: number; xHits: number; xBases: number;
  }
  const acc = new Map<number, Acc>();
  for (const r of rows) {
    let a = acc.get(r.player_id);
    if (!a) acc.set(r.player_id, (a = {
      n: 0, ev: 0, maxEv: 0, hard: 0, barrel: 0, sweet: 0, gb: 0, ld: 0, fb: 0,
      speedSum: 0, speedN: 0, hits: 0, bases: 0, xHits: 0, xBases: 0,
    }));
    a.n++;
    a.ev += r.ev;
    if (r.ev > a.maxEv) a.maxEv = r.ev;
    if (r.ev >= 95) a.hard++;
    if (isBarrel(r.ev, r.la)) a.barrel++;
    if (r.la >= 8 && r.la <= 32) a.sweet++;
    const type = battedType(r.la);
    if (type === 'gb') a.gb++;
    else if (type === 'ld') a.ld++;
    else if (type === 'fb') a.fb++;
    if (r.speed && r.speed > 0) { a.speedSum += r.speed; a.speedN++; }

    const bases =
      r.result === RESULT.SINGLE ? 1 :
      r.result === RESULT.DOUBLE ? 2 :
      r.result === RESULT.TRIPLE ? 3 :
      r.result === RESULT.HR ? 4 : 0;
    if (bases > 0) a.hits++;
    a.bases += bases;

    // Judged against the level he hit it at, not a league-wide average
    const b = buckets(r.level).get(bucketKey(r.ev, r.la));
    if (b && b.n > 0) {
      a.xHits += b.hits / b.n;
      a.xBases += b.bases / b.n;
    }
  }

  for (const [id, a] of acc) {
    const xba = rate(a.xHits, a.n);
    const ba = rate(a.hits, a.n);
    const xslg = rate(a.xBases, a.n);
    const slg = rate(a.bases, a.n);
    out.set(id, {
      player_id: id,
      battedBalls: a.n,
      avgExitVelo: a.n ? Number((a.ev / a.n).toFixed(1)) : null,
      maxExitVelo: a.maxEv || null,
      hardHitPct: pct(a.hard, a.n),
      barrelPct: pct(a.barrel, a.n),
      sweetSpotPct: pct(a.sweet, a.n),
      gbPct: pct(a.gb, a.n),
      ldPct: pct(a.ld, a.n),
      fbPct: pct(a.fb, a.n),
      sprintSpeed: a.speedN ? Number((a.speedSum / a.speedN).toFixed(1)) : null,
      xba, ba, xslg, slg,
      baLuck: ba !== null && xba !== null ? Number((ba - xba).toFixed(3)) : null,
      slgLuck: slg !== null && xslg !== null ? Number((slg - xslg).toFixed(3)) : null,
    });
  }
  return out;
}

export interface ContactLeague {
  avgExitVelo: number;
  hardHitPct: number;
  barrelPct: number;
  sprintSpeed: number;
}

let leagueCache: ContactLeague | null = null;

/** League-wide contact, so a percentage has something to be judged against. */
export function contactLeague(): ContactLeague | null {
  if (leagueCache) return leagueCache;
  if (!hasBattedBalls()) return null;
  const rows = db
    .prepare(
      `SELECT a.exit_velo AS ev, a.launch_angle AS la, a.sprint_speed AS speed
       FROM "${T}" a JOIN teams t ON t.team_id = a.team_id
       WHERE a.exit_velo > 0 AND t.level = 1`
    )
    .all() as Array<{ ev: number; la: number; speed: number | null }>;
  if (rows.length === 0) return null;
  let ev = 0, hard = 0, barrel = 0, speedSum = 0, speedN = 0;
  for (const r of rows) {
    ev += r.ev;
    if (r.ev >= 95) hard++;
    if (isBarrel(r.ev, r.la)) barrel++;
    if (r.speed && r.speed > 0) { speedSum += r.speed; speedN++; }
  }
  leagueCache = {
    avgExitVelo: Number((ev / rows.length).toFixed(1)),
    hardHitPct: Number(((hard / rows.length) * 100).toFixed(1)),
    barrelPct: Number(((barrel / rows.length) * 100).toFixed(1)),
    sprintSpeed: speedN ? Number((speedSum / speedN).toFixed(1)) : 0,
  };
  return leagueCache;
}

export interface Situational {
  label: string;
  pa: number;
  ba: number | null;
  ops: number | null;
}

/**
 * The situations a manager actually asks about, cut from the base/out state
 * stored with every plate appearance.
 */
export function situationalSplits(playerId: number): Situational[] {
  // A different set of columns from the batted-ball work above, so it asks for
  // its own rather than riding on that check
  if (!hasColumns(T, 'player_id', 'result', 'base1', 'base2', 'base3', 'outs',
                  'inning', 'run_diff', 'Close', 'balls', 'strikes')) return [];
  const rows = db
    .prepare(
      `SELECT result, base1, base2, base3, outs, inning, run_diff, "Close" AS close, balls, strikes
       FROM "${T}" WHERE player_id = ?`
    )
    .all(playerId) as Array<Record<string, number>>;

  const line = (label: string, keep: (r: Record<string, number>) => boolean): Situational => {
    let pa = 0, ab = 0, h = 0, tb = 0, bb = 0, hbp = 0;
    for (const r of rows) {
      if (!keep(r)) continue;
      pa++;
      const res = r.result;
      if (res === RESULT.BB) { bb++; continue; }
      if (res === RESULT.HBP) { hbp++; continue; }
      ab++;
      const bases = res === RESULT.SINGLE ? 1 : res === RESULT.DOUBLE ? 2 : res === RESULT.TRIPLE ? 3 : res === RESULT.HR ? 4 : 0;
      if (bases > 0) h++;
      tb += bases;
    }
    const obpDen = ab + bb + hbp;
    return {
      label,
      pa,
      ba: rate(h, ab),
      ops: obpDen > 0 && ab > 0 ? Number(((h + bb + hbp) / obpDen + tb / ab).toFixed(3)) : null,
    };
  };

  return [
    line('Overall', () => true),
    line('Runners on', (r) => r.base1 + r.base2 + r.base3 > 0),
    line('Scoring position', (r) => r.base2 + r.base3 > 0),
    line('RISP, two out', (r) => r.base2 + r.base3 > 0 && r.outs === 2),
    line('Bases empty', (r) => r.base1 + r.base2 + r.base3 === 0),
    line('Close and late', (r) => r.close === 1 && r.inning >= 7),
    line('Ahead in the count', (r) => r.balls > r.strikes),
    line('Behind in the count', (r) => r.strikes > r.balls),
    line('Two strikes', (r) => r.strikes >= 2),
  ].filter((s) => s.pa > 0);
}
