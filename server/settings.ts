import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadConfig } from './config.js';
import {
  DEFAULT_MODEL, OLLAMA_DEFAULT_URL, PROVIDERS, isProviderId, providerFor, type ProviderId,
} from './providers.js';
import { forgetUnusable } from './unusable.js';
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
   * Which service the AI features talk to. Anthropic unless changed — it is
   * what the app was built against and the only one the chat's tool loop and
   * prompt caching are native to.
   */
  provider: ProviderId;
  /**
   * The model chosen for each provider, remembered separately. Switching
   * provider would otherwise leave a model id the new one has never heard of.
   */
  models: Partial<Record<ProviderId, string>>;
  /**
   * Write overall and potential in fives, the way scouts talk. Display only —
   * sorting and every calculation keep the exact grade.
   */
  roundRatingsToFive: boolean;
  /**
   * Keep pitchers on the injured list in the bullpen table.
   *
   * Off unless asked for. That page answers one question — who can throw
   * tonight — and a man six weeks from a rehab start is not an answer to it.
   * Nothing vanishes quietly: the heading says how many are being held back
   * and hands them over in a click.
   */
  showUnavailablePitchers: boolean;
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
  /**
   * Where Ollama is listening, for anyone running a model on their own machine.
   *
   * A setting rather than a constant because people run it on another port, or
   * on the big machine in the other room — and because a wrong address is the
   * first thing to check when nothing answers.
   */
  ollamaUrl: string;
}

const DEFAULTS: Settings = {
  provider: 'anthropic',
  models: {},
  autoImport: true,
  useTeamColors: true,
  nextSeasonBudget: {},
  roundRatingsToFive: false,
  showUnavailablePitchers: false,
  autoGenerateAfterImport: false,
  defaultOrgId: null,
  theme: 'system',
  model: 'claude-opus-5',
  ollamaUrl: OLLAMA_DEFAULT_URL,
};

/** Which service the AI features talk to. */
export function activeProvider(): ProviderId {
  const chosen: unknown = loadSettings().provider;
  return isProviderId(chosen) ? chosen : DEFAULTS.provider;
}

/**
 * The model every AI call site should use, for whichever provider is active.
 *
 * A hand-edited or truncated settings.json can put anything here, and every AI
 * feature would fail on it — fall back rather than throw. The legacy top-level
 * "model" is still honoured for Anthropic, so an existing choice survives.
 */
export function aiModel(provider: ProviderId = activeProvider()): string {
  const settings = loadSettings();
  const perProvider: unknown = settings.models?.[provider];
  if (typeof perProvider === 'string' && perProvider.trim()) return perProvider.trim();
  if (provider === 'anthropic') {
    const legacy: unknown = settings.model;
    if (typeof legacy === 'string' && legacy.trim()) return legacy.trim();
  }
  return DEFAULT_MODEL[provider];
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

/**
 * Where each provider's key lives.
 *
 * The file used to hold one key, from when there was only one provider. That
 * shape is still read and moved under "anthropic" the first time a key is
 * touched, so nobody has to re-enter a key they already saved.
 */
type KeyFile = Partial<Record<ProviderId, StoredKey>>;

/** The environment variable each provider honours, as its own SDK names it. */
const ENV_VAR: Record<ProviderId, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  // Kept for the shape's sake; nothing reads it, because a local server has
  // nobody to bill and asks for no credential
  ollama: 'OLLAMA_API_KEY',
};

/**
 * Providers that need no credential, because they run on your own machine.
 *
 * Every AI feature checks for a key before it will do anything, which is right
 * for a service that bills for the call and wrong for one that does not. The
 * placeholder below is what those checks see. It is not a credential, it is
 * never sent anywhere but to your own machine, and it exists so that eight
 * call sites did not have to learn about a fifth provider.
 */
export const needsNoKey = (provider: ProviderId): boolean => provider === 'ollama';
const LOCAL_PLACEHOLDER = 'ollama';

