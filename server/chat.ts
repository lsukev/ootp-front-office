import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { DATA_DIR } from './config.js';
import { aiModel, getApiKey } from './settings.js';
import { supportsAdaptiveThinking } from './models.js';
import { currentGameDate, seasonYear } from './valuation.js';

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
const historyPath = (orgId: number) => path.join(DATA_DIR, `chat-${orgId}.json`);

/** Enough turns to keep the thread coherent without growing without bound. */
const KEEP_TURNS = 40;

chatRoutes.get('/chat-history/:orgId', (req, res) => {
  try {
    const raw = fs.readFileSync(historyPath(Number(req.params.orgId)), 'utf8');
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
    fs.writeFileSync(historyPath(Number(req.params.orgId)), JSON.stringify(body.slice(-KEEP_TURNS)));
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

/** Orients the model in the save so it doesn't have to burn a tool call on basics. */
function systemPrompt(orgId: number): string {
  const team = db
    .prepare(
      `SELECT name, nickname, league_id FROM teams WHERE team_id = ?`
    )
    .get(orgId) as { name: string; nickname: string; league_id: number } | undefined;
  const label = team ? `${team.name} ${team.nickname}`.trim() : 'this club';
  const year = team ? seasonYear(team.league_id) : new Date().getFullYear();
  const date = team ? currentGameDate(team.league_id) : null;

  return [
    'Your name is Peter. You are the front-office analyst inside OOTP Front Office, a desktop',
    'companion app for a saved Out of the Park Baseball league. You are talking to the general',
    'manager, who is your boss. Introduce yourself by name only if asked who you are.',
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
    'Answer like a good analyst talking to a colleague: lead with the answer, then the evidence.',
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
    'The user can see the app around them, so point them at the relevant page when it helps',
    '("the Pitching Staff page has the full bullpen availability").',
  ].join('\n');
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

chatRoutes.post('/chat', async (req, res) => {
  const { messages: history, orgId } = req.body as { messages?: ChatMessage[]; orgId?: number };
  if (!tableExists('players')) {
    return res.status(400).json({ error: 'No data imported yet — pick a save first.' });
  }
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: 'No message provided.' });
  }
  const key = getApiKey();
  if (!key) return res.status(401).json({ error: NO_KEY_MESSAGE });

  const team = Number.isFinite(Number(orgId)) ? Number(orgId) : defaultOrgId();

  // Server-sent events: the answer streams in, and tool calls are announced as
  // they happen so the user sees the assistant working rather than a spinner.
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();
  const send = (event: string, data: unknown): void => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const client = new Anthropic({ apiKey: key });
  const messages: Anthropic.MessageParam[] = history
    .filter((m) => m.content.trim().length > 0)
    .map((m) => ({ role: m.role, content: m.content }));

  const model = aiModel();
  // Only send the thinking parameter to a model the API reports as supporting
  // it. Omitting it is valid everywhere; sending it to a model that does not
  // take it is a 400, and the model is now the user's choice rather than ours.
  const thinking: Anthropic.ThinkingConfigParam | undefined =
    (await supportsAdaptiveThinking(model)) ? { type: 'adaptive' } : undefined;

  try {
    // Manual tool-use loop: run the model, execute whatever tools it asks for,
    // feed the results back, and repeat until it answers in plain text.
    for (let turn = 0; turn < 12; turn++) {
      const stream = client.messages.stream({
        model,
        max_tokens: 8000,
        ...(thinking ? { thinking } : {}),
        system: systemPrompt(team),
        tools: TOOLS,
        messages,
      });

      stream.on('text', (delta) => send('text', { delta }));

      const message = await stream.finalMessage();

      if (message.stop_reason === 'refusal') {
        send('error', { message: 'The model declined to answer that.' });
        break;
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
