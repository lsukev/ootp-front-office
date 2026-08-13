import { describe, expect, it, beforeEach } from 'vitest';
import {
  formatRating, ratingFraction, setRatingRounding, setRatingScaleMax,
} from '../src/ratingScale.js';

/**
 * Drawing a rating when the scale is not 20-80.
 *
 * The scale is the user's own OOTP setting and the export carries whichever
 * they chose, but the bars divided by eighty regardless. A reader running the
 * 1-to-5 scale sent a screenshot of his best contact hitter — a 5, the top of
 * the scale — drawn as a sliver, because five eightieths is six per cent.
 */

beforeEach(() => {
  setRatingScaleMax(80);
  setRatingRounding(false);
});

describe('a bar', () => {
  it('fills completely at the top of any scale', () => {
    for (const [max, top] of [[80, 80], [20, 20], [10, 10], [8, 8], [5, 5]] as Array<[number, number]>) {
      setRatingScaleMax(max);
      expect(ratingFraction(top), `scale 1-${max}`).toBe(1);
    }
  });

  it('gives the same man the same bar on any scale', () => {
    // Three-fifths of the way up, however the save expresses it
    setRatingScaleMax(80);
    const eighty = ratingFraction(48);
    setRatingScaleMax(5);
    expect(ratingFraction(3)).toBeCloseTo(eighty, 5);
  });

  it('never overflows or goes negative on a stray value', () => {
    setRatingScaleMax(5);
    expect(ratingFraction(99)).toBe(1);
    expect(ratingFraction(-4)).toBe(0);
  });

  it('falls back to 20-80 when the save does not say', () => {
    setRatingScaleMax(undefined);
    expect(ratingFraction(40)).toBe(0.5);
  });
});

describe('rounding to fives', () => {
  it('still applies on the scale it belongs to', () => {
    setRatingScaleMax(80);
    setRatingRounding(true);
    expect(formatRating(57)).toBe('55');
  });

  it('is ignored where the scale cannot carry it', () => {
    // A 3 would become a 5 and a 2 would vanish
    setRatingScaleMax(5);
    setRatingRounding(true);
    expect(formatRating(3)).toBe('3');
    expect(formatRating(2)).toBe('2');
    expect(formatRating(5)).toBe('5');
  });

  it('is ignored on the 1-20 scale too', () => {
    setRatingScaleMax(20);
    setRatingRounding(true);
    expect(formatRating(12)).toBe('12');
  });
});
