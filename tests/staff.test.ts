import { describe, expect, it } from 'vitest';
import { personaBrief, personasFor } from '../server/staff.js';
import { IDS } from './fixture';

/**
 * The staff personas are built out of the save, and the failure mode is silent:
 * a mistyped column name yields a man with no opinions rather than an error, and
 * the chat still works — it just stops feeling like anyone in particular. These
 * check that the specifics actually survive the trip.
 */

const brief = (orgId: number, id: string): string => {
  const p = personasFor(orgId).find((x) => x.id === id)!;
  return personaBrief(p, orgId);
};

describe('staff read from the save', () => {
  it('uses the real man in the seat, not a role label', () => {
    const people = personasFor(IDS.mlbTeam);
    const mgr = people.find((p) => p.id === 'manager');
    expect(mgr?.name).toBe('Skip Ratchet');
  });

  it('gives him a biography', () => {
    const b = brief(IDS.mlbTeam, 'manager');
    expect(b).toContain('You are 58');
    expect(b).toContain('12 years in the job');
    expect(b).toContain('2 more years');
  });

  it('knows he played, and what he did', () => {
    // The fixture points his former_player_id at a man with major-league at-bats
    expect(brief(IDS.mlbTeam, 'manager')).toContain('You played in the majors yourself');
  });

  it('turns his strategy sliders into convictions, with the right sign', () => {
    const b = brief(IDS.mlbTeam, 'manager');
    expect(b).toContain('You almost never bunt.');          // bunt -4
    expect(b).toContain('You have no use for an opener.');  // opener -5
    expect(b).toContain('You run on anybody.');             // stealing +4
    // Never claim the opposite of what the save says
    expect(b).not.toContain('You will use an opener.');
    expect(b).not.toContain('You do not give away outs on the bases.');
  });

  it('leaves out the tendencies he only mildly holds', () => {
    // shift_if is 0 — a man with no view on shifting should not be given one
    const b = brief(IDS.mlbTeam, 'manager');
    expect(b).not.toContain('You shift the infield aggressively.');
    expect(b).not.toContain('You leave your infield where it belongs.');
  });

  it('says how he weighs evidence', () => {
    // value_stats 8 against ratings_value -2
    expect(brief(IDS.mlbTeam, 'manager')).toContain('what a man has actually done');
  });

  it('knows his colleagues by name', () => {
    expect(brief(IDS.mlbTeam, 'manager')).toContain('Peter (front-office analyst)');
  });

  it('leaves an unfilled seat empty rather than inventing someone', () => {
    const ids = personasFor(IDS.mlbTeam).map((p) => p.id);
    expect(ids).toContain('manager');
    // The fixture hires nobody else, and a club cannot consult a scout it lacks
    expect(ids).not.toContain('scout');
    expect(ids).not.toContain('owner');
  });

  it('still offers Peter on a club with no staff at all', () => {
    const people = personasFor(IDS.otherMlbTeam);
    expect(people.map((p) => p.id)).toEqual(['analyst']);
  });
});
