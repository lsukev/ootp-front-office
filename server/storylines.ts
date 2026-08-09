import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { DATA_DIR } from './config.js';
import { aiModel, getApiKey } from './settings.js';
import { computeProspects } from './org.js';
import { computeContracts } from './contracts.js';
import { currentGameDate, seasonYear, teamFinances, rulesBriefing } from './valuation.js';

export const storylineRoutes = Router();

interface Storyline {
  category: string;
  headline: string;
  body: string;
}

interface StorylineCache {
  generatedAt: string;
  gameDate: string | null;
  orgLabel: string;
  storylines: Storyline[];
}

const cachePath = (orgId: number) => path.join(DATA_DIR, `storylines-${orgId}.json`);

/** Everything the AI needs to write about this org, in one compact object. */
function assembleContext(orgId: number) {
  const team = db
    .prepare(
      `SELECT team_id, name, nickname, league_id, division_id, sub_league_id FROM teams WHERE team_id = ?`
    )
    .get(orgId) as
    | { team_id: number; name: string; nickname: string; league_id: number; division_id: number; sub_league_id: number }
    | undefined;
  if (!team) throw new Error('Unknown org');
  const label = team.name === team.nickname ? team.name : `${team.name} ${team.nickname}`;

  // Division standings
  const standings = db
    .prepare(
      `SELECT t.name || ' ' || t.nickname AS team, r.w, r.l, r.pos, r.gb, r.streak
       FROM teams t JOIN team_record r ON r.team_id = t.team_id
       WHERE t.league_id = ? AND t.sub_league_id = ? AND t.division_id = ? AND t.level = 1 AND t.allstar_team = 0
       ORDER BY r.pos`
    )
    .all(team.league_id, team.sub_league_id, team.division_id) as Array<Record<string, unknown>>;

  // Last 10 completed games
  const recentGames = db
    .prepare(
      `SELECT g.date, g.runs0, g.runs1, g.innings,
              ht.name || ' ' || ht.nickname AS home, at2.name || ' ' || at2.nickname AS away,
              g.home_team = ? AS is_home
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team
       JOIN teams at2 ON at2.team_id = g.away_team
       WHERE g.played = 1 AND (g.home_team = ? OR g.away_team = ?)
       ORDER BY (
         CAST(substr(g.date, 1, 4) AS INTEGER) * 10000 +
         CAST(substr(g.date, 6, CASE WHEN substr(g.date, 7, 1) = '-' THEN 1 ELSE 2 END) AS INTEGER) * 100 +
         CAST(substr(g.date, 6 + CASE WHEN substr(g.date, 7, 1) = '-' THEN 2 ELSE 3 END) AS INTEGER)
       ) DESC LIMIT 10`
    )
    .all(orgId, orgId, orgId) as Array<Record<string, unknown>>;

  // MLB roster season leaders (batting + pitching)
  const year = seasonYear(team.league_id);
  const batLeaders = db
    .prepare(
      `SELECT p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.hr) AS hr, SUM(s.rbi) AS rbi,
              SUM(s.sb) AS sb, SUM(s.bb) AS bb, SUM(s.k) AS k, ROUND(SUM(s.war), 1) AS war
       FROM players p JOIN players_career_batting_stats s ON s.player_id = p.player_id
       WHERE p.team_id = ? AND s.year = ? AND s.split_id = 1 AND p.position != 1
       GROUP BY p.player_id HAVING SUM(s.pa) >= 20 ORDER BY SUM(s.war) DESC LIMIT 8`
    )
    .all(orgId, year) as Array<Record<string, unknown>>;
  const pitchLeaders = db
    .prepare(
      `SELECT p.first_name || ' ' || p.last_name AS name, p.age, p.role,
              SUM(s.outs) / 3.0 AS ip, SUM(s.er) AS er, SUM(s.k) AS k, SUM(s.bb) AS bb,
              SUM(s.w) AS w, SUM(s.l) AS l, SUM(s.s) AS sv, ROUND(SUM(s.war), 1) AS war
       FROM players p JOIN players_career_pitching_stats s ON s.player_id = p.player_id
       WHERE p.team_id = ? AND s.year = ? AND s.split_id = 1
       GROUP BY p.player_id HAVING SUM(s.outs) >= 15 ORDER BY SUM(s.war) DESC LIMIT 8`
    )
    .all(orgId, year) as Array<Record<string, unknown>>;

  const prospects = computeProspects(orgId);
  const contracts = computeContracts(orgId);

  return {
    organization: label,
    gameDate: currentGameDate(team.league_id),
    seasonYear: year,
    divisionStandings: standings,
    recentGames: recentGames.map((g) => ({
      date: g.date,
      matchup: `${g.away} @ ${g.home}`,
      score: `${g.runs0}-${g.runs1}`,
      innings: g.innings,
      weWereHome: !!g.is_home,
    })),
    battingLeaders: batLeaders,
    pitchingLeaders: pitchLeaders.map((p) => ({
      ...p,
      era: (p.ip as number) > 0 ? Number((((p.er as number) / (p.ip as number)) * 9).toFixed(2)) : null,
    })),
    topProspects: { batters: prospects.batters.slice(0, 6), pitchers: prospects.pitchers.slice(0, 6) },
    contractSituations: (contracts.players as unknown as Array<{ flags: string[]; recommendation: unknown }>)
      .filter(
        (p) =>
          p.flags.includes('expiring') || p.flags.includes('reserve clause') || p.recommendation
      )
      .slice(0, 12),
    finances: teamFinances(orgId),
    leagueRules: rulesBriefing(team.league_id as number, orgId),
  };
}

