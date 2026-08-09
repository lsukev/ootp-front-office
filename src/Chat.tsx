import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPut } from './api';

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
  /** ISO send time. Absent on threads saved before timestamps existed. */
  at?: string;
}

const clockTime = (iso?: string): string =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';

/** Day divider text, the way a messages app breaks up a long thread. */
const dayLabel = (iso?: string): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

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

/**
 * Conversations are kept per organization and survive closing the panel, a
 * reload, and a restart. Losing the thread on close made the assistant useless
 * for anything that took more than one question, since every follow-up arrived
 * with no idea what had already been said.
 */
const storageKey = (orgId: number) => `ootp-chat-${orgId}`;

/** Keeps the tail of the conversation — enough for context, bounded for storage. */
const KEEP = 40;

const valid = (parsed: unknown): Message[] =>
  Array.isArray(parsed)
    ? parsed.filter(
        (m): m is Message =>
          !!m && typeof m === 'object' && 'role' in m && 'content' in m &&
          typeof (m as Message).content === 'string'
      )
    : [];

/**
 * History comes from the server, which keeps it in the app's data folder.
 *
 * It used to live in localStorage, and the desktop app's origin changes with
 * its port — so every restart looked like a fresh browser and the thread was
 * gone. Anything already in localStorage is migrated up once so nobody loses a
 * conversation they still have.
 */
async function loadHistory(orgId: number): Promise<Message[]> {
  let stored: Message[] = [];
  try {
    stored = valid(await apiGet<unknown>(`/api/chat-history/${orgId}`));
  } catch {
    // No server (a static export) — fall through to whatever is local
  }
  if (stored.length > 0) return stored;
  try {
    const raw = localStorage.getItem(storageKey(orgId));
    const local = raw ? valid(JSON.parse(raw)) : [];
    if (local.length > 0) void saveHistory(orgId, local);
    return local;
  } catch {
    return [];
  }
}

async function saveHistory(orgId: number, messages: Message[]): Promise<void> {
  const trimmed = messages.slice(-KEEP);
  try {
    await apiPut(`/api/chat-history/${orgId}`, trimmed);
  } catch {
    // Keep a local copy as a backstop when the server cannot be reached
    try {
      localStorage.setItem(storageKey(orgId), JSON.stringify(trimmed));
    } catch {
      // Quota exceeded or storage disabled — the panel still works in memory
    }
  }
}

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

  // Each organization keeps its own thread, restored when you switch back
  useEffect(() => {
    let cancelled = false;
    setError(null);
    void loadHistory(orgId).then((m) => {
      if (!cancelled) setMessages(m);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;

      const now = new Date().toISOString();
      const history: Message[] = [...messages, { role: 'user', content: text, at: now }];
      setMessages([...history, { role: 'assistant', content: '', tools: [], at: now }]);
      // Save the question now: if the answer errors or is stopped, the thread
      // still reflects what was asked
      void saveHistory(orgId, history);
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
          const next =
            last?.role === 'assistant' && !last.content.trim() ? prev.slice(0, -1) : prev;
          void saveHistory(orgId, next);
          return next;
        });
      }
    },
    [busy, messages, orgId]
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    void saveHistory(orgId, []);
  }, [orgId]);

  return (
    <div className="imsg">
      {messages.length > 0 && (
        <div className="imsg-bar">
          <span>
            {messages.filter((m) => m.role === 'user').length} question
            {messages.filter((m) => m.role === 'user').length === 1 ? '' : 's'}
          </span>
          <button className="link-button" onClick={clear}>
            Start over
          </button>
        </div>
      )}

      <div className="imsg-log" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="imsg-intro">
            <div className="imsg-avatar imsg-avatar-lg" aria-hidden="true">
              P
            </div>
            <p>
              <strong className="imsg-name">Peter</strong> is your front-office analyst. Ask him
              anything about {orgLabel} or the league — he looks every number up in your save before
              answering rather than working from memory.
            </p>
            <div className="imsg-starters">
              {STARTERS.map((s) => (
                <button key={s} onClick={() => void ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const next = messages[i + 1];
          // Group consecutive messages from the same side, the way a
          // messages app does: one tail and one timestamp per run.
          const startsRun = !prev || prev.role !== m.role;
          const endsRun = !next || next.role !== m.role;
          const showDay =
            !!m.at && (!prev?.at || dayLabel(prev.at) !== dayLabel(m.at)) && !!dayLabel(m.at);
          const streaming = busy && i === messages.length - 1 && !m.content;

          return (
            <div key={i}>
              {showDay && <div className="imsg-day">{dayLabel(m.at)}</div>}
              <div className={`imsg-row imsg-${m.role} ${endsRun ? 'imsg-run-end' : ''}`}>
                {m.role === 'assistant' && (
                  <div className="imsg-avatar" aria-hidden="true">
                    {startsRun ? 'P' : ''}
                  </div>
                )}
                <div className="imsg-stack">
                  {m.tools && m.tools.length > 0 && (
                    <div className="imsg-activity">
                      {m.tools.map((tool, j) => (
                        <span key={`${tool}-${j}`}>{TOOL_LABELS[tool] ?? tool}</span>
                      ))}
                    </div>
                  )}

                  {streaming ? (
                    <div className="imsg-bubble imsg-typing" aria-label="Typing">
                      <i />
                      <i />
                      <i />
                    </div>
                  ) : (
                    m.content && (
                      <div className={`imsg-bubble ${endsRun ? 'imsg-tail' : ''}`}>{m.content}</div>
                    )
                  )}

                  {endsRun && m.at && !streaming && (
                    <time className="imsg-time">{clockTime(m.at)}</time>
                  )}
                </div>
              </div>
            </div>
          );
        })}

        {error && <div className="imsg-error">{error}</div>}
      </div>

      <form
        className="imsg-compose"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(input);
        }}
      >
        <div className="imsg-field">
          <textarea
            value={input}
            rows={1}
            placeholder="Message"
            aria-label={`Message Peter about ${orgLabel}`}
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
            <button
              type="button"
              className="imsg-send imsg-stop"
              onClick={() => abortRef.current?.abort()}
              aria-label="Stop"
              title="Stop"
            >
              ■
            </button>
          ) : (
            <button
              type="submit"
              className="imsg-send"
              disabled={!input.trim()}
              aria-label="Send"
              title="Send"
            >
              ↑
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
