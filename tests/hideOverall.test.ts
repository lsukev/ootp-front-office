import { afterEach, describe, expect, it } from 'vitest';
import {
  formatOverallPair, formatRating, formatRatingPair, overallHidden,
  setHideOverall, setRatingRounding,
} from '../src/ratingScale.js';

/**
 * Leagues that play without the scouted composite.
 *
 * "For those of us who play no ratings except speed/defense, is there a way
 * you can toggle/select to hide overall/potential rating, and only display
 * potentials for others like power, eye etc?"
 *
 * The trap is the second half. A man who plays no ratings except speed and
 * defence still reads speed and defence, so hiding has to find the composite
 * and nothing else — and the per-position defensive grades go through the same
 * pair formatter as the composite does, which is why there are two of them.
 */

afterEach(() => {
  setHideOverall(false);
  setRatingRounding(false);
});

describe('hiding the composite', () => {
  it('writes the pair as usual when the setting is off', () => {
    expect(formatOverallPair(55, 65)).toBe('55→65');
  });

  it('writes nothing readable as a grade when it is on', () => {
    setHideOverall(true);
    expect(formatOverallPair(55, 65)).toBe('—');
    expect(formatOverallPair(55, 65)).not.toContain('55');
  });

  /*
   * The half of the request that is easy to lose. These are the position
   * grades and the component ratings — the ones this reader actually plays by.
   */
  it('leaves every component rating alone', () => {
    setHideOverall(true);
    expect(formatRating(60)).toBe('60');
    expect(formatRatingPair(50, 70)).toBe('50→70');
  });

  it('reports its own state, so a page can drop a column rather than dash it', () => {
    expect(overallHidden()).toBe(false);
    setHideOverall(true);
    expect(overallHidden()).toBe(true);
  });

  it('still rounds the components when both settings are on', () => {
    setHideOverall(true);
    setRatingRounding(true);
    expect(formatRating(57)).toBe('55');
    expect(formatOverallPair(57, 62)).toBe('—');
  });
});
