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
 * The rule that shapes the code is OOTP's own. The game prints a number at a
 * position it has revealed and a dash everywhere else, and a current rating
 * above zero is exactly that flag. Trent Grisham's card in the game shows 60
 * in center and a dash at all eight others, while his row here holds a 75
 * ceiling in left, a 65 in right and a 70 as a pitcher — and right field is
 * the case that settles it, because he has two hundred experience there and
 * the game still prints a dash. Having played somewhere does not reveal it.
 *
 * So the app shows what the game shows. Printing a withheld ceiling would hand
 * over a scouting report that has not been earned, in an app whose purpose is
 * to read the save rather than to play it for you.
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

  it('says nothing about a position the game has not revealed', () => {
    // 3B carries a 60 ceiling and 200 experience, and OOTP still prints a dash
    const g = gloves(STOTT)!;
    expect(g.positions.some((p) => p.code === '3B')).toBe(false);
    expect(glovesLine(STOTT)).not.toContain('3B');
  });

  it('never calls a position player a pitcher', () => {
    // The 80 he carries there is a default, and unrevealed besides
    const g = gloves(STOTT)!;
    expect(g.positions.some((p) => p.code === 'P')).toBe(false);
    expect(glovesLine(STOTT)).not.toContain('at P');
  });

  it('leaks no withheld ceiling into the line at all', () => {
    // The ceilings behind the dashes: 60 at third, 80 as a pitcher
    const line = glovesLine(STOTT)!;
    expect(line).not.toContain('80');
    expect(line).not.toContain('unrated');
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
