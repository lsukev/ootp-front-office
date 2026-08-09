import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getApiKey } from './settings.js';

/**
 * The model catalogue behind the Settings picker.
 *
 * This is read from the Models API rather than hardcoded. A desktop build can
 * sit on a user's machine for months, and a baked-in list would slowly fill up
 * with models that no longer exist while missing every new one. The same call
 * reports each model's capabilities, which is how the chat path knows whether
 * it may send a thinking parameter — guessing that per model is exactly the
 * kind of thing that turns into a 400 on someone else's computer.
 */

export interface ModelChoice {
  id: string;
  name: string;
  /** Context window in tokens. */
  contextTokens: number | null;
  /** Whether `thinking: { type: 'adaptive' }` is accepted. Null when unknown. */
  adaptiveThinking: boolean | null;
}

/**
 * Used when there is no API key yet, or the lookup fails. Deliberately short:
 * it only has to keep the picker usable until a real list can be fetched.
 */
export const FALLBACK_MODELS: ModelChoice[] = [
  { id: 'claude-opus-5', name: 'Claude Opus 5', contextTokens: 1_000_000, adaptiveThinking: true },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextTokens: 1_000_000, adaptiveThinking: true },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextTokens: 200_000, adaptiveThinking: null },
];

export const DEFAULT_MODEL = 'claude-opus-5';

interface Cached {
  at: number;
  /** Identifies which key produced this list, so replacing the key refetches. */
  keyFingerprint: string;
  models: ModelChoice[];
  live: boolean;
}
let cache: Cached | null = null;
const TTL_MS = 15 * 60 * 1000;

const fingerprint = (key: string): string => `${key.length}:${key.slice(-6)}`;

/** Reads a nested capability flag without assuming the tree is fully populated. */
function capability(caps: unknown, path: string[]): boolean | null {
  let node: unknown = caps;
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return null;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'boolean' ? node : null;
}

export async function listModels(): Promise<{ models: ModelChoice[]; live: boolean }> {
  const key = getApiKey();
  if (!key) return { models: FALLBACK_MODELS, live: false };

  const fp = fingerprint(key);
  if (cache && cache.keyFingerprint === fp && Date.now() - cache.at < TTL_MS) {
    return { models: cache.models, live: cache.live };
  }

  try {
    const client = new Anthropic({ apiKey: key });
    const models: ModelChoice[] = [];
    // The page object auto-paginates when iterated
    for await (const m of client.models.list()) {
      const caps = (m as unknown as { capabilities?: unknown }).capabilities;
      models.push({
        id: m.id,
        name: m.display_name ?? m.id,
        contextTokens: (m as unknown as { max_input_tokens?: number }).max_input_tokens ?? null,
        adaptiveThinking: capability(caps, ['thinking', 'types', 'adaptive', 'supported']),
      });
    }
    if (models.length === 0) return { models: FALLBACK_MODELS, live: false };
    cache = { at: Date.now(), keyFingerprint: fp, models, live: true };
    return { models, live: true };
  } catch {
    // An expired key or an offline machine should degrade to a usable picker,
    // not an error page — the rest of Settings has nothing to do with the API
    return { models: FALLBACK_MODELS, live: false };
  }
}

/**
 * Null means "not known to support it", which the caller must treat as "do not
 * send the parameter". Omitting thinking is valid on every model; sending it to
 * one that does not accept it is a 400.
 */
export async function supportsAdaptiveThinking(modelId: string): Promise<boolean> {
  const { models } = await listModels();
  return models.find((m) => m.id === modelId)?.adaptiveThinking === true;
}

// ── Route ───────────────────────────────────────────────────────────────

export const modelRoutes = Router();

/** The model picker's options. `live` is false when this is the fallback list. */
modelRoutes.get('/models', async (_req, res) => {
  const { models, live } = await listModels();
  res.json({ models, live });
});
