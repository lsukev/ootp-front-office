import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { DATA_DIR } from './config.js';
import { activeProvider, aiModel, getApiKey } from './settings.js';
import { stripProviderExtras, toolLoopFor, type ProviderId } from './providers.js';
import { supportsAdaptiveThinking } from './models.js';
import { currentGameDate, seasonYear } from './valuation.js';
import { personaBrief, personaById, personasFor, type Persona } from './staff.js';

export const chatRoutes = Router();

/**
 * The conversation lives on disk beside the rest of the app's data.
 *
 * It used to live in the browser's localStorage, which is scoped to the
 * window's origin — and the desktop app took a fresh random port on every
 * launch, so each restart presented a new origin and an empty history. Keeping
 * it in the data directory means it survives restarts, updates and a change of
 * port, which is what a conversation you can pick up later actually requires.
 */
const suffix = (persona: string) => (persona === 'analyst' ? '' : `-${persona}`);
/** Peter keeps the original filename so threads written before this survive. */
const historyPath = (orgId: number, persona: string) =>
  path.join(DATA_DIR, `chat-${orgId}${suffix(persona)}.json`);

/**
 * A cap on the saved thread, high enough that reaching it means a season's
 * worth of conversation rather than an afternoon's. It exists so a file cannot
 * grow forever, not to decide what is worth remembering.
 */
const KEEP_TURNS = 1000;

/**
 * Who this club can put on the phone.
 *
 * Named for the chat rather than for the staff: `/staff/:orgId` already belongs
 * to the Coaching Staff page, and registering it twice silently handed that
 * page this payload instead of its own.
 */
chatRoutes.get('/chat-staff/:orgId', (req, res) => {
  const people = personasFor(Number(req.params.orgId));
  res.json({ staff: people.map((p) => ({ id: p.id, name: p.name, role: p.role })) });
});

const personaParam = (req: { query: Record<string, unknown> }): string => {
  const raw = String(req.query.persona ?? 'analyst');
  return /^[a-z]+$/.test(raw) ? raw : 'analyst';
};

