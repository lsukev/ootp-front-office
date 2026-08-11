import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { jobStatus, startJob } from './jobs.js';
import { HURT_SQL } from './health.js';
import { DATA_DIR } from './config.js';
import { activeProvider, aiModel, getApiKey } from './settings.js';
import { PROVIDERS, providerFor } from './providers.js';
import { computeProspects } from './org.js';
import { computeContracts } from './contracts.js';
import { tradeContext } from './trade.js';
import { tradeVoice, type Persona } from './staff.js';
import { currentGameDate, rulesBriefing, seasonYear, teamFinances } from './valuation.js';

export const aiRoutes = Router();

/** Names the provider actually selected, since it may not be Anthropic. */
const noKeyMessage = (): string => {
  const p = PROVIDERS.find((x) => x.id === activeProvider());
  return `No ${p?.label ?? 'API'} key set. Open Settings and add your key — you can get one at ${p?.console ?? 'the provider console'}.`;
};

function aiErrorStatus(e: Error & { status?: number }): { status: number; message: string } {
  if (e.status === 401 || /api key|authentication/i.test(e.message)) {
    return { status: 401, message: noKeyMessage() };
  }
  return { status: 500, message: e.message };
}

async function callOpus(
  system: string, user: string, maxTokens = 16000, onFallback?: (n: string) => void
): Promise<string> {
  return callOpusThread(system, [{ role: 'user', content: user }], maxTokens, onFallback);
}

/** The same call, for the places that carry a conversation rather than one turn. */
async function callOpusThread(
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens = 16000,
  onFallback?: (notice: string) => void
): Promise<string> {
  const provider = activeProvider();
  const key = getApiKey(provider);
  if (!key) throw Object.assign(new Error(noKeyMessage()), { status: 401 });
  return providerFor(provider).complete({
    key,
    model: aiModel(provider),
    system,
    messages,
    maxTokens,
    onFallback,
  });
}

// ── GM Briefing ─────────────────────────────────────────────────────────

const briefingPath = (orgId: number) => path.join(DATA_DIR, `briefing-${orgId}.json`);

function briefingContext(orgId: number) {
  const team = db
    .prepare(
      `SELECT name, nickname, league_id, sub_league_id, division_id FROM teams WHERE team_id = ?`
    )
    .get(orgId) as Record<string, unknown>;
  const standings = db
    .prepare(
      `SELECT t.name || ' ' || t.nickname AS team, r.w, r.l, r.pos, r.gb, r.streak
       FROM teams t JOIN team_record r ON r.team_id = t.team_id
       WHERE t.league_id = ? AND t.sub_league_id = ? AND t.division_id = ? AND t.level = 1 AND t.allstar_team = 0
       ORDER BY r.pos`
    )
    .all(team.league_id, team.sub_league_id, team.division_id);
  const prospects = computeProspects(orgId);
  let contracts: unknown = null;
  try {
    const c = computeContracts(orgId);
    contracts = (c.players as unknown[]).slice(0, 15);
  } catch { /* no contract data */ }
  const injuries = db
    .prepare(
      `SELECT p.first_name || ' ' || p.last_name AS name, p.age, p.injury_left AS days_left, t.level
       FROM players p JOIN teams t ON t.team_id = p.team_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.organization_id = ? AND ${HURT_SQL}`
    )
    .all(orgId);
  return {
    organization: `${team.name} ${team.nickname}`,
    gameDate: currentGameDate(team.league_id as number),
    seasonYear: seasonYear(team.league_id as number),
    standings,
    topProspects: { batters: prospects.batters.slice(0, 5), pitchers: prospects.pitchers.slice(0, 5) },
    contractSituations: contracts,
    injuries,
    finances: teamFinances(orgId),
    leagueRules: rulesBriefing(team.league_id as number, orgId),
  };
}

aiRoutes.get('/briefing/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  const job = jobStatus('briefing', orgId);
  try {
    res.json({ ...JSON.parse(fs.readFileSync(briefingPath(orgId), 'utf8')), job });
  } catch {
    res.json({ markdown: null, job });
  }
});

