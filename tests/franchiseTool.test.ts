import { beforeAll, describe, expect, it } from 'vitest';
import { TOOLS, runTool } from '../server/chat.js';
import request from './request.js';

/**
 * The staff being able to talk about the club's past.
 *
 * A user asked about team history and was told there was no franchise history
 * tool — no past seasons, no pennants, nothing beyond the year being played.
 * That was true of the assistant and not of the app: the Franchise History
 * page had been reading a hundred and forty-four seasons out of the same save
 * the whole time. The page had it; the man you ask did not.
 */

describe('the franchise history tool', () => {
  // The tools answer by calling the app's own API, so it has to be listening
  beforeAll(async () => { await request('/api/franchise/1'); });

  it('is offered to the staff at all', () => {
    const tool = TOOLS.find((t) => t.name === 'get_franchise_history');
    expect(tool).toBeDefined();
    // Said plainly enough that it is reached for when the past comes up
    expect(tool!.description).toMatch(/past|season by season|pennant/i);
  });

  it('takes a club and a starting year, and needs neither', () => {
    const schema = TOOLS.find((t) => t.name === 'get_franchise_history')!.input_schema as {
      properties: Record<string, unknown>;
      required?: string[];
    };
    expect(Object.keys(schema.properties)).toEqual(['team_id', 'since']);
    expect(schema.required ?? []).toEqual([]);
  });

  it('answers with the seasons and the totals across them', async () => {
    const raw = await runTool('get_franchise_history', {});
    const parsed = JSON.parse(raw) as { summary?: unknown; seasons?: unknown[] };
    expect(parsed).toHaveProperty('summary');
    expect(Array.isArray(parsed.seasons)).toBe(true);
  });

  it('trims to the years asked for, so a decade is not a century', async () => {
    const all = JSON.parse(await runTool('get_franchise_history', {})) as {
      seasons: Array<{ year: number }>;
    };
    if (all.seasons.length === 0) return; // fixture carries no history to trim
    const cutoff = all.seasons[0].year;
    const recent = JSON.parse(await runTool('get_franchise_history', { since: cutoff })) as {
      seasons: Array<{ year: number }>;
    };
    expect(recent.seasons.length).toBeLessThanOrEqual(all.seasons.length);
    for (const s of recent.seasons) expect(s.year).toBeGreaterThanOrEqual(cutoff);
  });
});
