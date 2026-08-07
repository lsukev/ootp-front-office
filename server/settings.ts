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
}

const DEFAULTS: Settings = { autoImport: true, useTeamColors: true, defaultOrgId: null };

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
  encrypt(plain: string): string;
  decrypt(cipher: string): string;
  label: string;
}
let crypto: SecretCrypto | null = null;

/** Called by the Electron main process at startup with safeStorage. */
export function setSecretCrypto(impl: SecretCrypto): void {
  crypto = impl;
}

interface StoredKey {
  encrypted: boolean;
  value: string;
  /** Last four characters, so the UI can show which key is saved. */
  hint: string;
}

export function saveApiKey(key: string): void {
  const trimmed = key.trim();
  const record: StoredKey = crypto
    ? { encrypted: true, value: crypto.encrypt(trimmed), hint: trimmed.slice(-4) }
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
    return crypto ? crypto.decrypt(stored.value) : null;
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

settingsRoutes.post('/settings', (req, res) => {
  const body = req.body as Partial<Settings>;
  const previous = loadSettings();
  const next: Settings = { ...previous };
  if (typeof body.autoImport === 'boolean') next.autoImport = body.autoImport;
  if (typeof body.useTeamColors === 'boolean') next.useTeamColors = body.useTeamColors;
  if (body.defaultOrgId === null || typeof body.defaultOrgId === 'number') {
    next.defaultOrgId = body.defaultOrgId;
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