/** The generation itself, so both the route and the importer can start it. */
async function generateBriefing(orgId: number): Promise<void> {
  const context = briefingContext(orgId);
  // A model that had to be swapped is worth saying so on the page rather than
  // only in a log nobody opens
  let notice: string | null = null;
  const markdown = await callOpus(
    `You are the assistant GM of the ${context.organization} in a saved game of Out of the Park ` +
    `Baseball, writing the weekly briefing for the GM. Everything below is from that save — the ` +
    `standings, statistics and contracts are outcomes the simulation generated, and the names come ` +
    `from the game's database. LEAGUE RULES: ${context.leagueRules} Everything you advise must fit ` +
    `these rules rather than the modern game. Be direct and decision-oriented: what happened, what ` +
    `needs a decision now, what to watch. Ground everything in the provided data with real numbers. ` +
    `Structure with short markdown headers (## Status, ## Decisions Needed, ## Watch List, ` +
    `## Recommendation of the Week). Keep it under 500 words.`,
    `Today is ${context.gameDate}, ${context.seasonYear} season. Organizational data:\n\n` +
      JSON.stringify(context, null, 1),
    16000,
    (n) => { notice = n; }
  );
  fs.writeFileSync(
    briefingPath(orgId),
    JSON.stringify(
      { generatedAt: new Date().toISOString(), gameDate: context.gameDate, markdown, notice },
      null,
      2
    )
  );
}

/** Used by the importer when the club has asked for this to happen by itself. */
export function startBriefingJob(orgId: number): void {
  startJob('briefing', orgId, () => generateBriefing(orgId));
}

/**
 * Starts the briefing and returns at once. It takes long enough that holding
 * the request open meant the page had to be watched while it ran.
 */
aiRoutes.post('/briefing/:orgId', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  if (!getApiKey()) {
    return res.status(401).json({ error: 'No API key set. Open Settings and add your key.' });
  }
  const { started, status } = startJob('briefing', orgId, () => generateBriefing(orgId));
  res.json({ started, job: status });
});

// ── AI trade evaluation ─────────────────────────────────────────────────

/**
 * The brief the trade desk answers under, in the voice of the club's own
 * general manager rather than an anonymous "AI". Shared by the first verdict
 * and every reply after it, so the follow-ups do not drift into a different
 * man with different standards halfway down the thread.
 */
function tradeSystem(voice: Persona, orgLabel: string | undefined): string {
  const who =
    voice.name === 'the front office'
      ? `You are the front office of ${orgLabel ?? 'this club'}`
      : `You are ${voice.name}, ${voice.role} of ${orgLabel ?? 'this club'}`;
  return (
    `${who}, judging a proposed trade in a saved game of Out of the Park ` +
    `Baseball. Everything below comes from that save. You are talking to the person who runs ` +
    `this club with you, and you speak as yourself — first person, no preamble, no restating ` +
    `the question.\n\n` +
    (voice.facts.length > 0
      ? `This is who you are; let it colour the read without being recited:\n` +
        voice.facts.map((f) => `- ${f}`).join('\n') + '\n\n'
      : '') +
    `"weGive" leaves the organisation; "weReceive" joins it.\n\n` +
      `Judge the deal as a roster decision, not an exchange of ratings. In particular:\n` +
      `- Say what each man actually is — his position, his role if he pitches, and the level he is ` +
      `playing at. A 48-overall reliever and a 48-overall shortstop are not the same asset.\n` +
      `- Use the season line, and read it against the level it was produced at. OPS+ and ERA+ are ` +
      `scaled so 100 is average for that league, so they compare across levels; the raw rates do ` +
      `not. Say when a sample is too small to mean anything.\n` +
      `- Name who the incoming player would displace. "whoTheyWouldDisplace" lists the men already ` +
      `holding that job on the major-league roster, with their own lines. If he is not better than ` +
      `the man in the job, say so — an upgrade that does not upgrade anything is not one. If he is ` +
      `not major-league ready, say where he actually slots and when he might matter.\n` +
      `- Weigh it against what the club is short of. "clubNeeds" gives the weakest positions and ` +
      `the spare ones: value bought where you are already deep is worth less than the number says.\n` +
      `- Then the ordinary things: age, contract years, salary, and what the money commits you to.\n` +
      `- "totals" holds the same value, talent and salary figures shown on the page beside your ` +
    `answer. Quote those if you quote totals at all, so the two never disagree — but a verdict ` +
    `that is only those totals restated is not worth writing.\n\n` +
    `Never invent a number that is not in the data you are given.`
  );
}

