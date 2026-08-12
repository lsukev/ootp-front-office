import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { DATA_DIR } from './config.js';
import { activeProvider, aiModel, getApiKey } from './settings.js';
import { describeError, providerFor, type FallbackNotice } from './providers.js';
import { computeProspects } from './org.js';
import { computeContracts } from './contracts.js';
import { LEVEL_NAMES, currentGameDate, seasonYear, teamFinances, rulesBriefing } from './valuation.js';
import { jobStatus, startJob } from './jobs.js';

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
  /** Set when the chosen model could not be used and another answered. */
  notice?: FallbackNotice | null;
}

const cachePath = (orgId: number) => path.join(DATA_DIR, `storylines-${orgId}.json`);

/** Everything the AI needs to write about this org, in one compact object. */
export function assembleContext(orgId: number) {
  const team = db
    .prepare(
      `SELECT team_id, name, nickname, league_id, division_id, sub_league_id, level FROM teams WHERE team_id = ?`
    )
    .get(orgId) as
    | { team_id: number; name: string; nickname: string; league_id: number; division_id: number; sub_league_id: number; level: number }
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

  /*
   * Season leaders on the club, at the club's own level.
   *
   * The level filter is the whole point. A career line carries a row per level
   * a man has played at this year, and summing them blends a call-up's work in
   * Triple-A into his major-league numbers — Ryan Weathers reads as a 4.91 ERA
   * that is neither his 5.89 up here nor his 3.34 down there. Worse, a
   * storyline then set that against a team-mate who never left, which a reader
   * reported: two lines side by side, one of them not what it claimed to be.
   */
  const year = seasonYear(team.league_id);
  const level = team.level ?? 1;
  const levelName = LEVEL_NAMES[level] ?? `level ${level}`;
  const batLeaders = db
    .prepare(
      `SELECT p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.hr) AS hr, SUM(s.rbi) AS rbi,
              SUM(s.sb) AS sb, SUM(s.bb) AS bb, SUM(s.k) AS k, ROUND(SUM(s.war), 1) AS war
       FROM players p JOIN players_career_batting_stats s ON s.player_id = p.player_id
       WHERE p.team_id = ? AND s.year = ? AND s.split_id = 1 AND s.level_id = ? AND p.position != 1
       GROUP BY p.player_id HAVING SUM(s.pa) >= 20 ORDER BY SUM(s.war) DESC LIMIT 8`
    )
    .all(orgId, year, level) as Array<Record<string, unknown>>;
  const pitchLeaders = db
    .prepare(
      `SELECT p.first_name || ' ' || p.last_name AS name, p.age, p.role,
              SUM(s.outs) / 3.0 AS ip, SUM(s.er) AS er, SUM(s.k) AS k, SUM(s.bb) AS bb,
              SUM(s.w) AS w, SUM(s.l) AS l, SUM(s.s) AS sv, ROUND(SUM(s.war), 1) AS war
       FROM players p JOIN players_career_pitching_stats s ON s.player_id = p.player_id
       WHERE p.team_id = ? AND s.year = ? AND s.split_id = 1 AND s.level_id = ?
       GROUP BY p.player_id HAVING SUM(s.outs) >= 15 ORDER BY SUM(s.war) DESC LIMIT 8`
    )
    .all(orgId, year, level) as Array<Record<string, unknown>>;

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
    /*
     * Labelled, not merely filtered. The prospects below carry minor-league
     * lines by their nature, so the model is shown which level each set of
     * numbers belongs to rather than left to assume they are comparable.
     */
    statsLevel: levelName,
    battingLeaders: { level: levelName, players: batLeaders },
    pitchingLeaders: {
      level: levelName,
      players: pitchLeaders.map((p) => ({
        ...p,
        era: (p.ip as number) > 0 ? Number((((p.er as number) / (p.ip as number)) * 9).toFixed(2)) : null,
      })),
    },
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

/*
 * Structured output takes a deliberately small slice of JSON Schema. Length and
 * count keywords are not among it: `minItems` above 1 is rejected outright, and
 * a rejected schema fails the whole request rather than degrading, which turned
 * a page that sometimes read "placeholder" into one that would not generate at
 * all.
 *
 * So the shape is declared here and the standards are stated in the
 * descriptions, where the model reads them. What actually enforces them is
 * usableStoryline below, after the response arrives — the only check that
 * cannot be refused by the API.
 */
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
          headline: {
            type: 'string' as const,
            description:
              'A specific headline naming real players, numbers or dates from the data. At least ' +
              'a dozen characters, never filler or placeholder text.',
          },
          body: {
            type: 'string' as const,
            description:
              'Two to four sentences citing figures from the data provided, at least eighty ' +
              'characters. Never write filler or placeholder text — if there is nothing to say ' +
              'about a category, omit it and write about another.',
          },
        },
        required: ['category', 'headline', 'body'],
        additionalProperties: false,
      },
    },
  },
  required: ['storylines'],
  additionalProperties: false,
};

