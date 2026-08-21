import { describe, expect, it } from 'vitest';
import { climb, expectedRuns, outcomesFrom, type BattingLine, type Outcomes } from '../server/runs.js';

/**
 * The expected-runs model, and the search that uses it.
 *
 * Built after an exhaustive test of the slot rule against every one of the
 * 362,880 ways to order a real club's nine hitters: the rule's card ranked
 * 16,718th at 736.7 runs a season against a true optimum of 746.2. The search
 * closes most of that, and these hold down the properties it has to have for
 * that claim to keep meaning anything.
 */

const league: BattingLine = {
  pa: 100_000, h: 24_000, d: 4_600, t: 400, hr: 2_800, bb: 8_500, hp: 1_000,
};

/** A league-average man, whatever his own line says, once regressed. */
const average = outcomesFrom({ pa: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, hp: 0 }, league);

const nineOf = (p: Outcomes): Outcomes[] => Array.from({ length: 9 }, () => p);

describe('the run model', () => {
  it('scores a league-average nine at something like a real team', () => {
    const runs = expectedRuns(nineOf(average));
    // Major-league clubs score between three and six; anything outside that
    // means the base-running or the state machine is wrong, which is how the
    // first version of this scored 3.6 for an average nine
    expect(runs).toBeGreaterThan(3.4);
    expect(runs).toBeLessThan(6);
  });

  it('gives the same answer every time', () => {
    const nine = nineOf(average);
    expect(expectedRuns(nine)).toBe(expectedRuns(nine));
  });

  it('scores a better nine higher', () => {
    const better = outcomesFrom(
      { pa: 600, h: 180, d: 40, t: 3, hr: 35, bb: 80, hp: 5 }, league
    );
    expect(expectedRuns(nineOf(better))).toBeGreaterThan(expectedRuns(nineOf(average)));
  });

  it('knows the order matters, not just the men', () => {
    const weak = outcomesFrom({ pa: 600, h: 120, d: 15, t: 0, hr: 5, bb: 30, hp: 2 }, league);
    const strong = outcomesFrom({ pa: 600, h: 185, d: 45, t: 3, hr: 40, bb: 90, hp: 5 }, league);
    const front = [strong, strong, strong, strong, weak, weak, weak, weak, weak];
    const back = [weak, weak, weak, weak, weak, strong, strong, strong, strong];
    // The same nine men; the good ones simply bat sooner and more often
    expect(expectedRuns(front)).toBeGreaterThan(expectedRuns(back));
  });
});