/** The opening verdict's shape. Replies are conversation and are left alone. */
const VERDICT_FORMAT =
  '\n\nAnswer in short markdown: a one-line **Verdict** (Accept / Reject / Needs a sweetener), ' +
  'then 4-6 sentences of reasoning that name players and cite figures, then a suggested ' +
  'adjustment if one would fix it. Under 220 words.';

interface TradeBody {
  orgId?: number;
  sideA?: number[];
  sideB?: number[];
  orgLabel?: string;
  message?: string;
  thread?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

/** Both routes want the same validation and the same context assembly. */
function tradeSetup(body: TradeBody): { orgId: number; voice: Persona; context: unknown } {
  const { sideA, sideB } = body;
  if (!Array.isArray(sideA) || !Array.isArray(sideB) || sideA.length === 0 || sideB.length === 0) {
    throw Object.assign(new Error('Both sides need at least one player'), { status: 400 });
  }
  const orgId = Number(body.orgId) || 0;
  return { orgId, voice: tradeVoice(orgId), context: tradeContext(orgId, sideA, sideB) };
}

/** Who will answer, so the page can put a name on the button before asking. */
aiRoutes.get('/trade/voice/:orgId', (req, res) => {
  const { name, role } = tradeVoice(Number(req.params.orgId));
  res.json({ name, role });
});

aiRoutes.post('/trade/ai-eval', async (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const body = req.body as TradeBody;
  try {
    const { voice, context } = tradeSetup(body);
    let notice: string | null = null;
    const verdict = await callOpus(
      tradeSystem(voice, body.orgLabel) + VERDICT_FORMAT,
      JSON.stringify(context, null, 1),
      4000,
      (n) => { notice = n; }
    );
    res.json({ verdict, voice: { name: voice.name, role: voice.role }, notice });
  } catch (err) {
    const { status, message } = aiErrorStatus(err as Error);
    if (status === 500) console.error('[trade-eval] failed:', err);
    res.status(status).json({ error: message });
  }
});

/**
 * Answering back.
 *
 * A verdict you cannot argue with is a worse tool than one you can — half the
 * value of asking is "what if I keep Caballero out of it". The thread is held
 * by the page rather than on disk: it belongs to the two lists of players
 * currently on screen, and both change with every click.
 */
aiRoutes.post('/trade/ai-reply', async (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const body = req.body as TradeBody;
  if (!body.message?.trim()) return res.status(400).json({ error: 'Nothing to send' });
  try {
    const { voice, context } = tradeSetup(body);
    let notice: string | null = null;
    const history = (body.thread ?? [])
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
      // Enough to keep the argument coherent without resending an hour of it
      .slice(-12);
    const reply = await callOpusThread(
      tradeSystem(voice, body.orgLabel) +
        '\n\nYou have already given your verdict on this deal and are now being asked about it. ' +
        'Answer the question actually put to you, in a few sentences — no headings, and do not ' +
        'restate the verdict unless it has changed. If it has changed, say so plainly.',
      [
        { role: 'user', content: `The deal on the table:\n${JSON.stringify(context, null, 1)}` },
        ...history,
        { role: 'user', content: body.message.trim() },
      ],
      2000,
      (n) => { notice = n; }
    );
    res.json({ reply, voice: { name: voice.name, role: voice.role }, notice });
  } catch (err) {
    const { status, message } = aiErrorStatus(err as Error);
    if (status === 500) console.error('[trade-reply] failed:', err);
    res.status(status).json({ error: message });
  }
});
