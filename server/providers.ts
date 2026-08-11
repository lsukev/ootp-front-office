import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { isUnusable, markUnusable } from './unusable.js';

/**
 * Three ways to reach a model, behind one shape.
 *
 * The app was written against Anthropic and every feature still works best
 * there — the chat's tool loop and prompt caching are Anthropic's shapes, and
 * this is where they stay. What this adds is a choice for anyone who already
 * pays for a key somewhere else, which is most of the reason people asked.
 *
 * Only the parts that genuinely differ are adapted. A system prompt is a
 * separate argument at Anthropic, the first message at OpenAI, and its own
 * field at Google; a refusal is a stop reason, a field on the message, and a
 * finish reason respectively. Those are normalised here so the four call sites
 * upstream never learn which provider answered.
 */

export type ProviderId = 'anthropic' | 'openai' | 'gemini';

export const PROVIDERS: Array<{ id: ProviderId; label: string; keyLabel: string; console: string }> = [
  { id: 'anthropic', label: 'Anthropic (Claude)', keyLabel: 'Anthropic API key', console: 'console.claude.com' },
  { id: 'openai', label: 'OpenAI', keyLabel: 'OpenAI API key', console: 'platform.openai.com' },
  { id: 'gemini', label: 'Google Gemini', keyLabel: 'Gemini API key', console: 'aistudio.google.com' },
];

export const isProviderId = (v: unknown): v is ProviderId =>
  PROVIDERS.some((p) => p.id === v);

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** Enough of a JSON Schema for the shapes this app asks for. */
export type JsonSchema = { [key: string]: unknown };

export interface CompleteOpts {
  key: string;
  model: string;
  system: string;
  messages: Turn[];
  maxTokens: number;
  /** A JSON schema, when the answer has to parse. */
  schema?: JsonSchema;
  /** Told when the chosen model could not be used and another answered. */
  onFallback?: (notice: FallbackNotice) => void;
}

/**
 * What the page needs to explain a swap and undo it in one click.
 *
 * The message alone was a chore handed to the reader — "pick a model that
 * works in Settings" is a job, not an answer. With the two model ids the page
 * can offer the switch itself.
 */
export interface FallbackNotice {
  message: string;
  from: string;
  to: string;
  provider: ProviderId;
}

export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * A refusal, told apart from a failure.
 *
 * Storylines has to distinguish these: a model declining to write about a
 * simulated season is worth a different message than a network error, and the
 * two arrive by completely different routes on each provider.
 */
export class RefusalError extends Error {
  constructor(model: string) {
    super(
      `${model} declined this request. It describes a simulated season, so this is usually the ` +
      'model being cautious rather than anything wrong with your save — trying again, or ' +
      'choosing a different model in Settings, normally clears it.'
    );
    this.name = 'RefusalError';
  }
}

/** Ran out of room before finishing, which is recoverable by asking again. */
export class TruncatedError extends Error {
  constructor() {
    super('Generation ran out of tokens — try again.');
    this.name = 'TruncatedError';
  }
}

export interface Provider {
  complete(opts: CompleteOpts): Promise<string>;
  listModels(key: string): Promise<ModelChoice[]>;
  validateKey(key: string): Promise<void>;
}

// ── Anthropic ───────────────────────────────────────────────────────────

const anthropic: Provider = {
  async complete({ key, model, system, messages, maxTokens, schema }) {
    const client = new Anthropic({ apiKey: key });
    const response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      system,
      messages,
      ...(schema ? { output_config: { format: { type: 'json_schema' as const, schema } } } : {}),
    });
    if (response.stop_reason === 'refusal') throw new RefusalError(model);
    if (response.stop_reason === 'max_tokens') throw new TruncatedError();
    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('Empty response from model');
    return text.text;
  },

  async listModels(key) {
    const client = new Anthropic({ apiKey: key });
    const out: ModelChoice[] = [];
    for await (const m of client.models.list()) {
      out.push({ id: m.id, label: m.display_name ?? m.id });
    }
    return out;
  },

  async validateKey(key) {
    await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
  },
};

