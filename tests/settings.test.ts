import { describe, expect, it } from 'vitest';
import request, { post } from './request.js';

/**
 * Saving a setting, which sounds too simple to be worth a test.
 *
 * It is here because it was not. The handler copied fields across by hand, and
 * the two switches added later were never added to it: the request answered
 * 200, the switch moved, and nothing was written — so the preference came back
 * off at the next launch. The shipped rounding toggle had this fault for four
 * releases. Every boolean is checked here rather than the two that were
 * missed, so the next one added cannot be forgotten quietly.
 */

const booleans = async (): Promise<string[]> => {
  const { settings } = await request('/api/settings');
  return Object.keys(settings).filter((k) => typeof settings[k] === 'boolean');
};

describe('POST /settings', () => {
  it('has switches to save', async () => {
    expect((await booleans()).length).toBeGreaterThan(0);
  });

  it('writes every switch, and reads it back the same', async () => {
    for (const field of await booleans()) {
      const before = (await request('/api/settings')).settings[field] as boolean;

      const flipped = (await post('/api/settings', { [field]: !before })).settings[field];
      expect(flipped, `${field} came back unchanged from the save`).toBe(!before);

      const reread = (await request('/api/settings')).settings[field];
      expect(reread, `${field} did not survive being read again`).toBe(!before);

      await post('/api/settings', { [field]: before });
    }
  });

  it('leaves a switch alone when the request does not mention it', async () => {
    const before = (await request('/api/settings')).settings;
    const after = (await post('/api/settings', { theme: before.theme })).settings;
    for (const field of await booleans()) expect(after[field]).toBe(before[field]);
  });
});
