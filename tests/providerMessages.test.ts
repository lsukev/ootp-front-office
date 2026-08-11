import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { toGeminiContents, toOpenAiMessages } from '../server/providers.js';

/**
 * Turning one conversation into another service's shape.
 *
 * This is where a mistake hides best. Every path through it type-checks, the
 * app runs, and the only symptom is a 400 from a server this repository has no
 * key for — on someone else's machine, after they have paid for the call. So
 * the invariants each API enforces are asserted here instead: OpenAI rejects a
 * tool result with no matching call, and Google needs the function's name on
 * the response, which only the call ever knew.
 */

/** A real shape: a question, a tool call, its result, then the answer. */
const TRANSCRIPT: Anthropic.MessageParam[] = [
  { role: 'user', content: 'How is Judge hitting?' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look him up.' },
      { type: 'tool_use', id: 'toolu_1', name: 'search_players', input: { q: 'Judge' } },
      { type: 'tool_use', id: 'toolu_2', name: 'get_player', input: { player_id: 42 } },
    ],
  },
  {
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"players":[]}' },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: 'not found', is_error: true },
    ],
  },
  { role: 'assistant', content: 'He is hitting well.' },
  { role: 'user', content: 'And his defence?' },
];

describe('a conversation on its way to OpenAI', () => {
  const out = toOpenAiMessages('You are the manager.', TRANSCRIPT) as any[];

  it('leads with the system prompt', () => {
    expect(out[0]).toEqual({ role: 'system', content: 'You are the manager.' });
  });

  it('gives every tool result a call to belong to', () => {
    const callIds = new Set(
      out.filter((m) => m.tool_calls).flatMap((m: any) => m.tool_calls.map((c: any) => c.id))
    );
    const resultIds = out.filter((m) => m.role === 'tool').map((m: any) => m.tool_call_id);
    expect(resultIds.length).toBe(2);
    for (const id of resultIds) expect(callIds.has(id), `${id} has no matching call`).toBe(true);
  });

  it('sends arguments as a JSON string, which is what the API expects', () => {
    const call = out.find((m) => m.tool_calls)?.tool_calls[0];
    expect(typeof call.arguments === 'undefined' ? call.function.arguments : call.arguments).toBe(
      '{"q":"Judge"}'
    );
  });

  it('puts each tool result after the call that asked for it', () => {
    const callAt = out.findIndex((m) => m.tool_calls);
    const firstResultAt = out.findIndex((m) => m.role === 'tool');
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(firstResultAt).toBeGreaterThan(callAt);
  });

  it('keeps the assistant text alongside its calls', () => {
    expect(out.find((m) => m.tool_calls)?.content).toBe('Let me look him up.');
  });

  it('carries both user questions through', () => {
    const asked = out.filter((m) => m.role === 'user').map((m) => m.content);
    expect(asked).toEqual(['How is Judge hitting?', 'And his defence?']);
  });
});

describe('a conversation on its way to Gemini', () => {
  const out = toGeminiContents(TRANSCRIPT);

  it('calls the assistant "model", which is what Google calls it', () => {
    expect(out.map((c) => c.role)).toEqual(['user', 'model', 'user', 'model', 'user']);
  });

  it('names the function on every response, recovered from the call', () => {
    const responses = out.flatMap((c) => c.parts.filter((p) => p.functionResponse));
    expect(responses.map((p) => p.functionResponse!.name)).toEqual(['search_players', 'get_player']);
  });

  it('wraps plain-text tool output in an object, which Google requires', () => {
    const first = out.flatMap((c) => c.parts).find((p) => p.functionResponse)!;
    expect(first.functionResponse!.response).toEqual({ result: '{"players":[]}' });
  });

  it('keeps the arguments as an object, not a string', () => {
    const call = out.flatMap((c) => c.parts).find((p) => p.functionCall)!;
    expect(call.functionCall!.args).toEqual({ q: 'Judge' });
  });

  it('drops nothing — every block arrives as a part', () => {
    // 1 question + (text + 2 calls) + 2 results + 1 answer + 1 question
    expect(out.flatMap((c) => c.parts).length).toBe(8);
  });
});

describe('an empty or partial turn', () => {
  it('does not emit a content-less message', () => {
    const out = toGeminiContents([{ role: 'assistant', content: [] }]);
    expect(out).toEqual([]);
  });

  it('survives content given as a bare string', () => {
    const out = toOpenAiMessages('sys', [{ role: 'assistant', content: 'hello' }]) as any[];
    expect(out[1]).toMatchObject({ role: 'assistant', content: 'hello' });
  });
});
