import { describe, expect, it } from 'vitest';
import { describeError } from '../server/providers.js';

/**
 * Failures, said in words.
 *
 * Google's SDK raises its response body, JSON nested inside JSON, and it went
 * straight to the page — a reader who wanted their storylines got
 * `{"error":{"message":"{\n \"error\": {\n \"code\"…` instead. The samples
 * below are the real thing, copied from calls this app actually made.
 *
 * The distinction that matters is inside the 429: too many requests in the
 * last minute fixes itself, an account with no money in it does not, and
 * telling somebody to wait when they need to add credit wastes their evening.
 */

const GEMINI_404 =
  '{"error":{"code":404,"message":"This model models/gemini-2.5-pro is no longer available to new users. Please update your code to use a newer model.","status":"NOT_FOUND"}}';
const GEMINI_NESTED =
  '{"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"Function call is missing a thought_signature in functionCall parts.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n","code":400,"status":"Bad Request"}}';
const OPENAI_NO_CREDIT =
  '429 You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.';

describe('turning a failure into a sentence', () => {
  it('never hands back raw JSON', () => {
    for (const raw of [GEMINI_404, GEMINI_NESTED, OPENAI_NO_CREDIT]) {
      const said = describeError('gemini', { message: raw });
      expect(said, raw.slice(0, 40)).not.toContain('{');
      expect(said).not.toContain('\\n');
    }
  });

  it('digs the sentence out of a body nested twice', () => {
    expect(describeError('gemini', { message: GEMINI_NESTED })).toContain('thought_signature');
  });

  it('tells an empty balance from a rate limit, which need different things', () => {
    const broke = describeError('openai', { status: 429, message: OPENAI_NO_CREDIT });
    expect(broke).toMatch(/out of credit/i);
    expect(broke).toContain('platform.openai.com');

    const busy = describeError('openai', { status: 429, message: 'Rate limit reached for requests' });
    expect(busy).toMatch(/wait a moment|clears by itself/i);
    expect(busy).not.toMatch(/out of credit/i);
  });

  it('does not send a free-tier user to a billing page they do not need', () => {
    // Google says this for a per-minute limit that clears on its own, and it
    // was being reported as an empty account
    const said = describeError('gemini', {
      status: 429,
      message: 'You exceeded your current quota, please check your plan and billing details.',
    });
    expect(said).not.toMatch(/out of credit/i);
    expect(said).toMatch(/wait a minute/i);
    expect(said).toMatch(/allowance on your plan/i);
  });

  it('says a rejected key is a rejected key', () => {
    expect(describeError('gemini', { status: 400, message: 'API key not valid. Please pass a valid API key.' }))
      .toMatch(/rejected your API key/i);
    expect(describeError('anthropic', { status: 401, message: 'unauthorized' }))
      .toMatch(/rejected your API key/i);
  });

  it('does not blame the save for the service being down', () => {
    const said = describeError('anthropic', { status: 503, message: 'overloaded' });
    expect(said).toMatch(/their end|problem/i);
    expect(said).toMatch(/nothing is wrong with your save/i);
  });

  it('recognises a machine that is simply offline', () => {
    expect(describeError('openai', { message: 'fetch failed' })).toMatch(/connection/i);
  });

  it('passes an already-plain message through unharmed', () => {
    const plain = 'Generation ran out of tokens — try again.';
    expect(describeError('openai', new Error(plain))).toBe(plain);
  });
});
