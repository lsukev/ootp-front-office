import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  PROVIDERS, OPENCODE_BASE_URL, DEFAULT_MODEL, describeError, isProviderId,
  providerFor, toolLoopFor,
} from '../server/providers.js';
import { FALLBACK_MODELS } from '../server/models.js';

/**
 * OpenCode Zen, the fourth way to reach a model.
 *
 * It is a gateway rather than a laboratory — one key reaching Claude, GPT,
 * Gemini, DeepSeek, Kimi and the rest, several of them free — and it answers
 * on the OpenAI wire shape, so it borrows that implementation entire and
 * changes only where the request is posted.
 *
 * Nothing here touches the network. What is worth holding down is the wiring,
 * which is where a new provider goes wrong: a missing entry in one of the
 * several maps keyed by provider id, or a tool loop that quietly returns null
 * and leaves the staff chat unable to look anything up.
 */

const zen = PROVIDERS.find((p) => p.id === 'opencode');

describe('OpenCode Zen as a provider', () => {
  it('is offered, and says where to get a key', () => {
    expect(zen).toBeDefined();
    expect(zen?.label).toMatch(/opencode/i);
    expect(zen?.console).toContain('opencode.ai');
  });

  it('is a recognised id', () => {
    expect(isProviderId('opencode')).toBe(true);
  });

  it('has an implementation behind it', () => {
    const impl = providerFor('opencode');
    expect(typeof impl.complete).toBe('function');
    expect(typeof impl.listModels).toBe('function');
    expect(typeof impl.validateKey).toBe('function');
  });

  it('posts to the documented gateway, versioned', () => {
    // The SDK appends /chat/completions and /models to this, so the version
    // segment has to be part of it or every call lands on a 404
    expect(OPENCODE_BASE_URL).toBe('https://opencode.ai/zen/v1');
  });

  it('can run the staff chat, tools and all', () => {
    // Returning null here is the quiet failure: the chat still answers, but
    // without a tool loop it cannot look a single player up
    expect(toolLoopFor('opencode')).toBeTypeOf('function');
  });

  it('starts on a model it also offers offline', () => {
    const offline = FALLBACK_MODELS.opencode.map((m) => m.id);
    expect(offline).toContain(DEFAULT_MODEL.opencode);
  });
});

describe('a failure on Zen', () => {
  it('is blamed on Zen, and points at Zen', () => {
    const said = describeError('opencode', { status: 401, message: 'Missing API key.' });
    expect(said).toMatch(/opencode/i);
    expect(said).not.toMatch(/anthropic|openai|google/i);
  });

  it('still tells a rate limit apart from an empty account', () => {
    const busy = describeError('opencode', { status: 429, message: 'rate limit exceeded' });
    expect(busy).toMatch(/wait/i);
    const broke = describeError('opencode', { status: 429, message: 'insufficient_quota' });
    expect(broke).toMatch(/credit/i);
    expect(broke).toContain('opencode.ai');
  });
});

/**
 * The browser has its own copy of the provider union, because the settings
 * page is typed against it and cannot import from the server. Adding a
 * provider means editing both, and forgetting the second one is silent: the
 * new provider is simply missing from the picker with nothing to say so.
 */
describe('the two lists of providers', () => {
  it('agree', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/pages/Settings.tsx'),
      'utf8'
    );
    const line = /export type ProviderId =([^;]+);/.exec(source)?.[1] ?? '';
    const inBrowser = [...line.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    const onServer = PROVIDERS.map((p) => p.id).sort();
    expect(inBrowser).toEqual(onServer);
  });
});
