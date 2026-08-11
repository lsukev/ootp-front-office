import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { HURT_SQL } from './health.js';
import { DATA_DIR } from './config.js';
import { aiModel, getApiKey } from './settings.js';
import { computeProspects } from './org.js';
import { computeContracts } from './contracts.js';
import { tradeContext } from './trade.js';
import { currentGameDate, rulesBriefing, seasonYear, teamFinances } from './valuation.js';

export const aiRoutes = Router();

const NO_KEY_MESSAGE =
  'No Anthropic API key set. Open Settings and add your key — you can get one at console.claude.com.';

function aiErrorStatus(e: Error & { status?: number }): { status: number; message: string } {
  if (e.status === 401 || /api key|authentication/i.test(e.message)) {
    return { status: 401, message: NO_KEY_MESSAGE };
  }
  return { status: 500, message: e.message };
}

async function callOpus(system: string, user: string, maxTokens = 16000): Promise<string> {
  const key = getApiKey();
  if (!key) throw Object.assign(new Error(NO_KEY_MESSAGE), { status: 401 });
  const client = new Anthropic({ apiKey: key });
  const response = await client.messages.create({
    model: aiModel(),
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  const text = response.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Empty response from model');
  return text.text;
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
  try {
    res.json(JSON.parse(fs.readFileSync(briefingPath(Number(req.params.orgId)), 'utf8')));
  } catch {
    res.json(null);
  }
});

aiRoutes.post('/briefing/:orgId', async (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  try {
    const context = briefingContext(orgId);
    const markdown = await callOpus(
      `You are the assistant GM of the ${context.organization} in an OOTP Baseball save, writing the weekly ` +
      `briefing for the GM. LEAGUE RULES: ${context.leagueRules} Everything you advise must fit these rules ` +
      `rather than the modern game. Be direct and decision-oriented: what happened, what needs a decision now, what to ` +
      `watch. Ground everything in the provided data with real numbers. Structure with short markdown headers ` +
      `(## Status, ## Decisions Needed, ## Watch List, ## Recommendation of the Week). Keep it under 500 words.`,
      `Today is ${context.gameDate}, ${context.seasonYear} season. Organizational data:\n\n` +
        JSON.stringify(context, null, 1)
    );
    const cache = {
      generatedAt: new Date().toISOString(),
      gameDate: context.gameDate,
      markdown,
    };
    fs.writeFileSync(briefingPath(orgId), JSON.stringify(cache, null, 2));
    res.json(cache);
  } catch (err) {
    const { status, message } = aiErrorStatus(err as Error);
    if (status === 500) console.error('[briefing] failed:', err);
    res.status(status).json({ error: message });
  }
});

// ── AI trade evaluation ─────────────────────────────────────────────────

aiRoutes.post('/trade/ai-eval', async (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const { sideA, sideB, orgLabel } = req.body as { sideA: number[]; sideB: number[]; orgLabel?: string };
  if (!Array.isArray(sideA) || !Array.isArray(sideB) || sideA.length === 0 || sideB.length === 0) {
    return res.status(400).json({ error: 'Both sides need at least one player' });
  }
  try {
    const orgId = Number((req.body as { orgId?: number }).orgId) || 0;
    const context = tradeContext(orgId, sideA, sideB);
    const verdict = await callOpus(
      `You are the front-office analyst for ${orgLabel ?? 'this club'}, judging a proposed trade in ` +
      `a saved game of Out of the Park Baseball. Everything below comes from that save.\n\n` +
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
      `Answer in short markdown: a one-line **Verdict** (Accept / Reject / Needs a sweetener), then ` +
      `4-6 sentences of reasoning that name players and cite figures, then a suggested adjustment ` +
      `if one would fix it. Under 220 words. Never invent a number that is not below.`,
      JSON.stringify(context, null, 1),
      4000
    );
    res.json({ verdict });
  } catch (err) {
    const { status, message } = aiErrorStatus(err as Error);
    if (status === 500) console.error('[trade-eval] failed:', err);
    res.status(status).json({ error: message });
  }
});