/**
 * Filler the model sometimes emits when it has nothing to say.
 *
 * A user reported a page reading "placeholder" over and over. The schema was
 * satisfied — a string is a string — so nothing downstream objected, and the
 * empty result was written to the cache, which meant regenerating returned it
 * again. Content this thin is now rejected before it can be stored.
 */
const FILLER = /^\s*(placeholder|lorem ipsum|tbd|todo|n\/a|example|headline|body)\b/i;

export { STORYLINE_SCHEMA };

/** Why an entry was thrown away, or null when it was kept. */
export function storylineFault(s: Storyline): string | null {
  if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string') return 'malformed';
  if (FILLER.test(s.headline)) return 'filler headline';
  if (FILLER.test(s.body)) return 'filler body';
  if (s.headline.trim().length < 10) return `headline too short (${s.headline.trim().length})`;
  if (s.body.trim().length < 60) return `body too short (${s.body.trim().length})`;
  return null;
}

export function usableStoryline(s: Storyline): boolean {
  return storylineFault(s) === null;
}

async function generateStorylines(orgId: number): Promise<StorylineCache> {
  const context = assembleContext(orgId);
  const provider = activeProvider();
  const key = getApiKey(provider);
  if (!key) throw Object.assign(new Error('missing-api-key'), { status: 401 });

  let notice: FallbackNotice | null = null;
  /*
   * Translated here rather than at the route: the failure is recorded on the
   * background job and read back long after this call, so a raw response body
   * would be what the page eventually showed.
   */
  const text = await providerFor(provider).complete({
    key,
    model: aiModel(provider),
    maxTokens: 16000,
    schema: STORYLINE_SCHEMA,
    onFallback: (n) => { notice = n; },
    system:
      // The league is a simulation and the events are the save's, not the
      // world's. Saying so plainly is both accurate and necessary: without it
      // the request reads as inventing news about real, named public figures,
      // and the model has good reason to decline that. The assistant's own
      // prompt has always carried this framing and has never refused; this one
      // never did, and refused.
      `You are the in-universe beat writer for the ${context.organization} in a saved game of Out ` +
      `of the Park Baseball — a text simulation. Everything below happened inside this player's ` +
      `save file: the standings, the statistics, the injuries and the contracts are all outcomes ` +
      `the simulation generated, and they do not correspond to real events. The names come from ` +
      `the game's database. Write about the simulated season only, entirely from the numbers ` +
      `provided, and never about anything outside the save.\n\n` +
      `Write sharp, engaging storylines from the perspective of the club's front office, like a ` +
      `team-site feature page. Ground every claim in the data given (records, stats, prospects, ` +
      `contracts) and cite the figures. Be opinionated where the data supports it: who is earning ` +
      `a promotion, which contract decisions loom, what the recent results mean. Treat small ` +
      `samples with caution. Do not invent quotations or attribute statements to anyone — you are ` +
      `describing what the numbers show, not reporting interviews.\n\n` +
      `Write 6-8 storylines across a mix of categories. Every headline and body must be about this ` +
      `club and cite figures from the data — never filler, placeholder or example text. If a ` +
      `category has nothing behind it, leave it out and write about one that does.\n\n` +
      `LEAGUE RULES: ${context.leagueRules} Write within these rules — this may not be the modern game.`,
    messages: [
      {
        role: 'user',
        content:
          `Today is ${context.gameDate} of the ${context.seasonYear} season. Here is the current organizational ` +
          `data:\n\n${JSON.stringify(context, null, 1)}\n\nWrite the storylines.`,
      },
    ],
  }).catch((err: unknown) => {
    throw new Error(describeError(provider, err));
  });

  let parsed: { storylines?: Storyline[] };
  try {
    parsed = JSON.parse(text) as { storylines?: Storyline[] };
  } catch {
    console.error('[storylines] response was not JSON:', text.slice(0, 2000));
    throw new Error(
      `${aiModel()} returned something that was not JSON. The raw reply is in the app's log.`
    );
  }

  const returned = Array.isArray(parsed.storylines) ? parsed.storylines : [];
  const storylines = returned.filter(usableStoryline);

  /*
   * Nothing worth reading is not worth keeping: caching it would hand the same
   * empty page back to anyone who pressed the button again.
   *
   * The message says what actually happened rather than guessing at a cause.
   * Three faults here in a row were diagnosed by reasoning from a one-line
   * error, and each guess was wrong; the response itself is the only thing
   * that settles it, so a rejected batch reports how many came back, why each
   * was dropped, and what the first one said.
   */
  if (storylines.length === 0) {
    const faults = returned.map((s) => storylineFault(s));
    console.error(
      '[storylines]', aiModel(), 'returned', returned.length, 'entries, none usable:',
      JSON.stringify({ faults, sample: returned.slice(0, 2) }, null, 1)
    );
    if (returned.length === 0) {
      throw new Error(
        `${aiModel()} returned a well-formed reply with no storylines in it. ` +
        'Try again, or choose a different model in Settings.'
      );
    }
    const first = returned[0];
    const excerpt = [first?.headline, first?.body]
      .filter((t) => typeof t === 'string')
      .join(' / ')
      .slice(0, 160);
    throw new Error(
      `${aiModel()} returned ${returned.length} storyline${returned.length === 1 ? '' : 's'}, ` +
      `none usable (${[...new Set(faults)].filter(Boolean).join(', ')}). It wrote: "${excerpt}". ` +
      'Trying again, or choosing a different model in Settings, usually clears it.'
    );
  }

  const cache: StorylineCache = {
    generatedAt: new Date().toISOString(),
    gameDate: context.gameDate,
    orgLabel: context.organization,
    storylines,
    notice,
  };
  fs.writeFileSync(cachePath(orgId), JSON.stringify(cache, null, 2));
  return cache;
}

storylineRoutes.get('/storylines/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  const job = jobStatus('storylines', orgId);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(orgId), 'utf8'));
    res.json({ ...cached, job });
  } catch {
    // Null where the body used to be, so a page written before this still
    // reads the absence correctly, with the job alongside it
    res.json({ storylines: null, job });
  }
});

/**
 * Starts a generation and returns at once. The page asks how it is going by
 * polling the GET above, so it can be left and come back to.
 */
storylineRoutes.post('/storylines/:orgId', (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  if (!getApiKey()) {
    return res.status(401).json({
      error: 'No API key set. Open Settings and add your key — you can get one at console.claude.com.',
    });
  }
  const { started, status } = startJob('storylines', orgId, () => generateStorylines(orgId));
  res.json({ started, job: status });
});

/** Used by the importer when the club has asked for this to happen by itself. */
export function startStorylineJob(orgId: number): void {
  startJob('storylines', orgId, () => generateStorylines(orgId));
}
