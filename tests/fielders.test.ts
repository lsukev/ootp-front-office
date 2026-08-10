import { describe, expect, it } from 'vitest';
import { chooseFielders, type Candidate } from '../server/lineup.js';

/**
 * The position assignment, on rosters built to make one arrangement clearly
 * right. Its job is to maximise the total of every fielder's bat adjusted for
 * how well he plays the spot he is standing in, so each case here computes
 * that total by hand and checks the optimiser found it.
 */

const player = (
  name: string,
  off: number,
  defense: Record<number, number>,
  position = 0
): Candidate => ({
  player_id: name.length * 1000 + off,
  name,
  age: 27,
  position,
  positionName: '',
  bats: 1,
  dayToDay: false,
  off,
  contact: 50,
  power: 50,
  eye: 50,
  speed: 50,
  defense,
});

/** The objective: bat plus eight points per point of glove above average. */
const total = (assigned: Map<number, Candidate>): number => {
  let sum = 0;
  for (const [pos, c] of assigned) sum += c.off + 8 * ((c.defense[pos] ?? 0) - 50);
  return sum;
};

describe('choosing who plays where', () => {
  it('gets a man into the lineup even when two others must move to make room', () => {
    // The case that prompted this: a specialist rated at exactly one position,
    // behind a better bat who can also play it. A greedy fill gives the spot to
    // the bat, and no swap of two men on the field can ever undo that, because
    // the specialist is not on the field to be swapped.
    const specialist = player('OnlyCentre', 700, { 8: 80 }, 8);
    const flexible = player('Flexible', 1000, { 8: 50, 4: 50 }, 4);
    const weak = player('WeakBat', 400, { 4: 50 }, 4);

    const assigned = chooseFielders([specialist, flexible, weak], [8, 4]);

    expect(assigned.get(8)?.name).toBe('OnlyCentre');
    expect(assigned.get(4)?.name).toBe('Flexible');
    // Greedy would take Flexible in centre (1000 beats 700 + 240) and be stuck
    // with WeakBat at second, for 1400. The optimum is 1940.
    expect(total(assigned)).toBe(1940);
  });

  it('will not put a man somewhere he is not rated', () => {
    const catcher = player('Catcher', 100, { 2: 50 }, 2);
    const slugger = player('Slugger', 5000, { 3: 50 }, 3);

    const assigned = chooseFielders([catcher, slugger], [2, 3]);

    // The big bat cannot catch, however much the total would like him to
    expect(assigned.get(2)?.name).toBe('Catcher');
    expect(assigned.get(3)?.name).toBe('Slugger');
  });

  it('mans a position nobody is rated at rather than leaving it empty', () => {
    const one = player('One', 900, { 6: 60 }, 6);
    const two = player('Two', 800, { 6: 55 }, 6);

    const assigned = chooseFielders([one, two], [6, 2]);

    expect(assigned.size).toBe(2);
    expect(assigned.get(6)?.name).toBe('One');
    // Someone has to crouch behind the plate, and it is the man the card can
    // best afford to move off his own position
    expect(assigned.get(2)?.name).toBe('Two');
  });

  it('fills what it can when the roster is short', () => {
    const only = player('Only', 900, { 6: 60 }, 6);
    const assigned = chooseFielders([only], [6, 2, 8]);
    expect(assigned.size).toBe(1);
    expect(assigned.get(6)?.name).toBe('Only');
  });

  it('settles a dead tie in favour of the man who plays there', () => {
    // Same glove, and the DH slot rates everyone alike, so the two
    // arrangements score identically. The regular should field.
    const regular = player('Regular', 1000, { 4: 55, 10: 50 }, 4);
    const backup = player('Backup', 1000, { 4: 55, 10: 50 }, 4);
    backup.position = 0; // not listed at second

    const assigned = chooseFielders([backup, regular], [4, 10]);

    expect(assigned.get(4)?.name).toBe('Regular');
    expect(assigned.get(10)?.name).toBe('Backup');
  });

  it('sends the best remaining bat to the DH, not whoever was left over', () => {
    const glove = player('GoodGlove', 600, { 8: 70, 10: 50 }, 8);
    const bat = player('BigBat', 1500, { 8: 50, 10: 50 }, 8);
    const spare = player('Spare', 300, { 10: 50 });

    const assigned = chooseFielders([glove, bat, spare], [8, 10]);

    expect(assigned.get(8)?.name).toBe('GoodGlove');
    expect(assigned.get(10)?.name).toBe('BigBat');
  });
});
