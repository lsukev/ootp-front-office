import { describe, expect, it, beforeEach } from 'vitest';
import { formatRating, formatRatingPair, setRatingRounding } from '../src/ratingScale.js';

/**
 * A display preference, and only that. The point of the test is the part that
 * is easy to get wrong: rounding must never reach the numbers anything is
 * decided on, and it must not invent a distinction the scale cannot carry.
 */

describe('with rounding off', () => {
  beforeEach(() => setRatingRounding(false));

  it('writes the exact grade', () => {
    expect(formatRating(57)).toBe('57');
    expect(formatRating(63)).toBe('63');
  });

  it('shows growth when there is any', () => {
    expect(formatRatingPair(55, 65)).toBe('55→65');
  });

  it('drops the arrow when a man is at his ceiling', () => {
    expect(formatRatingPair(60, 60)).toBe('60');
  });
});

describe('with rounding on', () => {
  beforeEach(() => setRatingRounding(true));

  it('rounds to the nearest five', () => {
    expect(formatRating(57)).toBe('55');
    expect(formatRating(58)).toBe('60');
    expect(formatRating(63)).toBe('65');
    expect(formatRating(62)).toBe('60');
  });

  it('leaves grades already on a five alone', () => {
    for (const v of [20, 45, 50, 65, 80]) expect(formatRating(v)).toBe(String(v));
  });

  it('hides a gap the scale cannot show', () => {
    // 58 and 61 are both 60 rounded, and "60 → 60" would imply a difference
    // the reader cannot see
    expect(formatRatingPair(58, 61)).toBe('60');
  });

  it('still shows a gap that survives rounding', () => {
    expect(formatRatingPair(56, 68)).toBe('55→70');
  });
});

describe('missing grades', () => {
  it('are a dash either way', () => {
    setRatingRounding(false);
    expect(formatRating(null)).toBe('—');
    setRatingRounding(true);
    expect(formatRating(undefined)).toBe('—');
  });

  it('leave the pair as just the overall when potential is unknown', () => {
    setRatingRounding(true);
    expect(formatRatingPair(57, null)).toBe('55');
  });
});

/**
 * OOTP exports the grade twice: `oa` as shown on the player's page, and
 * `oa_rating` as the same grade rounded to fives. The app reads `oa`, and the
 * Settings toggle is meant to reproduce `oa_rating` rather than invent its own
 * rounding — so the two must agree on every value the scale can hold.
 */
describe('the toggle reproduces OOTP’s own five-step grade', () => {
  it('matches round(oa/5)*5 across the whole 20-80 range', () => {
    setRatingRounding(true);
    for (let oa = 20; oa <= 80; oa++) {
      expect(formatRating(oa)).toBe(String(Math.round(oa / 5) * 5));
    }
  });
});