const STORYLINE_SCHEMA = {
  type: 'object' as const,
  properties: {
    storylines: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          category: {
            type: 'string' as const,
            enum: ['The Club', 'Player Spotlight', 'Down on the Farm', 'Front Office', 'Looking Ahead'],
          },
          headline: { type: 'string' as const },
          body: { type: 'string' as const },
        },
        required: ['category', 'headline', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['storylines'],
  additionalProperties: false,
};

async function generateStorylines(orgId: number): Promise<StorylineCache> {
  const context = assembleContext(orgId);
  const key = getApiKey();
  if (!key) throw Object.assign(new Error('missing-api-key'), { status: 401 });
  const client = new Anthropic({ apiKey: key });

  const response = await client.messages.create({
    model: aiModel(),
    max_tokens: 16000,
    system:
      `You are the beat writer and front-office analyst for the ${context.organization}, an OOTP Baseball franchise. ` +
      `Write sharp, engaging storylines about the organization from the perspective of its front office — like a ` +
      `team-site feature page. Ground every claim in the provided data (records, stats, prospects, contracts). ` +
      `Reference real numbers. Be opinionated where the data supports it: call out who is earning a promotion, ` +
      `which contract decisions loom, what the recent results mean. It is early in the season, so treat small ` +
      `samples with appropriate caution. Write 6-8 storylines covering a mix of categories. ` +
      `LEAGUE RULES: ${context.leagueRules} Write within these rules — this may not be the modern game.`,
    messages: [
      {
        role: 'user',
        content:
          `Today is ${context.gameDate} of the ${context.seasonYear} season. Here is the current organizational ` +
          `data:\n\n${JSON.stringify(context, null, 1)}\n\nWrite the storylines.`,
      },
    ],
    output_config: { format: { type: 'json_schema', schema: STORYLINE_SCHEMA } },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('The model declined to generate storylines for this request.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error('Generation ran out of tokens — try again.');
  }
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') throw new Error('Empty response from model');
  const parsed = JSON.parse(textBlock.text) as { storylines: Storyline[] };

  const cache: StorylineCache = {
    generatedAt: new Date().toISOString(),
    gameDate: context.gameDate,
    orgLabel: context.organization,
    storylines: parsed.storylines,
  };
  fs.writeFileSync(cachePath(orgId), JSON.stringify(cache, null, 2));
  return cache;
}

storylineRoutes.get('/storylines/:orgId', (req, res) => {
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(Number(req.params.orgId)), 'utf8'));
    res.json(cached);
  } catch {
    res.json(null);
  }
});

storylineRoutes.post('/storylines/:orgId', async (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  try {
    const cache = await generateStorylines(Number(req.params.orgId));
    res.json(cache);
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 401 || /api key|authentication/i.test(e.message)) {
      return res.status(401).json({
        error:
          'No Anthropic API key set. Open Settings and add your key — you can get one at console.claude.com.',
      });
    }
    console.error('[storylines] generation failed:', e);
    res.status(500).json({ error: e.message });
  }
});
