import { describe, expect, it } from 'vitest';
import { orgBriefing } from '../server/valuation.js';
import { IDS } from './fixture.js';

/**
 * The assistant is told which clubs are its own, rather than left to work it
 * out or remember it.
 *
 * A reader asked about a player at Norfolk and was told he was not in the
 * organisation — the assistant had the club down as an Astros affiliate. The
 * export was right and always had been: Norfolk's parent is Baltimore, in the
 * column the teams tool returns. It had answered from what it knew of real
 * baseball instead of looking, which a smaller model does more readily than a
 * large one — the same reader found the answer corrected itself when he
 * switched from Haiku to Opus.
 *
 * The app made that easy. It named the club he runs and stopped, so "is this
 * man in my organisation" could only be answered by fetching three hundred
 * clubs and reading the parent of each, and a model that would rather not is a
 * model that guesses. Naming them costs a line and removes the question.
 */

describe('the organisation, as the assistant is told it', () => {
  const said = orgBriefing(IDS.mlbTeam);

  it('names the major-league club', () => {
    expect(said).toContain('Test Nine');
  });

  it('names the affiliate, with its level', () => {
    expect(said).toContain('Farm Hands');
    expect(said).toMatch(/Farm Hands \(AAA/);
  });

  it('carries the team ids, so a tool call needs no second lookup', () => {
    expect(said).toContain(`team_id ${IDS.mlbTeam}`);
    expect(said).toContain(`team_id ${IDS.aaaTeam}`);
  });

  it('leaves out a club belonging to somebody else', () => {
    expect(said).not.toContain('Other Club');
  });

  it('says outright that real-world affiliations do not apply', () => {
    expect(said).toMatch(/real/i);
    expect(said).toMatch(/no others/i);
  });

  it('says nothing at all for a club that has none', () => {
    // A club with no affiliates and no id of its own should not produce a
    // sentence claiming an empty organisation
    expect(orgBriefing(999_999)).toBe('');
  });
});
