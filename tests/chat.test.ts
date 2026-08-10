import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { appendPlain, continuesThread, trimTranscript } from '../server/chat.js';

/**
 * The assistant's memory of a conversation is the transcript it gets resent,
 * and the interesting part of that transcript is the tool results — the rows it
 * actually read. These cover the three ways that can go wrong: failing to
 * recognise a thread as its own, resending a transcript the API will reject,
 * and folding a new question into the wrong place.
 */

const q = (content: string) => ({ role: 'user' as const, content });
const a = (content: string) => ({ role: 'assistant' as const, content });

describe('recognising a thread as a continuation', () => {
  it('resumes when the client thread opens with the stored one', () => {
    const stored = [q('who can pitch tonight?'), a('Cole, on four days.')];
    expect(continuesThread(stored, [...stored, q('and tomorrow?')])).toBe(true);
  });

  it('does not resume a cleared conversation', () => {
    const stored = [q('who can pitch tonight?'), a('Cole, on four days.')];
    expect(continuesThread(stored, [q('who can pitch tonight?')])).toBe(false);
  });

  it('does not resume a thread whose earlier text has changed', () => {
    const stored = [q('who can pitch tonight?'), a('Cole, on four days.')];
    expect(continuesThread(stored, [q('who can catch tonight?'), a('Cole, on four days.')])).toBe(
      false
    );
  });

  it('has nothing to resume before the first answer is stored', () => {
    expect(continuesThread([], [q('anything')])).toBe(false);
  });
});

describe('appending the new tail', () => {
  it('keeps a tool result as the last thing the model saw', () => {
    // The shape a resumed transcript actually has: the evidence is in a
    // tool_result block, and the new question must not disturb it
    const messages: Anthropic.MessageParam[] = [
      q('is Volpe expiring?'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'contracts', input: {} }] },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Volpe: 3 service years' }],
      },
      a('No — three service years, so he is arbitration-eligible.'),
    ];
    appendPlain(messages, [q('and Caballero?')]);
    expect(messages).toHaveLength(5);
    expect(JSON.stringify(messages)).toContain('3 service years');
  });

  it('skips the empty assistant message an interrupted answer leaves behind', () => {
    const messages: Anthropic.MessageParam[] = [];
    appendPlain(messages, [q('first'), a('   '), q('second')]);
    // Two user messages in a row is a shape the API will not take, so they merge
    expect(messages).toEqual([{ role: 'user', content: 'first\n\nsecond' }]);
  });
});

describe('trimming an oversized transcript', () => {
  /** One exchange: question, tool call, result, answer. */
  const exchange = (n: number, padding: number): Anthropic.MessageParam[] => [
    q(`question ${n}`),
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `t${n}`, name: 'roster', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: `t${n}`, content: 'x'.repeat(padding) }],
    },
    a(`answer ${n}`),
  ];

  it('leaves a transcript inside the budget alone', () => {
    const messages = [...exchange(1, 100), ...exchange(2, 100)];
    expect(trimTranscript(messages)).toEqual(messages);
  });

  it('cuts whole exchanges, never orphaning a tool result', () => {
    const messages = [
      ...exchange(1, 150_000),
      ...exchange(2, 150_000),
      ...exchange(3, 150_000),
      ...exchange(4, 150_000),
    ];
    const trimmed = trimTranscript(messages);

    expect(trimmed.length).toBeLessThan(messages.length);
    expect(JSON.stringify(trimmed).length).toBeLessThanOrEqual(400_000);
    // A tool_result whose tool_use was dropped is a 400 from the API, so every
    // id one refers to has to still be present
    const ids = new Set<string>();
    for (const m of trimmed) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content) {
        if (b.type === 'tool_use') ids.add(b.id);
        if (b.type === 'tool_result') expect(ids.has(b.tool_use_id)).toBe(true);
      }
    }
    // And the surviving transcript has to start somewhere the API accepts
    expect(trimmed[0].role).toBe('user');
    expect(typeof trimmed[0].content).toBe('string');
  });

  it('keeps the most recent exchange, which is the one being answered', () => {
    const messages = [...exchange(1, 300_000), ...exchange(2, 300_000)];
    expect(JSON.stringify(trimTranscript(messages))).toContain('question 2');
  });
});
