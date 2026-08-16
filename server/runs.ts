/**
 * What a batting order is worth, in runs.
 *
 * Not a simulation. It propagates the whole probability distribution over
 * (batter due up, outs, men on base) through nine innings and accumulates
 * expected runs, which makes it exact and repeatable. That matters because the
 * orders being compared differ by hundredths of a run: separating two of them
 * by playing games would take hundreds of thousands each, and there are
 * 362,880 ways to write nine names down.
 *
 * Base-running is probabilistic because the naive version is not neutral
 * between the orders it is meant to compare. Advancing every runner exactly
 * one base on a single scores nine league-average hitters at 3.6 runs a game
 * against a real 4.4, and it undercounts by punishing precisely the on-base
 * hitters whose placement is the question — a man on second only matters if he
 * scores on the single behind him.
 *
 * Deliberately omitted: double plays, stolen bases, sacrifices, errors and any
 * change of pitcher. Each moves the absolute number; none of them reorders the
 * comparison enough to matter at the scale of a few runs a season. They are
 * also the reason the gain this model reports should be read as an estimate
 * rather than a promise.
 */

/** Per plate appearance. Walks carry hit-by-pitch; sacrifice flies are outs. */
export interface Outcomes {
  bb: number;
  '1b': number;
  '2b': number;
  '3b': number;
  hr: number;
  out: number;
}

const BASES = 8; // three bits: first, second, third

/** Roughly the observed major-league rates for taking the extra base. */
const SCORE_FROM_SECOND_ON_SINGLE = 0.6;
const FIRST_TO_THIRD_ON_SINGLE = 0.28;
const SCORE_FROM_FIRST_ON_DOUBLE = 0.45;

type Move = [bases: number, runs: number, probability: number];

/** Where a batted ball leaves everybody, with the choices runners have. */
function advance(bases: number, kind: string): Move[] {
  const first = bases & 1;
  const second = (bases >> 1) & 1;
  const third = (bases >> 2) & 1;
  switch (kind) {
    case 'bb': {
      // A walk forces only what it has to
      if (!first) return [[bases | 1, 0, 1]];
      if (!second) return [[(bases & ~1) | 1 | 2, 0, 1]];
      if (!third) return [[1 | 2 | 4, 0, 1]];
      return [[7, 1, 1]];
    }
    case '1b': {
      const out: Move[] = [];
      const runsBase = third;
      const secondOptions: Array<[number, number]> = second
        ? [[1, SCORE_FROM_SECOND_ON_SINGLE], [0, 1 - SCORE_FROM_SECOND_ON_SINGLE]]
        : [[0, 1]];
      const firstOptions: Array<[number, number]> = first
        ? [[1, FIRST_TO_THIRD_ON_SINGLE], [0, 1 - FIRST_TO_THIRD_ON_SINGLE]]
        : [[0, 1]];
      for (const [secondScores, ps] of secondOptions) {
        for (const [firstToThird, pf] of firstOptions) {
          let b = 1; // the batter
          let runs = runsBase + (second ? secondScores : 0);
          if (second && !secondScores) b |= 4; // held at third
          if (first) b |= firstToThird ? 4 : 2;
          // Two men cannot stand on third; when both would, the lead one scores
          if (second && !secondScores && first && firstToThird) runs += 1;
          out.push([b, runs, ps * pf]);
        }
      }
      return out;
    }
    case '2b': {
      const runsBase = third + second;
      if (!first) return [[2, runsBase, 1]];
      return [
        [2, runsBase + 1, SCORE_FROM_FIRST_ON_DOUBLE],
        [2 | 4, runsBase, 1 - SCORE_FROM_FIRST_ON_DOUBLE],
      ];
    }
    case '3b':
      return [[4, first + second + third, 1]];
    case 'hr':
      return [[0, 1 + first + second + third, 1]];
    default:
      return [[bases, 0, 1]];
  }
}

const KINDS = ['bb', '1b', '2b', '3b', 'hr'] as const;
/** Precomputed once: for each base state and event, where everyone ends up. */
const MOVES: Move[][][] = Array.from({ length: BASES }, (_, s) => KINDS.map((k) => advance(s, k)));

const SIZE = 9 * 3 * BASES;
const idx = (b: number, o: number, s: number) => (b * 3 + o) * BASES + s;

/*
 * Reused between calls. A search evaluates a few hundred orders and would
 * otherwise spend most of its time allocating three hundred arrays apiece.
 */
const bufA = new Float64Array(SIZE);
const bufB = new Float64Array(SIZE);
const bufCarry = new Float64Array(9);

/**
 * Expected runs for one nine-inning game from a batting order.
 *
 * The batter carries over between innings, which is the whole reason the order
 * matters at all.
 */
