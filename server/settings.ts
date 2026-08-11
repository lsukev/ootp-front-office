import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { DATA_DIR, loadConfig } from './config.js';
import { startWatcher, stopWatcher } from './watcher.js';

/**
 * User preferences, plus the Anthropic API key.
 *
 * The key is a real secret, so it is never written in plain text when we can
 * avoid it: the desktop app hands us Electron's safeStorage, which encrypts
 * against the OS keychain (Keychain on macOS, DPAPI on Windows). Running from
 * source in a browser there is no keychain available, so the key falls back to
 * a 0600 file and the UI says so plainly rather than implying it is protected.
 */

export interface Settings {
  autoImport: boolean;
  useTeamColors: boolean;
  defaultOrgId: number | null;
  /** 'system' follows the OS setting and changes with it. */
  theme: 'system' | 'dark' | 'light';
  /** Model id used by every AI feature. See models.ts for the picker's list. */
  model: string;
  /**
   * Write overall and potential in fives, the way scouts talk. Display only —
   * sorting and every calculation keep the exact grade.
   */
  roundRatingsToFive: boolean;
  /**
   * Write the storylines and the briefing by themselves after each import.
   *
   * Off unless asked for. Both cost money on someone else's API key, and a
   * setting that quietly spends it would be a poor default however convenient.
   */
  autoGenerateAfterImport: boolean;
  /**
   * What you expect the owner to hand you next season, per club, in dollars.
   *
   * OOTP does not publish a future budget — it is not set until the offseason —
   * so future headroom had to assume this year's holds flat. On a club whose
   * budget swings, that is the wrong number to plan against, and you are the
   * one who knows which way the owner leans. Absent an entry, flat it stays.
   */
  nextSeasonBudget: Record<string, number>;
}

const DEFAULTS: Settings = {
  autoImport: true,
  useTeamColors: true,
  nextSeasonBudget: {},
  roundRatingsToFive: false,
  autoGenerateAfterImport: false,
  defaultOrgId: null,
  theme: 'system',
  model: 'claude-opus-5',
};

/** The model every AI call site should use. */
export function aiModel(): string {
  // A hand-edited or truncated settings.json can put anything here, and every
  // AI feature would fail on it — fall back rather than throw.
  const chosen: unknown = loadSettings().model;
  return (typeof chosen === 'string' && chosen.trim()) || DEFAULTS.model;
}

const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const KEY_PATH = path.join(DATA_DIR, 'credentials.json');

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(next: Settings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
}

// ── Secret storage ──────────────────────────────────────────────────────

interface SecretCrypto {
  /**
   * Whether OS-backed encryption works. On macOS this reaches into the
   * Keychain, which can raise a password prompt — so it must only be called
   * when a secret is actually being written or read, never on startup.
   */
  available(): boolean;
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  label: string;
}
let crypto: SecretCrypto | null = null;

/** Called by the Electron main process at startup with safeStorage. */
export function setSecretCrypto(impl: SecretCrypto): void {
  crypto = impl;
}

/** Resolves the crypto only when there is a secret to protect. */
function activeCrypto(): SecretCrypto | null {
  if (!crypto) return null;
  try {
    return crypto.available() ? crypto : null;
  } catch {
    return null;
  }
}

interface StoredKey {
  encrypted: boolean;
  value: string;
  /** Last four characters, so the UI can show which key is saved. */
  hint: string;
}

export function saveApiKey(key: string): void {
  const trimmed = key.trim();
  const active = activeCrypto();
  const record: StoredKey = active
    ? { encrypted: true, value: active.encrypt(trimmed), hint: trimmed.slice(-4) }
    : { encrypted: false, value: trimmed, hint: trimmed.slice(-4) };
  fs.writeFileSync(KEY_PATH, JSON.stringify(record, null, 2), { mode: 0o600 });
}

export function clearApiKey(): void {
  try {
    fs.unlinkSync(KEY_PATH);
  } catch {
    // nothing stored
  }
}

function readStoredKey(): StoredKey | null {
  try {
    return JSON.parse(fs.readFileSync(KEY_PATH, 'utf8')) as StoredKey;
  } catch {
    return null;
  }
}

/**
 * The key the AI features should use. An environment variable still wins, so
 * anyone already using a .env file keeps working exactly as before.
 */
export function getApiKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  const stored = readStoredKey();
  if (!stored) return null;
  if (!stored.encrypted) return stored.value;
  try {
    const active = activeCrypto();
    return active ? active.decrypt(stored.value) : null;
  } catch {
    // Encrypted on another machine or by another user account
    return null;
  }
}