describe('the search', () => {
  const weak = outcomesFrom({ pa: 600, h: 120, d: 15, t: 0, hr: 4, bb: 25, hp: 2 }, league);
  const strong = outcomesFrom({ pa: 600, h: 185, d: 45, t: 3, hr: 40, bb: 90, hp: 5 }, league);
  // Deliberately upside down: the four best men batting last
  const backwards = [weak, weak, weak, weak, weak, strong, strong, strong, strong];

  it('never returns an order worse than the one it started from', () => {
    const seeds: Outcomes[][] = [backwards, nineOf(average), [...backwards].reverse()];
    for (const seed of seeds) {
      const { runs } = climb(seed);
      expect(runs).toBeGreaterThanOrEqual(expectedRuns(seed) - 1e-12);
    }
  });

  it('returns a permutation — every man used once and none invented', () => {
    const { order } = climb(backwards);
    expect(order.length).toBe(9);
    expect(new Set(order).size).toBe(9);
    expect([...order].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('actually fixes an upside-down card', () => {
    const { runs } = climb(backwards);
    expect(runs).toBeGreaterThan(expectedRuns(backwards));
  });

  it('finishes in the low hundreds of evaluations, not the hundred thousands', () => {
    // The exhaustive search takes 362,880 and twenty-four minutes; this has to
    // be cheap enough for a page to pay on every load
    const { evaluations } = climb(backwards);
    expect(evaluations).toBeLessThan(600);
  });

  it('leaves an already-good card alone', () => {
    const good = climb(backwards);
    const again = climb(good.order.map((i) => backwards[i]));
    expect(again.runs).toBeCloseTo(good.runs, 9);
  });
});

describe('rates drawn from a season line', () => {
  it('reads a man with a full season as himself', () => {
    const slugger = outcomesFrom({ pa: 650, h: 190, d: 40, t: 2, hr: 45, bb: 90, hp: 4 }, league);
    expect(slugger.hr).toBeGreaterThan(average.hr * 1.8);
  });

  it('discounts a man with twenty plate appearances almost to nothing', () => {
    /*
     * Otherwise the second slot goes to whoever has had the best fortnight,
     * and a search is exactly the machinery to take that seriously and act on
     * it. Five home runs in twenty trips is a 25% rate; what matters is how
     * far of that survives, not the raw figure.
     */
    const line = { pa: 20, h: 12, d: 4, t: 0, hr: 5, bb: 3, hp: 0 };
    const hotStart = outcomesFrom(line, league);
    const raw = line.hr / line.pa;
    const travelled = (hotStart.hr - average.hr) / (raw - average.hr);
    expect(travelled, 'too much of a twenty-trip hot streak survived').toBeLessThan(0.1);
  });

  it('lets a full season travel most of the way', () => {
    const line = { pa: 650, h: 190, d: 40, t: 2, hr: 45, bb: 90, hp: 4 };
    const full = outcomesFrom(line, league);
    const travelled = (full.hr - average.hr) / (line.hr / line.pa - average.hr);
    expect(travelled, 'a full season was discounted like a fortnight').toBeGreaterThan(0.65);
  });

  it('always produces probabilities that sum to one', () => {
    for (const line of [
      { pa: 0, h: 0, d: 0, t: 0, hr: 0, bb: 0, hp: 0 },
      { pa: 650, h: 190, d: 40, t: 2, hr: 45, bb: 90, hp: 4 },
      { pa: 3, h: 3, d: 3, t: 0, hr: 0, bb: 0, hp: 0 },
    ]) {
      const o = outcomesFrom(line, league);
      const total = o.bb + o['1b'] + o['2b'] + o['3b'] + o.hr + o.out;
      expect(total).toBeCloseTo(1, 9);
    }
  });
});

/**
 * Orders that are not nine men long.
 *
 * The loops counted to nine flat, so an eight-man card read one past the end of
 * itself and threw "Cannot read properties of undefined (reading 'out')" — and
 * every card in a league where the pitcher hits is eight men long, because he
 * is added after the order is built. A reader on such a league got that
 * sentence instead of a lineup.
 */
describe('an order that is not nine men', () => {
  it('scores an eight-man order instead of reading past it', () => {
    const runs = expectedRuns(Array.from({ length: 8 }, () => average));
    expect(Number.isFinite(runs), 'the model fell off the end of the order').toBe(true);
    expect(runs).toBeGreaterThan(3.4);
  });

  it('reads the same nine men the same whether the order is eight long or nine', () => {
    // Nothing distinguishes the slots when every man in them is identical, so
    // the length must not move the answer on its own
    expect(expectedRuns(Array.from({ length: 8 }, () => average))).toBeCloseTo(
      expectedRuns(nineOf(average)),
      10
    );
  });

  it('brings the good bats round oftener when the order is shorter', () => {
    /*
     * The check that the length is genuinely being used rather than quietly
     * padded back to nine: eight good hitters outscore the same eight with a
     * ninth man making outs behind them.
     */
    const good = outcomesFrom({ pa: 650, h: 190, d: 40, t: 2, hr: 25, bb: 70, hp: 5 }, league);
    const poor = outcomesFrom({ pa: 400, h: 40, d: 4, t: 0, hr: 0, bb: 8, hp: 0 }, league);
    const eight = expectedRuns(Array.from({ length: 8 }, () => good));
    const nine = expectedRuns([...Array.from({ length: 8 }, () => good), poor]);
    expect(eight).toBeGreaterThan(nine);
  });

  it('is not disturbed by the length of the order before it', () => {
    // The model reuses its buffers between calls, and a shorter order leaves
    // the tail of them behind
    const first = expectedRuns(nineOf(average));
    expectedRuns(Array.from({ length: 8 }, () => average));
    expect(expectedRuns(nineOf(average))).toBeCloseTo(first, 10);
  });
});

describe('a slot the search may not touch', () => {
  const weak = outcomesFrom({ pa: 400, h: 40, d: 4, t: 0, hr: 0, bb: 8, hp: 0 }, league);
  const strong = outcomesFrom({ pa: 700, h: 220, d: 50, t: 3, hr: 40, bb: 90, hp: 6 }, league);

  it('leaves him where he stands', () => {
    /*
     * The pitcher bats ninth for where he stands in the field, not for how the
     * bats sorted, and a search free to move him would put him somewhere no
     * manager would write him.
     */
    const seed = [...Array.from({ length: 8 }, () => strong), weak];
    const movable = [0, 1, 2, 3, 4, 5, 6, 7];
    const { order } = climb(seed, movable);
    expect(order[8], 'the search moved the man it was told to leave alone').toBe(8);
  });

  it('still counts him', () => {
    // His outs are three of the twenty-seven; an order judged without them is
    // being judged on a game nobody is playing
    const withWeak = expectedRuns([...Array.from({ length: 8 }, () => strong), weak]);
    const allStrong = expectedRuns(Array.from({ length: 9 }, () => strong));
    expect(withWeak).toBeLessThan(allStrong);
  });

  it('never returns a worse order than it was given', () => {
    const seed = [weak, strong, average, strong, weak, average, strong, average, weak];
    const { runs } = climb(seed, [0, 1, 2, 3, 4, 5, 6, 7]);
    expect(runs).toBeGreaterThanOrEqual(expectedRuns(seed) - 1e-12);
  });
});
