import { describe, expect, it, beforeAll } from 'vitest';
import { TOOLS, runTool } from '../server/chat.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Every tool the staff chat is offered must actually answer.
 *
 * The list and the dispatcher are two separate pieces of code with no compiler
 * relationship between them, and eighteen entries is well past the number a
 * person keeps in his head. A tool declared and not wired does not fail
 * loudly: the model calls it, gets "Unknown tool", and either apologises or
 * quietly answers from something else — which reads as the assistant being
 * vague rather than as a bug in the app.
 *
 * A tool wired and not declared is the same fault pointing the other way: work
 * done and never offered.
 */

/*
 * These tools call back into the app over HTTP, so an unreachable server means
 * a fetch with nothing to time it out. Bounded explicitly: a hanging suite
 * tells you far less than a failing one, and takes an hour to do it.
 */
const LIMIT = 30_000;

beforeAll(async () => {
  // request() starts the server the tools call back into and publishes its port
  await request('/api/status');
}, LIMIT);

const argsFor = (name: string): Record<string, unknown> => {
  if (name === 'search_players') return { q: 'Fill', limit: 5 };
  if (name === 'get_player') return { player_id: IDS.starter };
  return { team_id: IDS.mlbTeam };
};

describe('the chat tool list', () => {
  it('offers something', () => {
    expect(TOOLS.length).toBeGreaterThan(10);
  });

  it('describes every tool it offers', () => {
    for (const t of TOOLS) {
      expect(t.description, `${t.name} has no description`).toBeTruthy();
      expect((t.description as string).length, `${t.name}'s description is too thin`)
        .toBeGreaterThan(30);
    }
  });

  it('names each tool once', () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size, `duplicate tool name in ${names.join(', ')}`).toBe(names.length);
  });
});

describe('every offered tool', () => {
  it('is wired to something that answers', async () => {
    const broken: string[] = [];
    for (const t of TOOLS) {
      try {
        const out = await runTool(t.name, argsFor(t.name));
        if (typeof out !== 'string' || out.length === 0) broken.push(`${t.name}: empty`);
      } catch (err) {
        /*
         * A tool that reports there is no data for this fixture has answered.
         * What must not happen is the dispatcher not knowing the name at all.
         */
        const message = (err as Error).message;
        if (/unknown tool/i.test(message)) broken.push(`${t.name}: not wired`);
      }
    }
    expect(broken, `tools declared but not answering: ${broken.join('; ')}`).toEqual([]);
  }, LIMIT);
});
