import { describe, expect, it } from 'vitest';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * The seats on the staff page.
 *
 * "Why no 1B or 3B coaches in listing?"
 *
 * Because the page's role list named seven seats and the export carries nine.
 * team_roster_staff has first_base_coach and third_base_coach columns like
 * every other role, filled in every export I have looked at — they were never
 * read. Nothing was wrong with the data.
 *
 * Which occupation is which was settled from the save rather than assumed:
 * team_roster_staff.first_base_coach points at a coach whose occupation is 14
 * and third_base_coach at a 15.
 */

const staff = async () => (await request(`/api/staff/${IDS.mlbTeam}`)).staff as Array<{
  role: string; name: string; seatRating: { label: string; value: number } | null;
  ratings: Array<{ label: string; value: number }>;
}>;

describe('the staff a club actually has', () => {
  it('lists the first base coach', async () => {
    const him = (await staff()).find((s) => s.role === 'First Base Coach');
    expect(him, 'the first base coach was missing from the staff list').toBeDefined();
    expect(him!.name).toBe('Waves Hendry');
  });

  it('lists the third base coach', async () => {
    const him = (await staff()).find((s) => s.role === 'Third Base Coach');
    expect(him, 'the third base coach was missing from the staff list').toBeDefined();
    expect(him!.name).toBe('Windmill Alfonzo');
  });

  /*
   * A seat with no ratings against it is a row that raises the question it was
   * added to answer. Base coaches are shown on what OOTP gives them, and in
   * the save that prompted this they held the fielding teaching roles.
   */
  it('shows what a base coach is actually rated on', async () => {
    const him = (await staff()).find((s) => s.role === 'Third Base Coach')!;
    const by = Object.fromEntries(him.ratings.map((r) => [r.label, r.value]));
    expect(by['Teach Running']).toBe(133);
    expect(by['Teach IF']).toBe(142);
    expect(by['Teach OF']).toBe(141);
  });

  it('keeps the seats that were already there', async () => {
    const roles = (await staff()).map((s) => s.role);
    expect(roles).toContain('Manager');
    expect(roles).toContain('General Manager');
  });

  /*
   * Field staff read together. A base coach filed after the team doctor would
   * be findable and still wrong.
   */
  it('puts the base coaches with the rest of the field staff', async () => {
    const roles = (await staff()).map((s) => s.role);
    expect(roles.indexOf('First Base Coach')).toBeLessThan(roles.indexOf('Head Scout'));
    expect(roles.indexOf('Third Base Coach')).toBeLessThan(roles.indexOf('Head Scout'));
    expect(roles.indexOf('First Base Coach')).toBeGreaterThan(roles.indexOf('Manager'));
  });
});


/**
 * The number OOTP keeps and never shows.
 *
 * "I do like the rating system that is not in OOTP but in the data base. A
 * nice addition would be to add the rating to each personnel."
 *
 * It is already in the export, on the 1-200 scale every coach rating uses —
 * the same composite the promotion list has always ranked on. Each seat gets
 * the one for THAT seat: a hitting coach's worth as a scout is not what he
 * was hired for.
 */
describe('what OOTP thinks of a man in his seat', () => {
  it('gives the manager his manager rating', async () => {
    const him = (await staff()).find((s) => s.role === 'Manager')!;
    expect(him.seatRating).toEqual({ label: 'Manager rating', value: 157 });
  });

  /*
   * Asserted on the number, not the label. The label is written in the map and
   * would go on reading "Base coach rating" over whatever field it was pointed
   * at — this coach is deliberately rated 184 as a manager and 134 on a base,
   * so only the right field gives the right answer.
   */
  it('gives a base coach the base-coach composite, not the manager one', async () => {
    const him = (await staff()).find((s) => s.role === 'Third Base Coach')!;
    expect(him.seatRating).toEqual({ label: 'Base coach rating', value: 134 });
  });

  it('gives a bench coach his manager rating, which is the seat he understudies', async () => {
    const roles = await staff();
    const bench = roles.find((s) => s.role === 'Bench Coach');
    if (bench) expect(bench.seatRating?.label).toBe('Rating as a manager');
  });

  /*
   * OOTP publishes no composite for a general manager at all. Showing a
   * different seat's number under his name would be inventing a rating.
   */
  it('says nothing for a seat OOTP publishes no rating for', async () => {
    const him = (await staff()).find((s) => s.role === 'General Manager')!;
    expect(him.seatRating).toBeNull();
  });

  it('says nothing rather than zero where the value is missing', async () => {
    for (const s of await staff()) {
      if (s.seatRating) expect(s.seatRating.value).toBeGreaterThan(0);
    }
  });
});
