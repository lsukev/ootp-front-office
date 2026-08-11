import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { forgetUnusable, isUnusable, markUnusable, unusableModels } from '../server/unusable.js';

/**
 * Remembering that a model will not run.
 *
 * Without this the app relearned the lesson on every generation: each set of
 * storylines, each briefing, each turn of a conversation bought the same 404
 * before buying the real answer.
 *
 * It is remembered against the key that was refused rather than against the
 * app, because a model unavailable on a new key may be fine on an older one —
 * and somebody who changes key to fix exactly this should not find the app
 * still refusing to try.
 */

const KEY = 'AIzaSyExampleKeyOne';
const OTHER = 'AIzaSyExampleKeyTwo';

describe('a model that was refused', () => {
  beforeEach(() => forgetUnusable('gemini'));

  it('is remembered', () => {
    expect(isUnusable('gemini', 'gemini-2.5-pro', KEY)).toBe(false);
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404 no longer available');
    expect(isUnusable('gemini', 'gemini-2.5-pro', KEY)).toBe(true);
  });

  it('is only refused for the key that was refused', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404');
    expect(isUnusable('gemini', 'gemini-2.5-pro', OTHER)).toBe(false);
  });

  it('does not condemn the other models', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404');
    expect(isUnusable('gemini', 'gemini-3-flash-preview', KEY)).toBe(false);
  });

  it('does not condemn the same name on another service', () => {
    markUnusable('gemini', 'shared-name', KEY, '404');
    expect(isUnusable('openai', 'shared-name', KEY)).toBe(false);
  });

  it('is listed for the picker to mark', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404');
    markUnusable('gemini', 'gemini-2.5-flash', KEY, '404');
    expect(unusableModels('gemini', KEY).sort()).toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
    expect(unusableModels('gemini', OTHER)).toEqual([]);
    expect(unusableModels('gemini', null)).toEqual([]);
  });

  it('is not recorded twice when it fails again', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, 'first');
    markUnusable('gemini', 'gemini-2.5-pro', KEY, 'second');
    expect(unusableModels('gemini', KEY)).toEqual(['gemini-2.5-pro']);
  });

  it('is forgotten when the key is replaced', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404');
    forgetUnusable('gemini');
    expect(isUnusable('gemini', 'gemini-2.5-pro', KEY)).toBe(false);
  });

  it('is on disk, so a restart does not buy the same 404 again', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404 no longer available');
    const stored = JSON.parse(
      readFileSync(join(process.env.OOTP_FO_DATA_DIR!, 'unusable-models.json'), 'utf8')
    );
    expect(stored.gemini).toHaveLength(1);
    expect(stored.gemini[0].model).toBe('gemini-2.5-pro');
    expect(stored.gemini[0].reason).toContain('404');
  });

  it('keeps no copy of the key itself, only enough to recognise it', () => {
    markUnusable('gemini', 'gemini-2.5-pro', KEY, '404');
    const raw = readFileSync(join(process.env.OOTP_FO_DATA_DIR!, 'unusable-models.json'), 'utf8');
    expect(raw).not.toContain(KEY);
  });
});
