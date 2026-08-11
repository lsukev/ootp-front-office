import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

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

const gemini: Provider = {
  async complete({ key, model, system, messages, maxTokens, schema }) {
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
  const client = new GoogleGenAI({ apiKey: o.key });
  let answer = '';

  for (let turn = 0; turn < o.maxTurns; turn++) {
    const stream = await client.models.generateContentStream({
      model: o.model,
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