chatRoutes.get('/chat-history/:orgId', (req, res) => {
  try {
    const raw = fs.readFileSync(historyPath(Number(req.params.orgId), personaParam(req)), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    res.json(Array.isArray(parsed) ? parsed : []);
  } catch {
    res.json([]);
  }
});

chatRoutes.put('/chat-history/:orgId', (req, res) => {
  const body = req.body as unknown;
  if (!Array.isArray(body)) return res.status(400).json({ error: 'Expected an array of messages' });
  try {
    fs.writeFileSync(
      historyPath(Number(req.params.orgId), personaParam(req)),
      JSON.stringify(body.slice(-KEEP_TURNS))
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const NO_KEY_MESSAGE =
  'No Anthropic API key set. Open Settings and add your key — you can get one at console.claude.com.';

/**
 * The assistant answers from the save by calling the app's own API rather than
 * querying SQLite directly. That keeps one implementation of every stat and
 * ranking: if the Standings page and the assistant ever disagreed, one of them
 * would be wrong, and this makes that impossible by construction.
 */
async function callOwnApi(path: string): Promise<unknown> {
  const port = process.env.OOTP_FO_PORT;
  if (!port) throw new Error('Server port unknown');
  const res = await fetch(`http://127.0.0.1:${port}/api/${path.replace(/^\//, '')}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json();
}

/** Trims a tool result so a 500-player payload can't blow out the context. */
function cap(value: unknown, maxChars = 60_000): string {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return text;
  // Truncated JSON cannot be parsed, so say so loudly rather than handing back
  // a fragment the model might read as a complete answer.
  return (
    `[TRUNCATED: this result was ${text.length} characters, over the ${maxChars} limit. ` +
    'The JSON below is CUT OFF and incomplete — do not treat it as the full set. ' +
    'Re-run with a narrower query.]\n' +
    text.slice(0, maxChars)
  );
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'search_players',
    description:
      'Search players across the whole league by name, with season stats. Use this whenever the ' +
      'user names a player. Batters and pitchers are separate result sets, so if a name returns ' +
      'nothing, try the other group before concluding the player does not exist.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Part of the player name. At least 2 characters.' },
        group: { type: 'string', enum: ['batting', 'pitching'], description: 'Defaults to batting.' },
        level: {
          type: 'string',
          description: "'1' for MLB, '2' AAA, '3' AA, '4' A, '6' Rookie, or 'all' for every level.",
        },
        freeAgents: { type: 'boolean', description: 'Search unsigned free agents instead of rostered players.' },
        limit: { type: 'number', description: 'Max results, default 25.' },
      },
      required: ['q'],
    },
  },
  {
    name: 'get_player',
    description:
      'Full dossier for one player: bio, current and potential ratings, contract and salary ' +
      'schedule, career stats by season and level, recent game logs, and injury history. Call ' +
      'search_players first to get the player_id.',
    input_schema: {
      type: 'object',
      properties: { player_id: { type: 'number' } },
      required: ['player_id'],
    },
  },
  {
    name: 'get_roster',
    description: 'Every player on one team with full season stat lines and ratings.',
    input_schema: {
      type: 'object',
      properties: { team_id: { type: 'number' } },
      required: ['team_id'],
    },
  },
  {
    name: 'get_standings',
    description: 'League standings by division: record, games back, run differential, and streak.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_pitching_staff',
    description:
      'The rotation and bullpen for a team, including who is actually available to pitch tonight ' +
      'based on recent pitch counts, plus injuries and starting depth.',
    input_schema: {
      type: 'object',
      properties: { team_id: { type: 'number' } },
      required: ['team_id'],
    },
  },
  {
    name: 'get_schedule',
    description:
      'The season schedule grouped into series, with results for games played and probable ' +
      'starters for upcoming ones. A full season is large, so this returns a window around the ' +
      'current series by default — ask for more only when the question needs it.',
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'number' },
        window: {
          type: 'string',
          enum: ['current', 'upcoming', 'played', 'all'],
          description:
            "'current' (default) is the next series plus the few either side; 'upcoming' is every " +
            "series still to play; 'played' is completed series; 'all' is the whole season.",
        },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'get_lineup',
    description:
      "The app's recommended batting order against a given hand of pitching, with the reason for " +
      'each slot and the hitters season stats.',
    input_schema: {
      type: 'object',
      properties: {
        team_id: { type: 'number' },
        vs: { type: 'string', enum: ['r', 'l'], description: 'Hand of the opposing starter.' },
      },
      required: ['team_id'],
    },
  },
  {
    name: 'get_payroll',
    description:
      'Budget, current and future committed salary by season, contracts, what expires after this ' +
      'season, and dead money owed to departed players.',
    input_schema: {
      type: 'object',
      properties: { team_id: { type: 'number' } },
      required: ['team_id'],
    },
  },
  {
    name: 'get_injuries',
    description:
      'Everyone in the organisation currently hurt: status (day-to-day, IL, IL-60), days left, ' +
      'and what level they are at. The first thing to check before saying anyone is available.',
    input_schema: {
      type: 'object',
      properties: { team_id: { type: 'number' } },
      required: ['team_id'],
    },
  },
  {
    name: 'get_prospects',
    description: 'Minor leaguers ranked by promotion signal, with the reasoning behind each ranking.',
    input_schema: {
      type: 'object',
      properties: { team_id: { type: 'number' } },
      required: ['team_id'],
    },
  },
  {
    name: 'get_leaderboards',
    description: 'League leaders across the main batting and pitching categories.',
    input_schema: {
      type: 'object',
      properties: { team_id: { type: 'number' } },
      required: ['team_id'],
    },
  },
  {
    name: 'get_teams',
    description:
      'Every team with its team_id, level, and parent club. Use this to resolve a club name the ' +
      'user mentions into the team_id the other tools need.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'search_players': {
      const params = new URLSearchParams();
      params.set('q', String(input.q ?? ''));
      params.set('group', String(input.group ?? 'batting'));
      params.set('level', String(input.level ?? 'all'));
      params.set('limit', String(Math.min(Number(input.limit ?? 25), 100)));
      if (input.freeAgents) params.set('freeAgents', '1');
      return cap(await callOwnApi(`players?${params}`));
    }
    case 'get_player':
      return cap(await callOwnApi(`player/${Number(input.player_id)}`));
    case 'get_roster':
      return cap(await callOwnApi(`roster/${Number(input.team_id)}`));
    case 'get_standings':
      return cap(await callOwnApi(`standings/${defaultOrgId()}`));
    case 'get_pitching_staff':
      return cap(await callOwnApi(`pitching/${Number(input.team_id)}`));
    case 'get_schedule': {
      const full = (await callOwnApi(`schedule/${Number(input.team_id)}`)) as {
        series: Array<{ played: boolean }>;
        nextSeriesIndex: number;
      };
      const window = String(input.window ?? 'current');
      const next = full.nextSeriesIndex >= 0 ? full.nextSeriesIndex : full.series.length;
      // A whole season of series does not fit in one tool result, and a
      // truncated JSON blob is worse than a smaller complete one.
      const series =
        window === 'all'
          ? full.series
          : window === 'played'
            ? full.series.filter((s) => s.played)
            : window === 'upcoming'
              ? full.series.filter((s) => !s.played)
              : full.series.slice(Math.max(0, next - 2), next + 4);
      // Wide windows drop the game-by-game detail: a whole-season answer is about
      // opponents and dates, and keeping every box score would blow the cap and
      // force a truncated, unparseable result.
      const summarize = window === 'upcoming' || window === 'all';
      const shaped = summarize
        ? series.map(({ games, ...rest }: Record<string, unknown> & { games?: unknown[] }) => ({
            ...rest,
            gameCount: Array.isArray(games) ? games.length : 0,
          }))
        : series;
      return cap({
        ...full,
        window,
        detail: summarize ? 'series summary only — use window "current" for game-by-game' : 'full',
        seriesReturned: shaped.length,
        series: shaped,
      });
    }
    case 'get_lineup':
      return cap(await callOwnApi(`lineup/${Number(input.team_id)}?vs=${input.vs === 'l' ? 'l' : 'r'}`));
    case 'get_payroll':
      return cap(await callOwnApi(`payroll/${Number(input.team_id)}`));
    case 'get_injuries':
      return cap(await callOwnApi(`injuries/${Number(input.team_id)}`));
    case 'get_prospects':
      return cap(await callOwnApi(`prospects/${Number(input.team_id)}`));
    case 'get_leaderboards':
      return cap(await callOwnApi(`leaderboards/${Number(input.team_id)}`));
    case 'get_teams':
      return cap(await callOwnApi('teams'));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function defaultOrgId(): number {
  const row = db.prepare(`SELECT team_id FROM teams WHERE human_team = 1 LIMIT 1`).get() as
    | { team_id: number }
    | undefined;
  if (row) return row.team_id;
  const any = db.prepare(`SELECT team_id FROM teams WHERE level = 1 LIMIT 1`).get() as
    | { team_id: number }
    | undefined;
  return any?.team_id ?? 1;
}

/**
 * Orients the model in the save so it doesn't have to burn a tool call on
 * basics, then hands over to whichever member of staff is speaking. Everything
 * below the brief is shared: the rules about only trusting the tools, and what
 * the numbers mean, are true no matter who is talking.
 */
function systemPrompt(orgId: number, persona: Persona): string {
  const team = db
    .prepare(
      `SELECT name, nickname, league_id FROM teams WHERE team_id = ?`
    )
    .get(orgId) as { name: string; nickname: string; league_id: number } | undefined;
  const label = team ? `${team.name} ${team.nickname}`.trim() : 'this club';
  const year = team ? seasonYear(team.league_id) : new Date().getFullYear();
  const date = team ? currentGameDate(team.league_id) : null;

  return [
    personaBrief(persona, orgId),
    '',
    'This is a text-message conversation, so write like one: short messages, plain sentences, no',
    'greeting or sign-off on every reply. You can be dry and opinionated the way a trusted analyst',
    'is with a colleague — but never invent a number to be interesting.',
    '',
    `They run the ${label} (team_id ${orgId}). It is the ${year} season${date ? `, currently ${date}` : ''}.`,
    '',
    'Everything you say about this league must come from the tools. They read the actual save, so',
    'they are the only source of truth here — this is a simulated league, and your training data',
    'contains nothing about it. Never answer a factual question about a player, team, or record',
    'from memory: real-world knowledge about a same-named player is almost always wrong here,',
    'because the sim has diverged. If the tools cannot answer something, say so plainly.',
    '',
    'Lead with the answer, then the evidence.',
    'Cite the numbers you used. Keep it conversational — no headers or bullet lists unless the',
    'user asks for a rundown of several things. When a number is surprising, say why it might be',
    '(small sample, park, level) rather than presenting it flatly.',
    '',
    'Useful context on the numbers: OPS+, wRC+, and ERA+ are scaled so 100 is league average and',
    'are park- and league-adjusted, so they compare players across teams and levels fairly.',
    'Minor-league stat lines are much weaker evidence than major-league ones. The app\'s lineup',
    'and value rankings come from OOTP\'s own ratings, which are projections of talent rather than',
    'a record of what the player has done this season — mention that distinction when it matters.',
    '',
    'Name a player in full — first name and surname — the first time you mention him in a reply.',
    'After that, talk about him however you like. The app links names to their cards and files your',
    'advice against the right man, and it can do neither from a surname or a pronoun. This matters',
    'most on exactly the answers worth keeping: a plan for a pitcher is no use filed against nobody.',
    '',
    'The user can see the app around them, so point them at the relevant page when it helps',
    '("the Pitching Staff page has the full bullpen availability").',
  ].join('\n');
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** In a room, which member of staff said it. Absent in a one-to-one thread. */
  speaker?: string;
}

/**
 * What the model has seen, which is not the same as what the window shows.
 *
 * The window keeps prose. The model's transcript also holds every tool call and
 * every row those calls returned — and only the prose used to survive a
 * question. So each new question arrived with the evidence stripped out and the
 * assistant reasoning from its own summary of data it could no longer see,
 * which is how it can describe a man under club control as heading for free
 * agency and then correct itself the moment it is asked to look again.
 *
 * Storing the tool results means it does not have to remember what it read.
 */
const contextPath = (orgId: number, persona: string) =>
  path.join(DATA_DIR, `chat-context-${orgId}${suffix(persona)}.json`);

interface StoredContext {
  /** The visible thread as it stood when this transcript was written. */
  visible: ChatMessage[];
  messages: Anthropic.MessageParam[];
}

/**
 * A ceiling on what gets resent, in characters — roughly 100k tokens, well
 * inside the context window of every model offered. Tool results are the bulk
 * of it, and they are what makes keeping the thread worth anything.
 */
const CONTEXT_CHARS = 400_000;

/**
 * Drops the oldest exchanges once the transcript outgrows its budget.
 *
 * Cuts only immediately before a plain-text user message, because that is the
 * only place the array stays valid: a tool result whose matching tool call has
 * been dropped is a 400 from the API, not a shorter conversation.
 */
export function trimTranscript(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let out = messages;
  while (JSON.stringify(out).length > CONTEXT_CHARS) {
    const cut = out.findIndex(
      (m, i) => i > 0 && m.role === 'user' && typeof m.content === 'string'
    );
    if (cut === -1) break;
    out = out.slice(cut);
  }
  return out;
}

/** True when the client's thread opens with exactly the thread already stored. */
export function continuesThread(stored: ChatMessage[], history: ChatMessage[]): boolean {
  if (stored.length === 0 || history.length < stored.length) return false;
  return stored.every((m, i) => m.role === history[i].role && m.content === history[i].content);
}

/**
 * Appends plain messages, skipping the empty ones an interrupted answer leaves
 * behind and folding a repeated role into the message before it — two user
 * messages in a row is a shape the API will not take.
 */
export function appendPlain(
  messages: Anthropic.MessageParam[],
  tail: readonly ChatMessage[]
): void {
  for (const m of tail) {
    if (m.content.trim().length === 0) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === m.role && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${m.content}`;
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }
}

function stripCachePoints(messages: Anthropic.MessageParam[]): void {
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const block of m.content) delete (block as { cache_control?: unknown }).cache_control;
  }
}

/**
 * Marks the end of the prompt as cacheable before each call.
 *
 * Every call resends the whole conversation, and the conversation now carries
 * the tool results, so the prefix is both the expensive part and the part that
 * never changes. Moving the breakpoint to the end each time means what was
 * cached on the previous call is read back at a tenth of the price and only the
 * new tail is written — which is what makes remembering everything affordable.
 */
function markCachePoint(messages: Anthropic.MessageParam[]): void {
  stripCachePoints(messages);
  const last = messages[messages.length - 1];
  if (!last) return;
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }];
    return;
  }
  const block = last.content[last.content.length - 1];
  if (block) (block as { cache_control?: unknown }).cache_control = { type: 'ephemeral' };
}

/**
 * Drops reasoning blocks before the transcript is stored.
 *
 * They are only required while a tool call is still in flight, and they carry a
 * signature from the model that produced them — which the model selector in
 * Settings makes a liability, since a thread started on one model would come
 * back rejected after the user picks another.
 */
function stripThinking(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  return messages.flatMap((m) => {
    if (m.role !== 'assistant' || typeof m.content === 'string') return [m];
    const content = m.content.filter(
      (b) => b.type !== 'thinking' && b.type !== 'redacted_thinking'
    );
    return content.length > 0 ? [{ ...m, content }] : [];
  });
}

function saveContext(orgId: number, persona: string, ctx: StoredContext): void {
  try {
    fs.writeFileSync(contextPath(orgId, persona), JSON.stringify(ctx));
  } catch {
    // A thread that cannot be written to disk is still worth having in the window
  }
}

function loadContext(orgId: number, persona: string): StoredContext | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(contextPath(orgId, persona), 'utf8')) as StoredContext;
    if (!Array.isArray(parsed?.visible) || !Array.isArray(parsed?.messages)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * One member of staff answering once: run the model, execute whatever tools it
 * asks for, feed the results back, repeat until it answers in plain text.
 *
 * Pulled out of the route so a room can run it once per person in turn.
 */
async function runToolLoop(opts: {
  client: Anthropic | null;
  provider: ProviderId;
  key: string;
  model: string;
  thinking: Anthropic.ThinkingConfigParam | undefined;
  system: Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  send: (event: string, data: unknown) => void;
}): Promise<{ answer: string; refused: boolean }> {
  const { client, provider, key, model, thinking, system, messages, send } = opts;

  /*
   * Another service answers through the adapter in providers.ts, which speaks
   * this same transcript shape at its edges. Anthropic keeps the path below,
   * where the cache points and the thinking parameter belong — neither has an
   * equivalent worth faking elsewhere.
   */
  const elsewhere = toolLoopFor(provider);
  if (elsewhere || !client) {
    if (!elsewhere) throw new Error(`No implementation for provider ${provider}`);
    return elsewhere({
      key,
      model,
      // The cache_control markers are Anthropic's; the text is the prompt
      system: system.map((b) => b.text).join('\n\n'),
      messages,
      tools: TOOLS,
      onText: (delta) => send('text', { delta }),
      onTool: (name) => send('tool', { name }),
      runTool: (name, input) => runTool(name, input),
      onFallback: (notice) => send('notice', { message: notice }),
      maxTurns: 12,
    });
  }

  /*
   * Anthropic from here. A transcript may have been written under another
   * provider, which can leave fields on a block that Anthropic rejects
   * outright — and switching provider is one dropdown away. Stripped here
   * rather than above, because the provider that put them there needs them.
   */
  stripProviderExtras(messages);
  let answer = '';
  for (let turn = 0; turn < 12; turn++) {
    markCachePoint(messages);
    const stream = client.messages.stream({
      model,
      max_tokens: 8000,
      ...(thinking ? { thinking } : {}),
      system,
      tools: TOOLS,
      messages,
    });

    stream.on('text', (delta) => {
      answer += delta;
      send('text', { delta });
    });

    const message = await stream.finalMessage();
    if (message.stop_reason === 'refusal') {
      send('error', { message: 'The model declined to answer that.' });
      return { answer, refused: true };
    }

    messages.push({ role: 'assistant', content: message.content });

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use'
    );
    if (toolUses.length === 0) break;

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const use of toolUses) {
      send('tool', { name: use.name });
      try {
        const output = await runTool(use.name, (use.input ?? {}) as Record<string, unknown>);
        results.push({ type: 'tool_result', tool_use_id: use.id, content: output });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: err instanceof Error ? err.message : String(err),
          is_error: true,
        });
      }
    }
    // All results for one assistant turn go back in a single user message
    messages.push({ role: 'user', content: results });
  }
  return { answer, refused: false };
}