// ── OpenAI ──────────────────────────────────────────────────────────────

const openai: Provider = {
  async complete({ key, model, system, messages, maxTokens, schema }) {
    const client = new OpenAI({ apiKey: key });
    const response = await client.chat.completions.create({
      model,
      // Newer models reject max_tokens; max_completion_tokens is the current
      // name and is accepted by everything still worth choosing
      max_completion_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
      ...(schema
        ? {
            response_format: {
              type: 'json_schema' as const,
              // strict mode is what actually holds it to the schema, and it
              // requires the schema to forbid extra properties
              json_schema: { name: 'response', strict: true, schema: strictSchema(schema) },
            },
          }
        : {}),
    });
    const choice = response.choices[0];
    if (choice?.message?.refusal) throw new RefusalError(model);
    if (choice?.finish_reason === 'length') throw new TruncatedError();
    const text = choice?.message?.content;
    if (!text) throw new Error('Empty response from model');
    return text;
  },

  async listModels(key) {
    const client = new OpenAI({ apiKey: key });
    const out: ModelChoice[] = [];
    for await (const m of client.models.list()) out.push({ id: m.id, label: m.id });
    // The account's list includes embeddings, audio and image models, none of
    // which can hold a conversation about a baseball club
    return out.filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id) && !/audio|realtime|image|tts|transcribe|search|embedding|moderation/.test(m.id));
  },

  async validateKey(key) {
    await new OpenAI({ apiKey: key }).models.list();
  },
};

/**
 * OpenAI's strict structured outputs will not accept a schema unless every
 * object forbids extra properties and marks every property required. Ours are
 * written for Anthropic, which asks for neither, so they are adjusted on the
 * way out rather than written twice.
 */
export function strictSchema(schema: JsonSchema): JsonSchema {
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const obj = { ...(node as Record<string, unknown>) };
    for (const [k, v] of Object.entries(obj)) obj[k] = walk(v);
    if (obj.type === 'object' && obj.properties && typeof obj.properties === 'object') {
      obj.additionalProperties = false;
      obj.required = Object.keys(obj.properties as Record<string, unknown>);
    }
    return obj;
  };
  return walk(schema) as JsonSchema;
}

// ── Google Gemini ───────────────────────────────────────────────────────

/**
 * The model to fall back to when the chosen one cannot be called.
 *
 * Google's models endpoint is not a list of models you may use: gemini-2.5-pro
 * and gemini-2.5-flash are both returned by it and both answer a real request
 * with 404, "no longer available to new users". So the picker will offer
 * choices that fail, and there is no way to tell which from the list alone.
 * Rather than hand that 404 to someone who only wanted their storylines, the
 * request is made again on a model known to answer, and they are told it
 * happened so they can choose differently.
 */
export const GEMINI_FALLBACK = 'gemini-3-flash-preview';

/**
 * A model that cannot be called at all, as against a request that went wrong.
 *
 * The line matters both ways. Retrying a rate limit or an empty balance on a
 * different model spends money and fixes nothing; failing to spot a dead model
 * hands somebody a 404 instead of their storylines.
 *
 * Matched on the status code and on what Google actually says, rather than on
 * the digits 404 appearing somewhere in the text — an unrelated failure, or a
 * tool result quoted back inside an error, should not trigger a model swap.
 */
export function modelUnavailable(err: unknown): boolean {
  const e = err as { status?: number; code?: number; message?: string };
  const message = e?.message ?? '';
  if (e?.status === 404 || e?.code === 404) return true;
  // Google returns its status in the body rather than on the error object
  if (/"code"\s*:\s*404|"status"\s*:\s*"NOT_FOUND"/.test(message)) return true;
  return /no longer available|is not supported|does not exist|model not found/i.test(message);
}

