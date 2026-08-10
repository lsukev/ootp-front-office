import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, apiPut } from './api';
import { PlayerNames, nameIndex, type Entry } from './PlayerNames';

/**
 * Ask-the-save chat. The server streams the answer over SSE and announces each
 * tool call as it happens, so a question that takes several lookups shows its
 * work instead of sitting on a spinner.
 */

interface Message {
  role: 'user' | 'assistant';
  content: string;
  /** In a room, who said it. Absent in a one-to-one thread. */
  speaker?: string;
  speakerRole?: string;
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
  get_injuries: 'checking the training room',
  get_prospects: 'reviewing prospects',
  get_leaderboards: 'checking league leaders',
  get_teams: 'looking up teams',
};

interface StaffMember { id: string; name: string; role: string }

/**
 * Short titles for the tabs. The full role reads well in a sentence but not in
 * a strip of five, and a name on its own is no help at all to anyone who does
 * not already know who Drew Toussaint is.
 */
const ROOM_ID = 'room';

/**
 * Who a message is aimed at, when it is aimed at anybody.
 *
 * Typing "Hal what do you think about Austin Riley?" into a room of three got
 * three answers, two of which were "I'm not Hal" — the room had no idea a name
 * at the front of a sentence meant anything. A name at the start of the
 * message, or anywhere with an @ in front of it, now sends the question to
 * that man alone.
 *
 * Only those two positions count. Matching a name anywhere would catch every
 * mention of a colleague inside an ordinary question, which is common in a
 * room where they are told to refer to each other by name.
 */
function addressedMember(text: string, staff: StaffMember[]): StaffMember | null {
  const hit = new Set<string>();
  for (const p of staff) {
    if (p.id === ROOM_ID) continue;
    const parts = p.name.split(/\s+/);
    for (const form of [p.name, parts[0], parts[parts.length - 1]]) {
      if (!form || form.length < 2) continue;
      const safe = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`^\\s*@?${safe}\\b`, 'i').test(text) || new RegExp(`@${safe}\\b`, 'i').test(text)) {
        hit.add(p.id);
      }
    }
  }
  return hit.size === 1 ? (staff.find((p) => p.id === [...hit][0]) ?? null) : null;
}

const ROLE_LABEL: Record<string, string> = {
  room: 'Group chat',
  analyst: 'Analyst',
  manager: 'Manager',
  pitching: 'Pitching Coach',
  hitting: 'Hitting Coach',
  trainer: 'Trainer',
  scout: 'Scout',
  owner: 'Owner',
};

/** Peter is always available; the rest depend on who the club has hired. */
const FALLBACK_STAFF: StaffMember[] = [{ id: 'analyst', name: 'Peter', role: 'front-office analyst' }];