/** At most this many voices in a room: past four it stops being a conversation. */
const ROOM_LIMIT = 4;

chatRoutes.post('/chat', async (req, res) => {
  const {
    messages: history, orgId, persona: personaId, members: memberIds, addressed,
  } = req.body as {
    messages?: ChatMessage[];
    orgId?: number;
    persona?: string;
    members?: string[];
    /** One member the question was aimed at, who then answers alone. */
    addressed?: string;
  };
  if (!tableExists('players')) {
    return res.status(400).json({ error: 'No data imported yet — pick a save first.' });
  }
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: 'No message provided.' });
  }
  const key = getApiKey();
  if (!key) return res.status(401).json({ error: NO_KEY_MESSAGE });

  const team = Number.isFinite(Number(orgId)) ? Number(orgId) : defaultOrgId();
  const roster = personasFor(team);
  const isRoom = String(personaId) === 'room';

  // A club that has fired its scout cannot put one on the phone, so an unknown
  // or vacant seat falls back to the analyst rather than answering as nobody
  const solo = personaById(team, String(personaId ?? 'analyst')) ?? roster[0];
  const room = isRoom
    ? (Array.isArray(memberIds) ? memberIds : [])
        .map((id) => roster.find((p) => p.id === id))
        .filter((p): p is Persona => p !== undefined)
        .slice(0, ROOM_LIMIT)
    : [];
  // Asking for one man by name gets that man, not a chorus — three people
  // answering "I'm not Hal" is the failure this avoids
  const aimedAt = isRoom && addressed ? room.find((p) => p.id === addressed) : undefined;
  const speakers = isRoom ? (aimedAt ? [aimedAt] : room.length > 0 ? room : [roster[0]]) : [solo];

  // Server-sent events: the answer streams in, and tool calls are announced as
  // they happen so the user sees the assistant working rather than a spinner.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const provider = activeProvider();
  const client = provider === 'anthropic' ? new Anthropic({ apiKey: key }) : null;
  const model = aiModel(provider);
  // Only send the thinking parameter to a model the API reports as supporting
  // it. Omitting it is valid everywhere; sending it to a model that does not
  // take it is a 400, and the model is now the user's choice rather than ours.
  const thinking: Anthropic.ThinkingConfigParam | undefined =
    (await supportsAdaptiveThinking(model)) ? { type: 'adaptive' } : undefined;
  const loop = { client, provider, key, model, thinking, send };

  try {
    if (!isRoom) {
      const persona = speakers[0];
      // Resume the stored transcript, tool results and all, when this thread is
      // the one it belongs to. Anything else — a cleared conversation, a thread
      // edited elsewhere — rebuilds from what the client sent.
      const stored = loadContext(team, persona.id);
      const resuming = stored !== null && continuesThread(stored.visible, history);
      const messages: Anthropic.MessageParam[] = resuming ? trimTranscript(stored.messages) : [];
      stripCachePoints(messages);
      appendPlain(messages, resuming ? history.slice(stored.visible.length) : history);

      const system: Anthropic.TextBlockParam[] = [
        { type: 'text', text: systemPrompt(team, persona), cache_control: { type: 'ephemeral' } },
      ];
      const { answer } = await runToolLoop({ ...loop, system, messages });

      // Only a completed answer is stored. A transcript left ending on a tool
      // call whose result never arrived is one the API refuses outright, so a
      // failed turn keeps the last good transcript rather than poisoning it.
      stripCachePoints(messages);
      saveContext(team, persona.id, {
        visible: [...history, { role: 'assistant', content: answer }],
        messages: stripThinking(messages),
      });
      send('done', {});
      return;
    }

    /*
     * A room. Each person answers in turn and can see what colleagues have
     * already said this turn, which is the whole point — the trainer's view of
     * a pitcher coming back is worth more next to the pitching coach's, and
     * worth most when one of them says the other is wrong.
     *
     * Rooms rebuild from the visible thread each turn rather than resuming a
     * stored transcript. Keeping one per speaker per room composition is more
     * bookkeeping than it is worth, and everyone still calls tools fresh, so
     * nothing here is answered from memory.
     */
    const saidThisTurn: Array<{ name: string; role: string; text: string }> = [];
    for (const person of speakers) {
      send('speaker', { id: person.id, name: person.name, role: person.role });

      const messages: Anthropic.MessageParam[] = [];
      appendPlain(
        messages,
        history.map((m) =>
          m.role === 'assistant' && m.speaker
            ? { ...m, content: `${m.speaker}: ${m.content}` }
            : m
        )
      );
      if (saidThisTurn.length > 0) {
        messages.push({
          role: 'user',
          content:
            'Others in the room have already answered:\n\n' +
            saidThisTurn.map((s) => `${s.name} (${s.role}):\n${s.text}`).join('\n\n') +
            '\n\nGive your own view. Where you agree, say so briefly and add what they missed ' +
            'rather than repeating them. Where you disagree, say so plainly and name the man ' +
            'you are disagreeing with.',
        });
      }

      const others = speakers.filter((p) => p.id !== person.id);
      const system: Anthropic.TextBlockParam[] = [
        {
          type: 'text',
          text:
            systemPrompt(team, person) +
            `\n\nYou are in a room with the general manager` +
            (others.length > 0
              ? ` and ${others.map((o) => `${o.name} (${o.role})`).join(', ')}`
              : '') +
            '. This is a discussion rather than a memo: keep it short, speak only to the part ' +
            'that is properly yours, and do not summarise what the others cover.' +
            (aimedAt
              ? ' The general manager has asked you directly by name, so answer it yourself ' +
                'rather than saying whose call it is — he already knows, which is why he asked you.'
              : '') +
            ' You may be joining a conversation already under way; read what has been said before ' +
            'adding to it, and do not reintroduce yourself or restate ground already covered.',
          cache_control: { type: 'ephemeral' },
        },
      ];

      const { answer, refused } = await runToolLoop({ ...loop, system, messages });
      saidThisTurn.push({ name: person.name, role: person.role, text: answer });
      if (refused) break;
    }
    send('done', {});
  } catch (err) {
    const e = err as Error & { status?: number };
    const message =
      e.status === 401 || /api key|authentication/i.test(e.message) ? NO_KEY_MESSAGE : e.message;
    send('error', { message });
  } finally {
    res.end();
  }
});
