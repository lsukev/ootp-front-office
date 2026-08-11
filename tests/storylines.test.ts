import { describe, expect, it } from 'vitest';
import { STORYLINE_SCHEMA, storylineFault, usableStoryline } from '../server/storylines.js';

/**
 * A user's Storylines page read "placeholder" over and over, and pressing the
 * regenerate button returned the same thing — the model had emitted filler,
 * the schema was satisfied because a string is a string, and the empty result
 * had been written to the cache.
 */

const real = {
  category: 'The Club',
  headline: 'Boston has won nine of twelve behind a rotation nobody expected',
  body:
    'The Red Sox are 9-3 over the last twelve with a 2.88 rotation ERA, and the men doing it were ' +
    'meant to be the weakness of this roster. Whether it holds is another question, but the ' +
    'division lead is real and it is three games.',
};

describe('storylines that should be kept', () => {
  it('accepts one that names the club and cites figures', () => {
    expect(usableStoryline(real)).toBe(true);
  });
});

describe('storylines that should be thrown away', () => {
  it('rejects the exact filler a user was shown', () => {
    expect(usableStoryline({ category: 'The Club', headline: 'placeholder', body: 'placeholder' })).toBe(false);
  });

  it('rejects other filler words', () => {
    for (const word of ['TBD', 'todo', 'Lorem ipsum dolor sit amet', 'N/A', 'Example headline']) {
      expect(usableStoryline({ category: 'The Club', headline: word, body: word })).toBe(false);
    }
  });

  it('rejects a headline with a real body, and the reverse', () => {
    expect(usableStoryline({ ...real, headline: 'placeholder' })).toBe(false);
    expect(usableStoryline({ ...real, body: 'placeholder' })).toBe(false);
  });

  it('rejects a body too short to say anything', () => {
    expect(usableStoryline({ ...real, body: 'They are good.' })).toBe(false);
  });

  it('rejects a malformed entry rather than throwing on it', () => {
    expect(usableStoryline({ category: 'The Club' } as never)).toBe(false);
    expect(usableStoryline(null as never)).toBe(false);
  });
});

/**
 * Structured output accepts a small slice of JSON Schema, and a schema it does
 * not accept fails the entire request — a page that occasionally read
 * "placeholder" became one that would not generate at all, because minItems: 5
 * is rejected outright. Standards belong in the descriptions and in
 * usableStoryline, not in keywords the API will refuse.
 */
describe('the storyline schema', () => {
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
    walk(STORYLINE_SCHEMA, 'schema', found);
    expect(found).toEqual([]);
  });

  it('still tells the model what is wanted, in descriptions', () => {
    const json = JSON.stringify(STORYLINE_SCHEMA);
    expect(json).toContain('description');
    expect(json.toLowerCase()).toContain('placeholder');
  });
});

/**
 * The reason an entry was dropped, which the error message now quotes back.
 * Three consecutive faults here were diagnosed by reasoning from a one-line
 * message and each guess was wrong, so the failure states what it saw.
 */
describe('why an entry was rejected', () => {
  const real = {
    category: 'The Club',
    headline: 'Boston has won nine of twelve behind a rotation nobody expected',
    body:
      'The Red Sox are 9-3 over the last twelve with a 2.88 rotation ERA, and the men doing it ' +
      'were meant to be the weakness of this roster. The division lead is three games.',
  };

  it('says nothing about a good one', () => {
    expect(storylineFault(real)).toBeNull();
  });

  it('names filler for what it is, and which field', () => {
    expect(storylineFault({ ...real, headline: 'placeholder' })).toBe('filler headline');
    expect(storylineFault({ ...real, body: 'placeholder' })).toBe('filler body');
  });

  it('reports a short body with its length, so the threshold can be judged', () => {
    expect(storylineFault({ ...real, body: 'They are good.' })).toBe('body too short (14)');
  });

  it('reports a short headline with its length', () => {
    expect(storylineFault({ ...real, headline: 'Sox win' })).toBe('headline too short (7)');
  });

  it('calls a malformed entry malformed rather than throwing', () => {
    expect(storylineFault({ category: 'The Club' } as never)).toBe('malformed');
    expect(storylineFault(null as never)).toBe('malformed');
  });
});
