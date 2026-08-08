import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Ask-the-save chat. The server streams the answer over SSE and announces each
 * tool call as it happens, so a question that takes several lookups shows its
 * work instead of sitting on a spinner.
 */

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** Tools the assistant called while producing this answer. */
  tools?: string[];
}

const TOOL_LABELS: Record<string, string> = {
  search_players: 'searching players',
  get_player: 'reading a player card',
  get_roster: 'reading the roster',
  get_standings: 'checking the standings',
  get_pitching_staff: 'checking the pitching staff',
  get_schedule: 'reading the schedule',
  get_lineup: 'building a lineup',
  get_payroll: 'looking at the books',
  get_prospects: 'reviewing prospects',
  get_leaderboards: 'checking league leaders',
  get_teams: 'looking up teams',
};

const STARTERS = [
  'How is my team actually playing so far?',
  'Who should I call up from the minors?',
  'Which contracts should I worry about?',
  'Who can pitch tonight?',
];

export function Chat({ orgId, orgLabel }: { orgId: number; orgLabel: string }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // A new organization is a different conversation
  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [orgId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;

      const history: Message[] = [...messages, { role: 'user', content: text }];
      setMessages([...history, { role: 'assistant', content: '', tools: [] }]);
      setInput('');
      setBusy(true);
      setError(null);

      const controller = new AbortController();
      abortRef.current = controller;

      /** Replaces the trailing assistant message as tokens arrive. */
      const update = (fn: (m: Message) => Message) =>
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = fn(next[next.length - 1]);
          return next;
        });

      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orgId,
            messages: history.map(({ role, content }) => ({ role, content })),
          }),
          signal: controller.signal,
        });

        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `${res.status} ${res.statusText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          // SSE frames are separated by a blank line; keep any partial tail
          const frames = buffer.split('\n\n');
          buffer = frames.pop() ?? '';

          for (const frame of frames) {
            const eventLine = frame.split('\n').find((l) => l.startsWith('event: '));
            const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!eventLine || !dataLine) continue;
            const event = eventLine.slice(7).trim();
            const data = JSON.parse(dataLine.slice(6)) as Record<string, string>;

            if (event === 'text') {
              update((m) => ({ ...m, content: m.content + data.delta }));
            } else if (event === 'tool') {
              update((m) => ({ ...m, tools: [...(m.tools ?? []), data.name] }));
            } else if (event === 'error') {
              setError(data.message);
            }
          }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') setError((e as Error).message);
      } finally {
        setBusy(false);
        abortRef.current = null;
        // Drop the placeholder if the request produced nothing at all
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === 'assistant' && !last.content.trim()) return prev.slice(0, -1);
          return prev;
        });
      }
    },
    [busy, messages, orgId]
  );

  return (
    <div className="chat">
      <div className="chat-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p className="muted">
              Ask anything about {orgLabel} or the league. Answers come from your save, not from
              general baseball knowledge — the assistant looks the numbers up before replying.
            </p>
            <div className="chat-starters">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => void ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            {m.tools && m.tools.length > 0 && (
              <div className="chat-tools">
                {m.tools.map((t, j) => (
                  <span key={`${t}-${j}`}>{TOOL_LABELS[t] ?? t}</span>
                ))}
              </div>
            )}
            {m.content ? (
              <div className="chat-text">{m.content}</div>
            ) : (
              busy && i === messages.length - 1 && <span className="chat-thinking">Thinking…</span>
            )}
          </div>
        ))}

        {error && <div className="banner error">{error}</div>}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <textarea
          value={input}
          rows={1}
          placeholder={`Ask about ${orgLabel}, a player, the standings…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter is a newline
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(input);
            }
          }}
        />
        {busy ? (
          <button type="button" onClick={() => abortRef.current?.abort()}>
            Stop
          </button>
        ) : (
          <button type="submit" className="cta" disabled={!input.trim()}>
            Ask
          </button>
        )}
      </form>
    </div>
  );
}
