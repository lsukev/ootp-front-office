import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { activeProvider, getApiKey } from './settings.js';
import { DEFAULT_MODEL, isProviderId, providerFor, type ProviderId } from './providers.js';

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
export const FALLBACK_MODELS: Record<ProviderId, ModelChoice[]> = {
  anthropic: [
    { id: 'claude-opus-5', name: 'Claude Opus 5', contextTokens: 1_000_000, adaptiveThinking: true },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', contextTokens: 1_000_000, adaptiveThinking: true },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', contextTokens: 200_000, adaptiveThinking: null },
  ],
  openai: [
    { id: 'gpt-5', name: 'gpt-5', contextTokens: null, adaptiveThinking: null },
    { id: 'gpt-5-mini', name: 'gpt-5-mini', contextTokens: null, adaptiveThinking: null },
  ],
  gemini: [
    { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', contextTokens: null, adaptiveThinking: null },
    { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', contextTokens: null, adaptiveThinking: null },
  ],
};

export { DEFAULT_MODEL };

interface Cached {
  at: number;
  /** Identifies which key produced this list, so replacing the key refetches. */
  keyFingerprint: string;
  models: ModelChoice[];
  live: boolean;
}
/** Cached per provider: switching back and forth should not refetch each time. */
const cache = new Map<ProviderId, Cached>();
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

export async function listModels(
  provider: ProviderId = activeProvider()
): Promise<{ models: ModelChoice[]; live: boolean }> {
  const fallback = FALLBACK_MODELS[provider];
  const key = getApiKey(provider);
  if (!key) return { models: fallback, live: false };

  const fp = fingerprint(key);
  const hit = cache.get(provider);
  if (hit && hit.keyFingerprint === fp && Date.now() - hit.at < TTL_MS) {
    return { models: hit.models, live: hit.live };
  }

  try {
    const models =
      provider === 'anthropic'
        ? await anthropicModels(key)
        : // The other two report no capability tree, so nothing is claimed
          // about thinking — the chat only sends that parameter to Anthropic
          (await providerFor(provider).listModels(key)).map((m) => ({
            id: m.id,
            name: m.label,
            contextTokens: null,
            adaptiveThinking: null,
          }));
    if (models.length === 0) return { models: fallback, live: false };
    cache.set(provider, { at: Date.now(), keyFingerprint: fp, models, live: true });
    return { models, live: true };
  } catch {
    // An expired key or an offline machine should degrade to a usable picker,
    // not an error page — the rest of Settings has nothing to do with the API
    return { models: fallback, live: false };
  }
}

/**
 * Anthropic's list, kept on its own SDK because it is the only one that
 * reports the capability tree the chat reads before sending a thinking
 * parameter — guessing that per model is what turns into a 400 on someone
 * else's computer.
 */
async function anthropicModels(key: string): Promise<ModelChoice[]> {
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
  return models;
}

/**
 * Null means "not known to support it", which the caller must treat as "do not
 * send the parameter". Omitting thinking is valid on every model; sending it to
 * one that does not accept it is a 400.
 */
export async function supportsAdaptiveThinking(modelId: string): Promise<boolean> {
  // Only Anthropic accepts the parameter at all
  if (activeProvider() !== 'anthropic') return false;
  const { models } = await listModels('anthropic');
  return models.find((m) => m.id === modelId)?.adaptiveThinking === true;
}

// ── Route ───────────────────────────────────────────────────────────────

export const modelRoutes = Router();

/** The model picker's options. `live` is false when this is the fallback list. */
modelRoutes.get('/models', async (req, res) => {
  const asked = req.query.provider;
  const provider = isProviderId(asked) ? asked : activeProvider();
  const { models, live } = await listModels(provider);
  res.json({ models, live, provider });
});