function readKeyFile(): KeyFile {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(KEY_PATH, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  // The old one-key file, recognised by having a value at the top level
  if ('value' in (raw as Record<string, unknown>)) return { anthropic: raw as StoredKey };
  return raw as KeyFile;
}

function writeKeyFile(next: KeyFile): void {
  fs.writeFileSync(KEY_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
}

export function saveApiKey(key: string, provider: ProviderId = 'anthropic'): void {
  const trimmed = key.trim();
  const active = activeCrypto();
  const record: StoredKey = active
    ? { encrypted: true, value: active.encrypt(trimmed), hint: trimmed.slice(-4) }
    : { encrypted: false, value: trimmed, hint: trimmed.slice(-4) };
  writeKeyFile({ ...readKeyFile(), [provider]: record });
}

export function clearApiKey(provider: ProviderId = 'anthropic'): void {
  const next = readKeyFile();
  delete next[provider];
  writeKeyFile(next);
}

function decrypt(stored: StoredKey): string | null {
  if (!stored.encrypted) return stored.value;
  try {
    const active = activeCrypto();
    return active ? active.decrypt(stored.value) : null;
  } catch {
    // Encrypted on another machine or by another user account
    return null;
  }
}

/**
 * The key a provider should use. An environment variable still wins, so anyone
 * already using a .env file keeps working exactly as before.
 */
export function getApiKey(provider: ProviderId = activeProvider()): string | null {
  if (needsNoKey(provider)) return LOCAL_PLACEHOLDER;
  const fromEnv = process.env[ENV_VAR[provider]];
  if (fromEnv) return fromEnv;
  const stored = readKeyFile()[provider];
  return stored ? decrypt(stored) : null;
}

export interface KeyStatus {
  configured: boolean;
  source: 'env' | 'stored' | null;
  hint: string | null;
  encrypted: boolean;
}

export function apiKeyStatus(provider: ProviderId = activeProvider()): KeyStatus & { storageLabel: string } {
  const storageLabel = crypto ? crypto.label : 'a permission-restricted file (no OS keychain available)';
  return { ...statusOf(provider), storageLabel };
}

function statusOf(provider: ProviderId): KeyStatus {
  // Nothing to configure, so the page has nothing to nag about
  if (needsNoKey(provider)) {
    return { configured: true, source: null, hint: null, encrypted: false };
  }
  const fromEnv = process.env[ENV_VAR[provider]];
  if (fromEnv) {
    return { configured: true, source: 'env', hint: fromEnv.slice(-4), encrypted: false };
  }
  const stored = readKeyFile()[provider];
  if (stored) {
    return { configured: true, source: 'stored', hint: stored.hint, encrypted: stored.encrypted };
  }
  return { configured: false, source: null, hint: null, encrypted: false };
}

/** Every provider's key state at once, for the Settings screen. */
export function allKeyStatus(): Record<ProviderId, KeyStatus> {
  return Object.fromEntries(PROVIDERS.map((p) => [p.id, statusOf(p.id)])) as Record<ProviderId, KeyStatus>;
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
  if (isProviderId(body.provider)) next.provider = body.provider;
  /*
   * The address of a local server. Only http(s) is accepted and only a plain
   * origin plus path — this is the one setting that decides where a prompt
   * carrying a whole save's data gets posted, so a hand-edited settings file
   * should not be able to point it at anything exotic.
   */
  if (typeof body.ollamaUrl === 'string') {
    const trimmed = body.ollamaUrl.trim();
    if (trimmed === '') {
      next.ollamaUrl = OLLAMA_DEFAULT_URL;
    } else {
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          next.ollamaUrl = trimmed.replace(/\/+$/, '');
        }
      } catch { /* leave the previous address in place */ }
    }
  }
  /*
   * Model ids are validated by shape only. The catalogue comes from the API and
   * grows over time, so refusing anything not on today's list would block a
   * model released after this build shipped — the API rejects a bad id anyway.
   *
   * The colon and the slash are here because local models carry them:
   * "llama3.1:8b" is the ordinary form of an Ollama id and
   * "hf.co/user/model" is how a pulled Hugging Face model is named. Without
   * them the save silently did nothing, the setting sprang back to empty, and
   * the request went out with no model at all.
   */
  const modelShape = /^[a-z0-9._:/-]{3,96}$/i;
  if (typeof body.model === 'string' && modelShape.test(body.model.trim())) {
    // Sent without a provider, this means "the one I am using"
    next.models = { ...next.models, [next.provider]: body.model.trim() };
    if (next.provider === 'anthropic') next.model = body.model.trim();
  }
  if (body.models && typeof body.models === 'object') {
    const models = { ...next.models };
    for (const [id, value] of Object.entries(body.models)) {
      if (isProviderId(id) && typeof value === 'string' && modelShape.test(value.trim())) {
        models[id] = value.trim();
      }
    }
    next.models = models;
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

/** Which key each provider expects, so a pasted one can be checked early. */
const KEY_SHAPE: Record<ProviderId, { test: RegExp; hint: string }> = {
  anthropic: { test: /^sk-ant-/, hint: 'Anthropic keys begin with "sk-ant-".' },
  openai: { test: /^sk-/, hint: 'OpenAI keys begin with "sk-".' },
  // Google's are a plain token with no prefix worth checking beyond length
  gemini: { test: /^.{20,}$/, hint: 'That looks too short for a Gemini key.' },
  // A local server reads no key, so anything at all passes and nothing is asked for
  ollama: { test: /^/, hint: '' },
  /*
   * Zen does not document a prefix, so nothing is asserted about one. A guess
   * here would reject a perfectly good key and the user would have no way to
   * tell it was this check rather than the service — and the key is validated
   * against the API a line later anyway, which is the test that matters.
   */
  opencode: { test: /^.{16,}$/, hint: 'That looks too short for an OpenCode Zen key.' },
};

/** Verifies a key against the API before saving, so a typo is caught here. */
settingsRoutes.post('/settings/api-key', async (req, res) => {
  const { key, provider: raw } = req.body as { key?: string; provider?: string };
  const provider: ProviderId = isProviderId(raw) ? raw : 'anthropic';
  if (!key?.trim()) return res.status(400).json({ ok: false, error: 'Enter a key first.' });
  const candidate = key.trim();
  const shape = KEY_SHAPE[provider];
  if (!shape.test.test(candidate)) {
    return res.status(400).json({ ok: false, error: `That does not look right — ${shape.hint}` });
  }
  try {
    // A models list is the cheapest call that proves the key works
    await providerFor(provider).validateKey(candidate);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 401 || e.status === 403) {
      return res.status(400).json({ ok: false, error: 'The API rejected that key. Check it and try again.' });
    }
    return res.status(400).json({ ok: false, error: `Could not verify the key: ${e.message}` });
  }
  saveApiKey(candidate, provider);
  // A new key may well be able to run what the old one refused, which is one
  // of the reasons somebody changes key in the first place
  forgetUnusable(provider);
  res.json({ ok: true, apiKey: apiKeyStatus(), keys: allKeyStatus() });
});

settingsRoutes.delete('/settings/api-key', (req, res) => {
  const raw = (req.query.provider ?? req.body?.provider) as string | undefined;
  clearApiKey(isProviderId(raw) ? raw : 'anthropic');
  res.json({ ok: true, apiKey: apiKeyStatus(), keys: allKeyStatus() });
});

/** The choice on offer, so the Settings screen does not hard-code the list. */
settingsRoutes.get('/settings/providers', (_req, res) => {
  res.json({
    // Each provider's resolved model travels with it, so a provider that has
    // never been chosen still shows what it would use rather than a blank
    providers: PROVIDERS.map((p) => ({ ...p, model: aiModel(p.id) })),
    keys: allKeyStatus(),
  });
});
