import { describe, expect, it } from 'vitest';
import {
  PROVIDERS, isProviderId, providerFor, strictSchema, modelUnavailable,
  GEMINI_FALLBACK, DEFAULT_MODEL,
} from '../server/providers.js';
import { STORYLINE_SCHEMA } from '../server/storylines.js';

/**
 * The provider layer, checked where it does real work rather than where it
 * calls out.
 *
 * Nothing here touches a network. What is worth testing is the translation:
 * a schema written for one service being made acceptable to another is the
 * part that fails quietly, by being rejected at the far end on someone else's
 * machine with a key this repository has never held.
 */

describe('the providers on offer', () => {
  it('all have an implementation', () => {
    for (const p of PROVIDERS) expect(providerFor(p.id), p.id).toBeTruthy();
  });

  /*
   * Every service with a catalogue this app can name in advance starts on one,
   * so the AI features work the moment a key is saved. A local server is the
   * exception and deliberately starts on nothing: it has whatever you have
   * pulled, which might be one model or none, and naming a default would name
   * a model most people do not have. Settings lists what is installed instead.
   */
  it('starts on a model, unless the models are on your own machine', () => {
    for (const p of PROVIDERS) {
      if (p.id === 'ollama') expect(DEFAULT_MODEL[p.id]).toBe('');
      else expect(DEFAULT_MODEL[p.id], p.id).toMatch(/\S/);
    }
  });

  it('recognises its own ids and nothing else', () => {
    expect(isProviderId('anthropic')).toBe(true);
    expect(isProviderId('openai')).toBe(true);
    expect(isProviderId('gemini')).toBe(true);
    expect(isProviderId('opencode')).toBe(true);
    expect(isProviderId('ollama')).toBe(true);
    expect(isProviderId('claude')).toBe(false);
    expect(isProviderId(undefined)).toBe(false);
    expect(isProviderId(null)).toBe(false);
  });
});

/**
 * OpenAI will not run a strict structured output unless every object in the
 * schema forbids extra properties and lists every property as required. Ours
 * are written for Anthropic, which asks for neither, so they are adjusted on
 * the way out — and a miss anywhere in the tree is a 400 at the far end.
 */
describe('a schema on its way to OpenAI', () => {
  const strict = strictSchema(STORYLINE_SCHEMA) as Record<string, any>;

  const objects = (node: any, found: any[] = []): any[] => {
    if (Array.isArray(node)) node.forEach((n) => objects(n, found));
    else if (node && typeof node === 'object') {
      if (node.type === 'object' && node.properties) found.push(node);
      Object.values(node).forEach((n) => objects(n, found));
    }
    return found;
  };

  it('finds the nested objects, not just the outer one', () => {
    expect(objects(strict).length).toBeGreaterThan(1);
  });

  it('closes every object to extra properties', () => {
    for (const o of objects(strict)) expect(o.additionalProperties).toBe(false);
  });

  it('marks every property required, at every depth', () => {
    for (const o of objects(strict)) {
      expect([...o.required].sort()).toEqual(Object.keys(o.properties).sort());
    }
  });

  it('keeps the descriptions, which are what the model actually reads', () => {
    const headline = objects(strict).find((o) => o.properties.headline)?.properties.headline;
    expect(headline.description).toMatch(/\S/);
  });

  it('leaves the caller\u2019s schema untouched', () => {
    // Anthropic is sent the original object, so mutating it here would change
    // what the other provider receives from the same run
    const before = JSON.stringify(STORYLINE_SCHEMA);
    strictSchema(STORYLINE_SCHEMA);
    expect(JSON.stringify(STORYLINE_SCHEMA)).toBe(before);
  });

  it('closes an object that did not close itself', () => {
    const loose = { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } };
    const out = strictSchema(loose) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.required.sort()).toEqual(['a', 'b']);
  });
});

/**
 * Google's models endpoint is not a list of models you may call. Both
 * gemini-2.5-pro and gemini-2.5-flash are returned by it and both answer a
 * real request with 404 on a new key — verified against the live API — so the
 * picker offers choices that fail and nothing in the list says which. Rather
 * than hand that 404 to someone who wanted their storylines, the request is
 * made again on a model known to answer.
 *
 * What matters is the line between the two kinds of failure. Retrying a rate
 * limit or a bad key on a different model wastes money and fixes nothing.
 */
describe('telling an unusable model from a failed request', () => {
  it('catches the 404 shapes Google actually returns', () => {
    expect(modelUnavailable({ status: 404 })).toBe(true);
    expect(
      modelUnavailable({ message: 'This model models/gemini-2.5-pro is no longer available to new users.' })
    ).toBe(true);
    expect(modelUnavailable({ message: '{"error":{"code":404,"status":"NOT_FOUND"}}' })).toBe(true);
  });

  it('leaves the failures a different model would not fix', () => {
    expect(modelUnavailable({ status: 429, message: 'You exceeded your current quota' })).toBe(false);
    expect(modelUnavailable({ status: 401, message: 'API key not valid' })).toBe(false);
    expect(modelUnavailable({ status: 500, message: 'internal error' })).toBe(false);
    expect(modelUnavailable({ message: 'You have no credits remaining' })).toBe(false);
  });

  it('survives an error with nothing useful on it', () => {
    expect(modelUnavailable(null)).toBe(false);
    expect(modelUnavailable(new Error(''))).toBe(false);
  });

  it('falls back to a model that answered a real request', () => {
    // Changing this means having called the new one for real first
    expect(GEMINI_FALLBACK).toBe('gemini-3-flash-preview');
  });
});
