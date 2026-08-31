import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { ISSUE_SCHEMA, assembleIssue, composeIssue, storyFault, usableStory } from '../server/newspaper.js';
import { assembleDay } from '../server/recap.js';
import { IDS } from './fixture.js';

/**
 * The league, written up as a paper.
 *
 * "I would like to completely revamp the headlines section to be a full press
 * media/sports newspaper for the league."
 *
 * The prose is the model's and nothing here can test it. What can be tested is
 * everything around it: that the desk it writes from is the same data the rest
 * of the app reports, that an issue with no front page is refused rather than
 * cached, and that a section the data could not fill is dropped instead of
 * padded. Those are the ways this feature can be wrong without looking wrong.
 */

const lead = {
  headline: 'Giants outlast Diamondbacks in 14, widen West lead',
  standfirst: "San Francisco's 6-5 road win pushes the Giants to 25-16 and a three-game cushion.",
  body:
    'San Francisco needed fourteen innings in Phoenix and got them, edging Arizona 6-5 to move to ' +
    '25-16 and extend its lead in the West to three. The win is the second straight for the Giants, ' +
    'while the Diamondbacks slid to 18-23 and seven games back.',
};

beforeAll(() => {
  db.prepare(`INSERT INTO divisions VALUES (?, 0, 1, 'East Division', 0)`).run(IDS.league);
  db.prepare(
    `INSERT INTO games (game_id, home_team, away_team, date, played, league_id, game_type,
                        runs0, runs1, innings)
     VALUES (7701, ?, ?, '2027-9-3', 1, ?, 0, 4, 2, 9)`
  ).run(IDS.mlbTeam, IDS.otherMlbTeam, IDS.league);
});

/**
 * The whole reason this replaced two pages rather than becoming a third.
 *
 * A paper that disagreed with the recap about last night's scores would be
 * worse than no paper, so it is not allowed its own gatherer — it reads the
 * ones already there. This pins that: change how the recap finds yesterday and
 * the paper changes with it, or this fails.
 */
describe("the editor's desk", () => {
  it('reports the same day the recap does, from the same gatherer', () => {
    const issue = assembleIssue(IDS.mlbTeam);
    const day = assembleDay(IDS.mlbTeam);
    expect(issue.date).toBe(day.date);
    expect(issue.results).toEqual(day.games);
    expect(issue.standings).toEqual(day.standings);
    expect(issue.leaders).toEqual(day.leaders);
  });

  it('names the reader’s club so the prompt can tell the model not to lead on it', () => {
    expect(assembleIssue(IDS.mlbTeam).readersClub).toBeTruthy();
  });

  it('marks which transactions are the reader’s own', () => {
    for (const t of assembleIssue(IDS.mlbTeam).transactions) {
      expect(typeof t.involvesTheReadersClub).toBe('boolean');
    }
  });

  it('carries the league rules, because this may not be the modern game', () => {
    expect(assembleIssue(IDS.mlbTeam).leagueRules).toEqual(assembleDay(IDS.mlbTeam).leagueRules);
  });
});

/**
 * A missing front page is a failure. A missing section is a quiet Tuesday.
 */
describe('composing the issue', () => {
  it('refuses an issue with no front page rather than caching one', () => {
    expect(() => composeIssue({ masthead: 'The Ledger', lead: undefined as never, sections: [], briefs: [] }, 'NL', 'test-model'))
      .toThrow(/no front page/);
  });

  it('refuses a front page that is filler, which the schema cannot catch', () => {
    expect(() => composeIssue({ masthead: 'The Ledger', lead: { headline: 'placeholder', body: 'placeholder' }, sections: [], briefs: [] }, 'NL', 'test-model'))
      .toThrow(/filler headline/);
  });

  it('says which fault it saw, so the reason is not guessed at', () => {
    expect(() => composeIssue({ masthead: 'x', lead: { headline: lead.headline, body: 'Short.' }, sections: [], briefs: [] }, 'NL', 'test-model'))
      .toThrow(/body too short \(6\)/);
  });

  it('drops a section the model could not fill instead of printing its title', () => {
    const issue = composeIssue(
      {
        masthead: 'The Ledger',
        lead,
        sections: [
          { title: 'The Races', stories: [{ headline: 'Tigers skid to third straight', body: lead.body }] },
          { title: 'Farm Report', stories: [] },
          { title: 'Injuries', stories: [{ headline: 'placeholder', body: 'placeholder' }] },
          { title: '', stories: [{ headline: 'Untitled section', body: lead.body }] },
        ],
        briefs: [],
      },
      'NL',
      'test-model'
    );
    expect(issue.sections.map((s) => s.title)).toEqual(['The Races']);
  });

  it('keeps briefs that are sentences and drops the fragments', () => {
    const issue = composeIssue(
      { masthead: 'The Ledger', lead, sections: [], briefs: ['Mason Miller has 14 saves, tied for the MLB lead.', 'TBD', '', 'x'] },
      'NL',
      'test-model'
    );
    expect(issue.briefs).toEqual(['Mason Miller has 14 saves, tied for the MLB lead.']);
  });

  it('names the paper after the league when the model would not name it', () => {
    for (const masthead of [undefined, '', '  ', 'x']) {
      expect(composeIssue({ masthead: masthead as never, lead, sections: [], briefs: [] }, 'National League', 'test-model').masthead)
        .toBe('National League Daily');
    }
  });

  it('keeps the name the model chose when it chose one', () => {
    expect(composeIssue({ masthead: '  Diamond Ledger  ', lead, sections: [], briefs: [] }, 'NL', 'test-model').masthead)
      .toBe('Diamond Ledger');
  });

  it('survives a reply that is missing its arrays entirely', () => {
    const issue = composeIssue({ masthead: 'The Ledger', lead } as never, 'NL', 'test-model');
    expect(issue.sections).toEqual([]);
    expect(issue.briefs).toEqual([]);
  });
});

describe('a story worth printing', () => {
  it('accepts one that carries its figures', () => {
    expect(usableStory(lead)).toBe(true);
    expect(storyFault(lead)).toBeNull();
  });

  it('rejects the filler a model reaches for when it has nothing', () => {
    for (const word of ['placeholder', 'TBD', 'todo', 'Lorem ipsum dolor sit amet', 'N/A', 'Example headline']) {
      expect(usableStory({ headline: word, body: word })).toBe(false);
    }
  });

  it('rejects a malformed story rather than throwing on it', () => {
    expect(usableStory(null as never)).toBe(false);
    expect(usableStory({ headline: lead.headline } as never)).toBe(false);
  });
});

/**
 * Structured output accepts a small slice of JSON Schema, and a keyword it does
 * not accept fails the whole request. The storylines page shipped `minItems`
 * once and stopped generating altogether; standards belong in the descriptions.
 */
describe('the issue schema', () => {
  const banned = ['minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum'];

  const walk = (node: unknown, path: string, found: string[]): void => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (banned.includes(key)) found.push(`${path}.${key}`);
      walk(value, `${path}.${key}`, found);
    }
  };

  it('uses no keyword the API rejects', () => {
    const found: string[] = [];
    walk(ISSUE_SCHEMA, 'schema', found);
    expect(found).toEqual([]);
  });

  it('asks for the counts in prose instead', () => {
    const json = JSON.stringify(ISSUE_SCHEMA).toLowerCase();
    expect(json).toContain('three to five sections');
    expect(json).toContain('four to eight');
  });
});
