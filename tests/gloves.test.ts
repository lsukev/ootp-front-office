import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { gloves, glovesLine } from '../server/gloves.js';

/**
 * What a man can play, and how well.
 *
 * This exists because the trade desk was asked whether a second baseman could
 * be moved to shortstop and answered that it had no fielding ratings in front
 * of it. It was right not to guess. The ratings were in the save the whole
 * time; nothing was reading them.
 *
 * The case that shapes the code is the pitcher's slot. Across a real league
 * 8,589 position players carry exactly 80 potential as a pitcher — a flat
 * default sitting where a rating should be — so reporting it would have the
 * app telling you your shortstop is a future ace. Every other position is
 * reported however faint, including ones he has never played, because a
 * ceiling somewhere he has never stood is the whole basis for asking whether
 * he could be moved there.
 */

const STOTT = 90_001;   // a second baseman with a shortstop's ceiling
const CATCHER = 90_002;
const PITCHER = 90_003;

const insert = (row: Record<string, number>): void => {
  const keys = Object.keys(row);
  db.prepare(
    `INSERT INTO players_fielding (${keys.join(', ')}) VALUES (${keys.map((k) => `@${k}`).join(', ')})`
  ).run(row);
};

beforeAll(() => {
  // 60 at second, 35 at short with a 55 ceiling — the real shape of the case
  insert({
    player_id: STOTT, position: 4,
    fielding_rating_pos4: 60, fielding_rating_pos4_pot: 60,
    fielding_rating_pos6: 35, fielding_rating_pos6_pot: 55,
    fielding_rating_pos5: 0, fielding_rating_pos5_pot: 60, fielding_experience4: 200,
    fielding_rating_pos1: 0, fielding_rating_pos1_pot: 80,
    fielding_ratings_infield_range: 60, fielding_ratings_infield_arm: 60,
    fielding_ratings_turn_doubleplay: 60, fielding_ratings_infield_error: 65,
    fielding_ratings_catcher_framing: 20,
  });
  insert({
    player_id: CATCHER, position: 2,
    fielding_rating_pos2: 65, fielding_rating_pos2_pot: 65,
    fielding_ratings_catcher_arm: 55, fielding_ratings_catcher_framing: 70,
  });
  insert({
    player_id: PITCHER, position: 1,
    fielding_rating_pos1: 70, fielding_rating_pos1_pot: 70,
    fielding_ratings_catcher_framing: 20,
  });
});

describe('a second baseman asked about shortstop', () => {
  it('reports both, current and ceiling', () => {
    const line = glovesLine(STOTT)!;
    expect(line).toContain('60 at 2B');
    expect(line).toContain('35 at SS (ceiling 55)');
  });

  it('reports a position he has never played, since that is the question', () => {
    // 3B: no current grade, a 60 ceiling — exactly what makes a move thinkable
    expect(glovesLine(STOTT)).toContain('unrated at 3B (ceiling 60)');
  });

  it('never calls a position player a pitcher', () => {
    const g = gloves(STOTT)!;
    expect(g.positions.some((p) => p.code === 'P')).toBe(false);
    expect(glovesLine(STOTT)).not.toContain('at P');
  });

  it('leads with the position he is listed at', () => {
    expect(gloves(STOTT)!.positions[0]).toMatchObject({ code: '2B', isPrimary: true });
  });

  it('carries the infield components and not the catcher ones', () => {
    const c = gloves(STOTT)!.components;
    expect(c.infieldRange).toBe(60);
    expect(c.infieldTurnDoublePlay).toBe(60);
    expect(c).not.toHaveProperty('catcherFraming');
  });
});

describe('the other shapes', () => {
  it('gives a catcher his framing', () => {
    expect(gloves(CATCHER)!.components.catcherFraming).toBe(70);
  });

  it('keeps the pitcher slot for an actual pitcher', () => {
    expect(glovesLine(PITCHER)).toContain('70 at P');
  });

  it('does not hand a pitcher a catcher’s framing', () => {
    expect(gloves(PITCHER)!.components).not.toHaveProperty('catcherFraming');
  });

  it('says nothing at all about a man with no fielding row', () => {
    expect(gloves(99_999_999)).toBeNull();
    expect(glovesLine(99_999_999)).toBeNull();
  });
});