export function apiKeyStatus(): {
  configured: boolean;
  source: 'env' | 'stored' | null;
  hint: string | null;
  encrypted: boolean;
  storageLabel: string;
} {
  const stored = readStoredKey();
  const storageLabel = crypto ? crypto.label : 'a permission-restricted file (no OS keychain available)';
  if (process.env.ANTHROPIC_API_KEY) {
    return {
      configured: true,
      source: 'env',
      hint: process.env.ANTHROPIC_API_KEY.slice(-4),
      encrypted: false,
      storageLabel,
    };
  }
  if (stored) {
    return { configured: true, source: 'stored', hint: stored.hint, encrypted: stored.encrypted, storageLabel };
  }
  return { configured: false, source: null, hint: null, encrypted: false, storageLabel };
}

// ── Routes ──────────────────────────────────────────────────────────────

export const settingsRoutes = Router();

settingsRoutes.get('/settings', (_req, res) => {
  res.json({ settings: loadSettings(), apiKey: apiKeyStatus(), dataDir: DATA_DIR });
});

/**
 * The budget you expect next season for one club. Zero or null clears it and
 * returns that club to assuming this year's budget holds flat.
 */
settingsRoutes.put('/next-season-budget/:orgId', (req, res) => {
  const orgId = String(Number(req.params.orgId));
  const raw = (req.body as { amount?: unknown }).amount;
  const amount = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  const current = loadSettings();
  const next = { ...current.nextSeasonBudget };
  if (amount === null) delete next[orgId];
  else next[orgId] = amount;
  writeSettings({ ...current, nextSeasonBudget: next });
  res.json({ ok: true, nextSeasonBudget: amount });
});

settingsRoutes.post('/settings', (req, res) => {
  const body = req.body as Partial<Settings>;
  const previous = loadSettings();
  const next: Settings = { ...previous };
  /*
   * Every boolean setting, taken from the defaults rather than listed here.
   *
   * They used to be copied across one line at a time, and the two toggles
   * added after that was written were simply left out — the request answered
   * 200, the switch stayed on until the page was reloaded, and the setting was
   * never written at all. Reading the names from DEFAULTS means a new toggle
   * is saved the moment it is declared.
   */
  for (const field of Object.keys(DEFAULTS) as Array<keyof Settings>) {
    if (typeof DEFAULTS[field] === 'boolean' && typeof body[field] === 'boolean') {
      (next[field] as boolean) = body[field] as boolean;
    }
  }
  if (body.defaultOrgId === null || typeof body.defaultOrgId === 'number') {
    next.defaultOrgId = body.defaultOrgId;
  }
  if (body.theme === 'system' || body.theme === 'dark' || body.theme === 'light') {
    next.theme = body.theme;
  }
  // Model ids are validated by shape only. The catalogue comes from the API and
  // grows over time, so refusing anything not on today's list would block a
  // model released after this build shipped — the API rejects a bad id anyway.
  if (typeof body.model === 'string' && /^[a-z0-9.\-]{3,64}$/i.test(body.model.trim())) {
    next.model = body.model.trim();
  }
  writeSettings(next);

  // Take the auto-import toggle into effect immediately, not on next launch
  if (next.autoImport !== previous.autoImport) {
    const { csvDir } = loadConfig();
    if (next.autoImport && csvDir) startWatcher(csvDir);
    else if (!next.autoImport) stopWatcher();
  }
  res.json({ ok: true, settings: next });
});

/** Verifies a key against the API before saving, so a typo is caught here. */
settingsRoutes.post('/settings/api-key', async (req, res) => {
  const { key } = req.body as { key?: string };
  if (!key?.trim()) return res.status(400).json({ ok: false, error: 'Enter a key first.' });
  const candidate = key.trim();
  if (!candidate.startsWith('sk-ant-')) {
    return res.status(400).json({
      ok: false,
      error: 'That does not look like an Anthropic key — they begin with "sk-ant-".',
    });
  }
  try {
    // A models list is the cheapest call that proves the key works
    await new Anthropic({ apiKey: candidate }).models.list({ limit: 1 });
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 401) {
      return res.status(400).json({ ok: false, error: 'The API rejected that key. Check it and try again.' });
    }
    return res.status(400).json({ ok: false, error: `Could not verify the key: ${e.message}` });
  }
  saveApiKey(candidate);
  res.json({ ok: true, apiKey: apiKeyStatus() });
});

settingsRoutes.delete('/settings/api-key', (_req, res) => {
  clearApiKey();
  res.json({ ok: true, apiKey: apiKeyStatus() });
});