function fallbackNotice(from: string, to: string): FallbackNotice {
  return {
    from,
    to,
    provider: 'gemini',
    message:
      `${from} could not be used on your key — Google lists it but rejects it, which happens ` +
      `with the older Gemini models on newer keys. This ran on ${to} instead.`,
  };
}

const gemini: Provider = {
  async complete(opts) {
    // Already known to be refused on this key: go straight to one that answers
    // rather than buy the same 404 again
    if (known(opts.model, opts.key)) {
      opts.onFallback?.(fallbackNotice(opts.model, GEMINI_FALLBACK));
      return geminiComplete(opts, GEMINI_FALLBACK);
    }
    try {
      return await geminiComplete(opts, opts.model);
    } catch (err) {
      if (!modelUnavailable(err) || opts.model === GEMINI_FALLBACK) throw err;
      remember(opts.model, opts.key, err);
      opts.onFallback?.(fallbackNotice(opts.model, GEMINI_FALLBACK));
      return geminiComplete(opts, GEMINI_FALLBACK);
    }
  },
  async listModels(key) {
    const client = new GoogleGenAI({ apiKey: key });
    const out: ModelChoice[] = [];
    for await (const m of await client.models.list()) {
      const id = (m.name ?? '').replace(/^models\//, '');
      // Only the ones that can answer a prompt at all
      if (!id || !m.supportedActions?.includes('generateContent')) continue;
      out.push({ id, label: m.displayName ?? id });
    }
    return out;
  },

  async validateKey(key) {
    await new GoogleGenAI({ apiKey: key }).models.list();
  },
};

async function geminiComplete(
  { key, system, messages, maxTokens, schema }: CompleteOpts,
  model: string
): Promise<string> {
    const client = new GoogleGenAI({ apiKey: key });
    const response = await client.models.generateContent({
      model,
      contents: messages.map((m) => ({
        // Google calls the assistant "model"; the two roles are otherwise ours
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      config: {
        systemInstruction: system,
        maxOutputTokens: maxTokens,
        ...(schema
          ? { responseMimeType: 'application/json', responseJsonSchema: schema }
          : {}),
      },
    });
    const finish = response.candidates?.[0]?.finishReason;
    // SAFETY, RECITATION and friends are all "it declined"; STOP is a finish
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') throw new RefusalError(model);
    if (finish === 'MAX_TOKENS') throw new TruncatedError();
    const text = response.text;
    if (!text) throw new Error('Empty response from model');
    return text;
}

const IMPLEMENTATIONS: Record<ProviderId, Provider> = { anthropic, openai, gemini };

export const providerFor = (id: ProviderId): Provider => IMPLEMENTATIONS[id];

/**
 * The model each provider starts on, used until one is picked in Settings.
 * Deliberately the mid-tier of each: the briefing and storylines are long
 * enough that the flagship model is a real cost on someone else's key.
 */
export const DEFAULT_MODEL: Record<ProviderId, string> = {
  anthropic: 'claude-sonnet-5',
  openai: 'gpt-5',
  gemini: 'gemini-2.5-pro',
};

// ── The tool loop, for providers that are not Anthropic ─────────────────

/**
 * The staff chat, on OpenAI or Gemini.
 *
 * Anthropic's message shape stays the canonical one throughout the app: it is
 * the richest of the three, it is what the stored transcripts on disk are
 * written in, and leaving that path untouched means choosing another provider
 * cannot regress the one most people use. What happens here is translation at
 * the boundary — the conversation goes out in the other service's shape and
 * whatever comes back is turned into Anthropic blocks before it is stored, so
 * a transcript is readable whichever provider produced it.
 *
 * Prompt caching and the thinking parameter are deliberately not reproduced.
 * Anthropic's cache is explicit and the others' are automatic or absent, and a
 * thinking parameter sent where it is not supported is a 400 rather than a
 * degradation.
 */
export interface ToolLoopOpts {
  key: string;
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  onText: (delta: string) => void;
  onTool: (name: string) => void;
  runTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  maxTurns: number;
  /** Told when the chosen model could not be used and another answered. */
  onFallback?: (notice: FallbackNotice) => void;
}

export interface ToolLoopResult {
  answer: string;
  refused: boolean;
}

/** Text out of an Anthropic content block list, ignoring everything else. */
function textOf(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

const blocksOf = (m: Anthropic.MessageParam): Anthropic.ContentBlockParam[] =>
  typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;

// ── OpenAI ──────────────────────────────────────────────────────────────

export function toOpenAiMessages(
  system: string,
  messages: Anthropic.MessageParam[]
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    const blocks = blocksOf(m);
    const toolUses = blocks.filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use');
    const toolResults = blocks.filter(
      (b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result'
    );
    const text = textOf(m.content);

    if (m.role === 'assistant') {
      // An assistant turn carries its text and its tool calls together
      out.push({
        role: 'assistant',
        content: text || null,
        ...(toolUses.length > 0
          ? {
              tool_calls: toolUses.map((u) => ({
                id: u.id,
                type: 'function' as const,
                function: { name: u.name, arguments: JSON.stringify(u.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }
    // Tool results are their own messages here, not part of the user turn
    for (const r of toolResults) {
      out.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : JSON.stringify(r.content),
      });
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

async function openAiToolLoop(o: ToolLoopOpts): Promise<ToolLoopResult> {
  const client = new OpenAI({ apiKey: o.key });
  let answer = '';

  for (let turn = 0; turn < o.maxTurns; turn++) {
    const stream = await client.chat.completions.create({
      model: o.model,
      stream: true,
      messages: toOpenAiMessages(o.system, o.messages),
      tools: o.tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description ?? '',
          parameters: t.input_schema as Record<string, unknown>,
        },
      })),
    });

    // Tool calls arrive in fragments identified by index, not by id
    const calls = new Map<number, { id: string; name: string; args: string }>();
    let refusal = false;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta;
      if (delta?.content) {
        answer += delta.content;
        o.onText(delta.content);
      }
      if ((delta as { refusal?: string } | undefined)?.refusal) refusal = true;
      for (const tc of delta?.tool_calls ?? []) {
        const slot = calls.get(tc.index) ?? { id: '', name: '', args: '' };
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = tc.function.name;
        if (tc.function?.arguments) slot.args += tc.function.arguments;
        calls.set(tc.index, slot);
      }
    }
    if (refusal) return { answer, refused: true };
    if (calls.size === 0) break;

    const uses = [...calls.values()].filter((c) => c.name);
    o.messages.push({
      role: 'assistant',
      content: [
        ...(answer ? [{ type: 'text' as const, text: answer }] : []),
        ...uses.map((c) => ({
          type: 'tool_use' as const,
          id: c.id,
          name: c.name,
          input: safeArgs(c.args),
        })),
      ],
    });
    o.messages.push({ role: 'user', content: await runAll(o, uses.map((c) => ({ id: c.id, name: c.name, input: safeArgs(c.args) }))) });
    // Each turn's text is streamed as it arrives, so the accumulated answer
    // must not be replayed into the next turn's assistant block
    answer = '';
  }
  return { answer, refused: false };
}

/** Arguments arrive as a JSON string that a truncated stream can cut short. */
function safeArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Runs every tool call from one turn, in the shape the transcript stores. */
async function runAll(
  o: ToolLoopOpts,
  uses: Array<{ id: string; name: string; input: Record<string, unknown> }>
): Promise<Anthropic.ToolResultBlockParam[]> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  for (const use of uses) {
    o.onTool(use.name);
    try {
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: await o.runTool(use.name, use.input),
      });
    } catch (err) {
      results.push({
        type: 'tool_result',
        tool_use_id: use.id,
        content: err instanceof Error ? err.message : String(err),
        is_error: true,
      });
    }
  }
  return results;
}

// ── Gemini ──────────────────────────────────────────────────────────────

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args: Record<string, unknown> };
  functionResponse?: { name: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

/**
 * Where a Gemini thought signature is kept between turns.
 *
 * Gemini 3 will not accept a function call handed back to it without the
 * opaque signature it issued alongside — the second turn of every tool call
 * fails with a 400 otherwise, which is exactly how this was found. The
 * signature has nowhere to live in Anthropic's block, so it rides along under
 * a namespaced key and is stripped again before the transcript is sent
 * anywhere that would reject an unknown field.
 */
const SIGNATURE_KEY = '_geminiThoughtSignature';

type SignedToolUse = Anthropic.ToolUseBlockParam & { [SIGNATURE_KEY]?: string };

/**
 * Removes anything added for one provider's benefit.
 *
 * Called before the transcript goes to Anthropic, which rejects unknown fields
 * on a content block outright — and a conversation started on Gemini and
 * continued on Anthropic is one switch of a dropdown away.
 */
export function stripProviderExtras(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') delete (b as SignedToolUse)[SIGNATURE_KEY];
    }
  }
}

export function toGeminiContents(messages: Anthropic.MessageParam[]): Array<{ role: string; parts: GeminiPart[] }> {
  const out: Array<{ role: string; parts: GeminiPart[] }> = [];
  // A function response has to name the function, which only the call knows
  const nameById = new Map<string, string>();

  for (const m of messages) {
    const parts: GeminiPart[] = [];
    for (const b of blocksOf(m)) {
      if (b.type === 'text' && b.text) parts.push({ text: b.text });
      else if (b.type === 'tool_use') {
        nameById.set(b.id, b.name);
        const signature = (b as SignedToolUse)[SIGNATURE_KEY];
        parts.push({
          functionCall: { name: b.name, args: (b.input ?? {}) as Record<string, unknown> },
          ...(signature ? { thoughtSignature: signature } : {}),
        });
      } else if (b.type === 'tool_result') {
        const content = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
        parts.push({
          functionResponse: {
            name: nameById.get(b.tool_use_id) ?? 'tool',
            // Google wants an object here, and ours are plain text
            response: { result: content },
          },
        });
      }
    }
    if (parts.length > 0) out.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  return out;
}

async function geminiToolLoop(o: ToolLoopOpts): Promise<ToolLoopResult> {
  if (known(o.model, o.key)) {
    o.onFallback?.(fallbackNotice(o.model, GEMINI_FALLBACK));
    return geminiLoop(o, GEMINI_FALLBACK);
  }
  try {
    return await geminiLoop(o, o.model);
  } catch (err) {
    if (!modelUnavailable(err) || o.model === GEMINI_FALLBACK) throw err;
    remember(o.model, o.key, err);
    o.onFallback?.(fallbackNotice(o.model, GEMINI_FALLBACK));
    return geminiLoop(o, GEMINI_FALLBACK);
  }
}

const known = (model: string, key: string): boolean => isUnusable('gemini', model, key);

function remember(model: string, key: string, err: unknown): void {
  const reason = (err as { message?: string })?.message ?? 'refused by the API';
  console.warn(`[gemini] ${model} unavailable, using ${GEMINI_FALLBACK} from now on`);
  markUnusable('gemini', model, key, reason.slice(0, 300));
}

async function geminiLoop(o: ToolLoopOpts, model: string): Promise<ToolLoopResult> {
  const client = new GoogleGenAI({ apiKey: o.key });
  let answer = '';

  for (let turn = 0; turn < o.maxTurns; turn++) {
    const stream = await client.models.generateContentStream({
      model,
      contents: toGeminiContents(o.messages),
      config: {
        systemInstruction: o.system,
        tools: [
          {
            functionDeclarations: o.tools.map((t) => ({
              name: t.name,
              description: t.description ?? '',
              // Takes our schemas unchanged, unlike the OpenAPI-shaped
              // `parameters` field beside it
              parametersJsonSchema: t.input_schema,
            })),
          },
        ],
      },
    });

    const uses: Array<{ id: string; name: string; input: Record<string, unknown>; signature?: string }> = [];
    let refused = false;
    let calls = 0;
    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        answer += text;
        o.onText(text);
      }
      /*
       * Read from the raw parts rather than the chunk's functionCalls helper.
       * The signature is a property of the part, not of the call inside it, so
       * the convenience accessor cannot see it — and without it the next turn
       * is rejected.
       */
      for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
        const fc = part.functionCall;
        if (!fc?.name) continue;
        uses.push({
          // Google does not issue call ids, and the transcript needs one
          id: fc.id ?? `gemini-${turn}-${calls++}`,
          name: fc.name,
          input: (fc.args ?? {}) as Record<string, unknown>,
          signature: part.thoughtSignature,
        });
      }
      const finish = chunk.candidates?.[0]?.finishReason;
      if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') refused = true;
    }
    if (refused) return { answer, refused: true };
    if (uses.length === 0) break;

    o.messages.push({
      role: 'assistant',
      content: [
        ...(answer ? [{ type: 'text' as const, text: answer }] : []),
        ...uses.map((u): SignedToolUse => ({
          type: 'tool_use' as const,
          id: u.id,
          name: u.name,
          input: u.input,
          ...(u.signature ? { [SIGNATURE_KEY]: u.signature } : {}),
        })),
      ],
    });
    o.messages.push({ role: 'user', content: await runAll(o, uses) });
    answer = '';
  }
  return { answer, refused: false };
}

/**
 * The loop for a provider that is not Anthropic. Anthropic keeps its own
 * implementation in chat.ts, where the caching and thinking parameters live.
 */
export function toolLoopFor(provider: ProviderId): ((o: ToolLoopOpts) => Promise<ToolLoopResult>) | null {
  if (provider === 'openai') return openAiToolLoop;
  if (provider === 'gemini') return geminiToolLoop;
  return null;
}

// ── Errors, in words ────────────────────────────────────────────────────

/**
 * What went wrong, said in a sentence.
 *
 * Anthropic and OpenAI's SDKs raise something readable. Google's does not: a
 * failure arrives as its response body, JSON inside JSON, and it was going
 * straight to the page — `{"error":{"message":"{\n \"error\": {\n \"code\"…`
 * is not something to show anybody who wanted their storylines.
 *
 * The distinctions are the useful part. Two different problems both arrive as
 * a 429 — too many requests in the last minute, which fixes itself, and an
 * account with no money in it, which does not — and telling someone to wait
 * when they need to add credit wastes their afternoon.
 */
export function describeError(provider: ProviderId, err: unknown): string {
  const e = err as { status?: number; message?: string };
  const raw = e?.message ?? String(err);
  const message = unwrap(raw);
  const status = e?.status ?? statusIn(raw);
  const where = PROVIDERS.find((p) => p.id === provider);
  const console_ = where?.console ?? 'your provider dashboard';

  if (status === 401 || status === 403 || /api[_ ]?key not valid|invalid[_ ]api[_ ]key|unauthorized/i.test(message)) {
    return `${where?.label ?? 'The service'} rejected your API key. Check it in Settings — it may have been revoked or copied incompletely.`;
  }
  /*
   * An empty account only where the service says so outright. Google's wording
   * for a free tier's per-minute limit — "exceeded your current quota, please
   * check your plan and billing details" — mentions billing while meaning wait
   * a minute, so matching on that word alone sends somebody to buy credit they
   * already have. Checked before the general 429 for the same reason.
   */
  if (/insufficient_quota|no credits|payment required|billing_?not_?active/i.test(message)) {
    return `Your ${where?.label ?? 'API'} account is out of credit. Add some at ${console_} and try again — nothing here is lost.`;
  }
  if (status === 429) {
    // "Rate limit" says which it is; a bare "quota" genuinely could be either
    if (/rate.?limit|too many requests/i.test(message)) {
      return 'Too many requests in a short time. Wait a moment and try again — this clears by itself.';
    }
    if (/quota/i.test(message)) {
      return (
        `${where?.label ?? 'The service'} turned the request away for going over a limit — either ` +
        `too many in the last minute, or the allowance on your plan. Wait a minute and try again; ` +
        `if it keeps happening, check your usage at ${console_}.`
      );
    }
    return 'Too many requests in a short time. Wait a moment and try again — this clears by itself.';
  }
  if (status === 404) {
    return `That model is not available on your key. Choose another in Settings.`;
  }
  if (status && status >= 500) {
    return `${where?.label ?? 'The service'} had a problem at their end. Nothing is wrong with your save — try again shortly.`;
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|network|timeout/i.test(message)) {
    return 'Could not reach the service. Check your connection and try again.';
  }
  return message || 'The request failed.';
}

/** Digs the human sentence out of a body that may be JSON nested in JSON. */
function unwrap(raw: string): string {
  let text = raw;
  for (let depth = 0; depth < 3; depth++) {
    const start = text.indexOf('{');
    if (start === -1) break;
    try {
      const parsed: unknown = JSON.parse(text.slice(start));
      const inner = (parsed as { error?: { message?: string }; message?: string })?.error?.message
        ?? (parsed as { message?: string })?.message;
      if (typeof inner !== 'string' || inner === text) break;
      text = inner;
    } catch {
      break;
    }
  }
  return text.trim();
}

/** The status code, which Google puts in the body rather than on the error. */
function statusIn(raw: string): number | undefined {
  const match = /"code"\s*:\s*(\d{3})/.exec(raw) ?? /^(\d{3})\s/.exec(raw);
  return match ? Number(match[1]) : undefined;
}

/**
 * The same loop against Anthropic, for callers that are not the staff chat.
 *
 * The chat keeps its own in chat.ts, where the prompt-cache markers and the
 * thinking parameter live and where every turn is streamed to the page as it
 * arrives. This one is plain: it runs the tools, returns the finished text,
 * and is what the trade desk uses to go and look something up mid-conversation.
 */
async function anthropicToolLoop(o: ToolLoopOpts): Promise<ToolLoopResult> {
  const client = new Anthropic({ apiKey: o.key });
  let answer = '';

  for (let turn = 0; turn < o.maxTurns; turn++) {
    const message = await client.messages.create({
      model: o.model,
      max_tokens: 4000,
      system: o.system,
      tools: o.tools,
      messages: o.messages,
    });
    if (message.stop_reason === 'refusal') return { answer, refused: true };

    for (const block of message.content) {
      if (block.type === 'text') {
        answer += block.text;
        o.onText(block.text);
      }
    }

    const uses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    if (uses.length === 0) break;

    o.messages.push({ role: 'assistant', content: message.content });
    o.messages.push({
      role: 'user',
      content: await runAll(
        o,
        uses.map((u) => ({ id: u.id, name: u.name, input: (u.input ?? {}) as Record<string, unknown> }))
      ),
    });
    // Each turn's text has already been handed over; keeping it would repeat it
    answer = '';
  }
  return { answer, refused: false };
}

/**
 * A tool loop for any provider, including Anthropic.
 *
 * Distinct from toolLoopFor above, which returns nothing for Anthropic on
 * purpose: the chat has its own there and must keep it.
 */
export function toolLoop(provider: ProviderId): (o: ToolLoopOpts) => Promise<ToolLoopResult> {
  return toolLoopFor(provider) ?? anthropicToolLoop;
}