export function expectedRuns(order: Outcomes[]): number {
  let dist = bufA;
  let spare = bufB;
  dist.fill(0);
  dist[idx(0, 0, 0)] = 1;
  let runs = 0;

  for (let inning = 0; inning < 9; inning++) {
    const carry = bufCarry;
    carry.fill(0);
    let live = dist;
    let next = spare;

    /*
     * An inning cannot run forever in practice. Twenty-four turns is well past
     * where the remaining probability changes the answer — checked against
     * thirty on a lineup of nine sluggers, which is the longest inning this
     * model can produce.
     */
    for (let step = 0; step < 24; step++) {
      next.fill(0);
      let any = false;
      for (let b = 0; b < 9; b++) {
        const p = order[b];
        for (let o = 0; o < 3; o++) {
          for (let s = 0; s < BASES; s++) {
            const mass = live[idx(b, o, s)];
            if (mass < 1e-14) continue;
            any = true;
            const nb = (b + 1) % 9;
            if (p.out > 0) {
              if (o === 2) carry[nb] += mass * p.out;
              else next[idx(nb, o + 1, s)] += mass * p.out;
            }
            const moves = MOVES[s];
            for (let ki = 0; ki < KINDS.length; ki++) {
              const prob = p[KINDS[ki]];
              if (prob <= 0) continue;
              const opts = moves[ki];
              for (let oi = 0; oi < opts.length; oi++) {
                const m = mass * prob * opts[oi][2];
                runs += m * opts[oi][1];
                next[idx(nb, o, opts[oi][0])] += m;
              }
            }
          }
        }
      }
      if (!any) break;
      const swap = live;
      live = next;
      next = swap;
    }

    dist = live === bufA ? bufA : bufB;
    spare = dist === bufA ? bufB : bufA;
    dist.fill(0);
    for (let b = 0; b < 9; b++) if (carry[b] > 0) dist[idx(b, 0, 0)] += carry[b];
  }
  return runs;
}

/** A season's batting line, in the columns the export uses. */
export interface BattingLine {
  pa: number; h: number; d: number; t: number; hr: number; bb: number; hp: number;
}

/**
 * How much of a man's own line to believe.
 *
 * Rates taken raw would hand the second slot to whoever has the best twenty
 * plate appearances on the club, and a search is exactly the machinery to take
 * that seriously and act on it. Blending in a league-average season of this
 * size leaves a man with a full year read mostly as himself and one just
 * called up read as close to average.
 *
 * Deliberately on the heavy side. One number is doing the work of several —
 * home runs settle after a couple of hundred trips while the rate a man's
 * ground balls find holes takes years — so it is set nearer the slow end. The
 * cost of erring that way is a card closer to the one the slot rule wrote,
 * which is a perfectly good card; the cost of erring the other way is a
 * fortnight of luck batting cleanup.
 */
const PHANTOM_PA = 250;

/** Outcome rates from a season line, pulled toward the league by sample size. */
export function outcomesFrom(line: BattingLine, league: BattingLine): Outcomes {
  const lgPa = Math.max(league.pa, 1);
  const share = (v: number) => v / lgPa;
  const mix = (own: number, lg: number, pa: number) => (own + lg * PHANTOM_PA) / (pa + PHANTOM_PA);

  const pa = Math.max(line.pa, 0);
  const singles = Math.max(line.h - line.d - line.t - line.hr, 0);
  const walks = line.bb + line.hp;

  const bb = mix(walks, share(league.bb + league.hp), pa);
  const b1 = mix(singles, share(Math.max(league.h - league.d - league.t - league.hr, 0)), pa);
  const b2 = mix(line.d, share(league.d), pa);
  const b3 = mix(line.t, share(league.t), pa);
  const hr = mix(line.hr, share(league.hr), pa);
  const reached = bb + b1 + b2 + b3 + hr;
  return { bb, '1b': b1, '2b': b2, '3b': b3, hr, out: Math.max(1 - reached, 0) };
}

/**
 * The best order this model can find, starting from one already written.
 *
 * Pairwise swaps, taken while any of them helps. Seeded from the card the slot
 * rule produced rather than from nothing, for three reasons: it cannot return
 * anything the rule beats, it converges in a tenth of the evaluations, and the
 * answer still looks like the order a person would recognise instead of
 * something arrived at by machine.
 *
 * Measured against an exhaustive search of all 362,880 orders on a real club:
 * the rule's card ranked 16,718th and scored 736.7 runs a season, the true
 * optimum 746.2, and this climb reached 744.3 in 109 evaluations.
 */
export function climb(seed: Outcomes[]): { order: number[]; runs: number; evaluations: number } {
  const n = seed.length;
  let order = seed.map((_, i) => i);
  const at = (o: number[]) => o.map((i) => seed[i]);
  let evaluations = 1;
  let best = expectedRuns(seed);

  for (let pass = 0; pass < 20; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const trial = [...order];
        [trial[i], trial[j]] = [trial[j], trial[i]];
        evaluations++;
        const r = expectedRuns(at(trial));
        if (r > best + 1e-12) {
          order = trial;
          best = r;
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return { order, runs: best, evaluations };
}