/** Openers worth asking each of them, since what they are for differs. */
const STARTERS_BY_PERSONA: Record<string, string[]> = {
  analyst: [
    'How is my team actually playing so far?',
    'Who should I call up from the minors?',
    'Which contracts should I worry about?',
  ],
  manager: [
    'Who should I start tonight?',
    'Who needs a day off?',
    'How do you want to use the bullpen this week?',
  ],
  pitching: [
    'Who can pitch tonight?',
    'Is anyone being overworked?',
    'Who is due for a step forward?',
  ],
  hitting: [
    'Who is pressing at the plate right now?',
    'Is anyone hitting into bad luck?',
    'Which of our young bats is closest to figuring it out?',
  ],
  room: [
    'Who is hurt, and how should we handle him when he is back?',
    'Should we go after a starter, and can we afford one?',
    'What is the biggest problem with this team right now?',
  ],
  trainer: [
    'Who is hurt and how long are they out?',
    'Is anyone at risk of breaking down?',
    'Who is close to a rehab assignment?',
  ],
  scout: [
    'Which prospect is closest to helping us?',
    'Who is overrated on our farm?',
    'What should I be looking for in the draft?',
  ],
  owner: [
    'Can we afford to add salary?',
    'Is this roster worth what we are paying for it?',
    'What do you expect from this season?',
  ],
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
async function loadHistory(orgId: number, persona: string): Promise<Message[]> {
  let stored: Message[] = [];
  try {
    stored = valid(await apiGet<unknown>(`/api/chat-history/${orgId}?persona=${persona}`));
  } catch {
    // No server (a static export) — fall through to whatever is local
  }
  if (stored.length > 0) return stored;
  // Only Peter ever had a local-only thread to recover; the rest are new
  if (persona !== 'analyst') return [];
  try {
    const raw = localStorage.getItem(storageKey(orgId));
    const local = raw ? valid(JSON.parse(raw)) : [];
    if (local.length > 0) void saveHistory(orgId, persona, local);
    return local;
  } catch {
    return [];
  }
}

async function saveHistory(orgId: number, persona: string, messages: Message[]): Promise<void> {
  const trimmed = messages.slice(-KEEP);
  try {
    await apiPut(`/api/chat-history/${orgId}?persona=${persona}`, trimmed);
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
  const [staff, setStaff] = useState<StaffMember[]>(FALLBACK_STAFF);
  const [persona, setPersona] = useState('analyst');
  /** Who is in the room. Remembered, since assembling it is a small chore. */
  const [roomMembers, setRoomMembers] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem('ootp-room-members');
      return raw ? (JSON.parse(raw) as string[]) : ['trainer', 'pitching', 'manager'];
    } catch {
      return ['trainer', 'pitching', 'manager'];
    }
  });
  const toggleMember = (id: string) =>
    setRoomMembers((cur) => {
      const next = cur.includes(id) ? cur.filter((m) => m !== id) : [...cur, id].slice(0, 4);
      try { localStorage.setItem('ootp-room-members', JSON.stringify(next)); } catch { /* fine */ }
      return next;
    });

  // Who this club has on the payroll. A save missing a seat simply shows fewer
  // tabs rather than offering a conversation with nobody.
  useEffect(() => {
    apiGet<{ staff: StaffMember[] }>(`/api/chat-staff/${orgId}`)
      .then((r) => {
        const people = r.staff.length > 0 ? r.staff : FALLBACK_STAFF;
        // The room only makes sense when there is more than one person to put in it
        setStaff(people.length > 1 ? [...people, { id: ROOM_ID, name: 'The Room', role: 'group' }] : people);
        setPersona((cur) => (people.some((p) => p.id === cur) ? cur : people[0].id));
      })
      .catch(() => setStaff(FALLBACK_STAFF));
  }, [orgId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy]);

  // Every person on every club keeps their own thread, restored when you come
  // back to them — the manager should not see what the owner was told
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setMessages([]);
    void loadHistory(orgId, persona).then((m) => {
      if (!cancelled) setMessages(m);
    });
    return () => {
      cancelled = true;
    };
  }, [orgId, persona]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const ask = useCallback(
    async (question: string) => {
      const text = question.trim();
      if (!text || busy) return;

      // A question aimed at one man goes to him alone, and brings him into the
      // room if he was not already in it — asking for someone is asking for him
      const aimedAt = persona === ROOM_ID ? addressedMember(text, staff) : null;
      let members = roomMembers;
      if (aimedAt && !members.includes(aimedAt.id)) {
        members = [...members, aimedAt.id].slice(-4);
        setRoomMembers(members);
        try { localStorage.setItem('ootp-room-members', JSON.stringify(members)); } catch { /* fine */ }
      }

      const now = new Date().toISOString();
      const history: Message[] = [...messages, { role: 'user', content: text, at: now }];
      setMessages([...history, { role: 'assistant', content: '', tools: [], at: now }]);
      // Save the question now: if the answer errors or is stopped, the thread
      // still reflects what was asked
      void saveHistory(orgId, persona, history);
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
            persona,
            ...(persona === ROOM_ID ? { members, addressed: aimedAt?.id } : {}),
            messages: history.map(({ role, content, speaker }) => ({ role, content, speaker })),
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

            if (event === 'speaker') {
              // A new voice in the room starts its own bubble. The first one
              // takes over the placeholder the send already created.
              setMessages((prev) => {
                const next = [...prev];
                const last = next[next.length - 1];
                if (last && last.role === 'assistant' && last.content === '' && !last.speaker) {
                  next[next.length - 1] = { ...last, speaker: data.name, speakerRole: data.role };
                } else {
                  next.push({
                    role: 'assistant', content: '', tools: [],
                    speaker: data.name, speakerRole: data.role, at: new Date().toISOString(),
                  });
                }
                return next;
              });
            } else if (event === 'text') {
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
          void saveHistory(orgId, persona, next);
          return next;
        });
      }
    },
    // persona and roomMembers belong here as much as the rest: toggling who is
    // in the room changes neither `messages` nor `busy`, so without them this
    // callback kept whichever members it had captured the last time a message
    // arrived — which is to say the defaults, whatever the chips showed.
    [busy, messages, orgId, persona, roomMembers]
  );

  const clear = useCallback(() => {
    abortRef.current?.abort();
    setMessages([]);
    setError(null);
    void saveHistory(orgId, persona, []);
  }, [orgId, persona]);

  const who = staff.find((p) => p.id === persona) ?? FALLBACK_STAFF[0];
  const starters = STARTERS_BY_PERSONA[persona] ?? STARTERS;

  return (
    <div className="imsg">
      {staff.length > 1 && (
        <div className="imsg-staff" role="tablist" aria-label="Who to talk to">
          {staff.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={p.id === persona}
              className={`imsg-staff-tab ${p.id === persona ? 'active' : ''}`}
              onClick={() => setPersona(p.id)}
              title={`${p.name} — ${p.role}`}
            >
              <span className="imsg-staff-name">{p.name}</span>
              <span className="imsg-staff-role">{ROLE_LABEL[p.id] ?? p.role}</span>
            </button>
          ))}
        </div>
      )}

      {persona === ROOM_ID && (
        <div className="imsg-room-picker">
          <span className="muted">In the room:</span>
          {staff.filter((p) => p.id !== ROOM_ID).map((p) => (
            <button
              key={p.id}
              className={`room-chip ${roomMembers.includes(p.id) ? 'on' : ''}`}
              onClick={() => toggleMember(p.id)}
              title={p.role}
            >
              {p.name}
            </button>
          ))}
          <span className="muted room-hint">
            {roomMembers.length === 0
              ? 'Pick at least one.'
              : 'They answer in order and see what the others said. Add or remove anyone at any ' +
                'point — a new voice reads the conversation so far. Start a message with a name, ' +
                'or put an @ in front of one, to ask that person alone.'}
          </span>
        </div>
      )}

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
              {who.name.charAt(0)}
            </div>
            <p>
              <strong className="imsg-name">{who.name}</strong> is your {who.role}. Ask him about{' '}
              {orgLabel} or the league — every number comes out of your save rather than his memory,
              and he answers from where he sits, so he will not always agree with the others.
            </p>
            <div className="imsg-starters">
              {starters.map((s) => (
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
                    {startsRun || m.speaker ? (m.speaker ?? who.name).charAt(0) : ''}
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

                  {m.speaker && (
                    <span className="imsg-speaker">
                      {m.speaker}
                      {m.speakerRole && <span className="muted"> · {m.speakerRole}</span>}
                    </span>
                  )}

                  {streaming ? (
                    <div className="imsg-bubble imsg-typing" aria-label="Typing">
                      <i />
                      <i />
                      <i />
                    </div>
                  ) : (
                    m.content && (
                      <div className={`imsg-bubble ${endsRun ? 'imsg-tail' : ''}`}>
                        {/* Names are linked once the reply is complete. Re-running
                            the match on every streamed token would be wasted work
                            on a sentence that is still being written. */}
                        {busy && i === messages.length - 1 ? (
                          m.content
                        ) : (
                          <PlayerNames orgId={orgId}>{m.content}</PlayerNames>
                        )}
                      </div>
                    )
                  )}

                  {m.speaker && !streaming && m.content && (
                    <button
                      className="link-button imsg-reply"
                      onClick={() => setInput((cur) => (cur ? cur : `${m.speaker!.split(' ')[0]} `))}
                      title={`Ask ${m.speaker} directly`}
                    >
                      Reply to {m.speaker.split(' ')[0]}
                    </button>
                  )}

                  {m.role === 'assistant' && m.content && !streaming && (
                    <SaveToPlayer
                      orgId={orgId}
                      body={m.content}
                      source={m.speaker ?? who.name}
                      question={
                        [...messages.slice(0, i)].reverse().find((p) => p.role === 'user')?.content ?? ''
                      }
                    />
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
            aria-label={`Message ${who.name} about ${orgLabel}`}
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

/** Suffixes that sit after a surname and should not be mistaken for one. */
const SUFFIXES = new Set(['jr.', 'jr', 'sr.', 'sr', 'ii', 'iii', 'iv', 'v']);

/**
 * The surnames a full name could be referred to by.
 *
 * "Gerrit Cole" is called Cole; "Jazz Chisholm Jr." is called Chisholm, not
 * "Chisholm Jr.", so a trailing suffix is stepped over rather than taken as
 * the name.
 */
function surnamesOf(full: string): string[] {
  const parts = full.trim().split(/\s+/);
  if (parts.length < 2) return [];
  const last = parts[parts.length - 1];
  const out = [last];
  if (SUFFIXES.has(last.toLowerCase()) && parts.length > 2) out.push(parts[parts.length - 2]);
  return out;
}

/**
 * Keeps an answer on a player's file.
 *
 * Finding who an answer is about is the hard half. Staff write the way people
 * talk — "Cole", then "he" for six paragraphs — so matching full names alone
 * found nobody in the very case this feature exists for. It now also accepts a
 * surname, but only when exactly one man in the league answers to it, since a
 * bare "Young" or "Price" could be half a dozen people or an ordinary word.
 * The question that prompted the answer is searched too, because that is often
 * where the name was said. Failing all of that, there is a search box: the
 * control should never be a dead end.
 */
function SaveToPlayer({
  orgId, body, source, question,
}: { orgId: number; body: string; source: string; question: string }) {
  const [open, setOpen] = useState(false);
  const [found, setFound] = useState<Array<[number, string, number?]>>([]);
  const [entries, setEntries] = useState<Array<[number, string, number?]>>([]);
  const [query, setQuery] = useState('');
  const [saved, setSaved] = useState<string | null>(null);

  const look = async () => {
    if (open) return setOpen(false);
    setOpen(true);
    const all: Entry[] = await nameIndex(orgId);
    setEntries(all);

    const haystack = `${body}\n${question}`;
    const hits = new Map<number, string>();

    // A full name is unambiguous, so it is trusted wherever it appears
    for (const [id, name] of all) if (haystack.includes(name)) hits.set(id, name);

    /*
     * Surnames are how people actually talk — "Cole", then "he" for six
     * paragraphs. Several men can share one, so rather than guessing or giving
     * up, every match is offered with our own players first: two names and one
     * click beats "no players named in this answer", which is what this used
     * to say about an answer plainly about Gerrit Cole.
     */
    const bySurname = new Map<string, Entry[]>();
    for (const e of all) {
      for (const sn of surnamesOf(e[1])) {
        const list = bySurname.get(sn) ?? [];
        list.push(e);
        bySurname.set(sn, list);
      }
    }
    const extra: Entry[] = [];
    for (const [sn, people] of bySurname) {
      if (new RegExp(`\\b${sn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystack)) {
        for (const e of people) if (!hits.has(e[0])) extra.push(e);
      }
    }
    // Ours first, then the shortest names, which are the likeliest referents
    extra.sort((a, b) => (b[2] ?? 0) - (a[2] ?? 0) || a[1].length - b[1].length);

    const list: Entry[] = [
      ...[...hits.entries()].map(([id, name]) => [id, name] as Entry),
      ...extra,
    ];
    setFound(list.slice(0, 8));
  };

  const save = async (id: number, name: string) => {
    try {
      await apiPost('/api/player-notes', { player_id: id, player_name: name, source, body });
      setSaved(name);
      setOpen(false);
    } catch {
      setSaved(null);
    }
  };

  const searched =
    query.trim().length < 2
      ? []
      : entries
          .filter(([, n]) => n.toLowerCase().includes(query.trim().toLowerCase()))
          .slice(0, 6);

  if (saved) return <span className="imsg-saved muted">Saved to {saved}’s file</span>;

  return (
    <span className="imsg-save">
      <button className="link-button" onClick={look}>
        {open ? 'Cancel' : 'Save to a player\u2019s file'}
      </button>
      {open && (
        <span className="imsg-save-list">
          {found.map(([id, name]) => (
            <button key={id} className="room-chip on" onClick={() => void save(id, name)}>
              {name}
            </button>
          ))}
          <input
            className="imsg-save-search"
            placeholder={found.length ? 'or search\u2026' : 'search for a player\u2026'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {searched.map(([id, name]) => (
            <button key={`s${id}`} className="room-chip" onClick={() => void save(id, name)}>
              {name}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
