import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import type { ProviderId } from './providers.js';

/**
 * Models the service lists but will not run.
 *
 * Google's catalogue is not a list of models you may call — gemini-2.5-pro and
 * gemini-2.5-flash are both offered by it and both answer a real request with
 * 404 on a newer key. The app already recovers by asking a model that works,
 * but it was learning that lesson afresh every time: each set of storylines,
 * each briefing, each turn of a conversation paid for the doomed request first
 * and then paid again for the real one.
 *
 * So the refusal is remembered. It is written to disk rather than kept in
 * memory because the fact does not stop being true when the app is closed, and
 * a wasted call at every launch is the same waste on a slower schedule.
 *
 * Remembered against the key that was refused, not against the app. A model
 * unavailable on a new key may be perfectly available on an older one, and
 * somebody who changes keys to fix exactly this should not find the app still
 * refusing to try.
 */

export interface Unusable {
  model: string;
  /** Which key was refused, so another key starts with a clean slate. */
  keyFingerprint: string;
  reason: string;
  notedAt: string;
}

type Store = Partial<Record<ProviderId, Unusable[]>>;

const STORE_PATH = path.join(DATA_DIR, 'unusable-models.json');

/** Identifies a key without storing it. Matches the model cache's scheme. */
export const fingerprint = (key: string): string => `${key.length}:${key.slice(-6)}`;

function read(): Store {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {};
  } catch {
    return {};
  }
}

function write(store: Store): void {
  try {
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch {
    // Losing this only costs a repeated wasted call, which is what the app did
    // before it existed — never worth failing a generation over
  }
}

export function markUnusable(
  provider: ProviderId,
  model: string,
  key: string,
  reason: string
): void {
  const store = read();
  const fp = fingerprint(key);
  const existing = (store[provider] ?? []).filter(
    (u) => !(u.model === model && u.keyFingerprint === fp)
  );
  existing.push({ model, keyFingerprint: fp, reason, notedAt: new Date().toISOString() });
  store[provider] = existing;
  write(store);
}

export function isUnusable(provider: ProviderId, model: string, key: string): boolean {
  const fp = fingerprint(key);
  return (read()[provider] ?? []).some((u) => u.model === model && u.keyFingerprint === fp);
}

/** Every model refused on the key currently in use, for the Settings picker. */
export function unusableModels(provider: ProviderId, key: string | null): string[] {
  if (!key) return [];
  const fp = fingerprint(key);
  return (read()[provider] ?? []).filter((u) => u.keyFingerprint === fp).map((u) => u.model);
}

/**
 * Forgets everything recorded for a provider.
 *
 * Called when its key is replaced. The entries are already scoped to a
 * fingerprint so a stale one would never match, but leaving them to accumulate
 * against keys nobody holds any more serves no purpose.
 */
export function forgetUnusable(provider: ProviderId): void {
  const store = read();
  delete store[provider];
  write(store);
}
