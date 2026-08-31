import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { DATA_DIR } from './config.js';
import { activeProvider, aiModel, getApiKey } from './settings.js';
import { describeError, providerFor, type FallbackNotice } from './providers.js';
import { jobStatus, startJob } from './jobs.js';
import { assembleDay } from './recap.js';
import { assembleContext } from './storylines.js';
import { recentTransactions } from './transactions.js';
import { computeProspects } from './org.js';

export const newspaperRoutes = Router();

/**
 * The league, written up as a paper.
 *
 * The app had two AI news features and they overlapped: storylines wrote about
 * the reader's own club, the daily recap wrote about the league's last day, and
 * neither read as anything a person would sit down with. This is one issue
 * instead — a front page, a lead story, and sections, from one call over
 * everything the other two were gathering separately.
 *
 * Nothing here is new data. The recap already assembled the day's games and
 * the tables; storylines already assembled the club's standings, prospects and
 * contracts; the transactions page already had the wire. What was missing was
 * an editor: something to decide which of it is the front page and which is a
 * paragraph on an inside one, which is exactly the judgement a model can make
 * and a schema cannot.
 *
 * The constraint that makes it worth having is the same one every AI feature
 * in this app carries. It writes from the numbers supplied and invents nothing:
 * no quotations, no attributed opinions, no games that were not played. A
 * newspaper is the most tempting possible place to make something up, which is
 * why the prompt says so four separate times.
 */

interface Story {
  headline: string;
  /** The standfirst — one line under the headline, as a paper prints it. */
  standfirst?: string;
  body: string;
}

interface Section {
  title: string;
  stories: Story[];
}

interface Issue {
  masthead: string;
  lead: Story;
  sections: Section[];
  /** One-line items: the column of shorts every sports page carries. */
  briefs: string[];
}

interface IssueCache {
  generatedAt: string;
  gameDate: string | null;
  leagueName: string;
  issue: Issue | null;
  notice?: FallbackNotice | null;
}

const cachePath = (orgId: number) => path.join(DATA_DIR, `newspaper-${orgId}.json`);

/**
 * Everything an editor would have on the desk.
 *
 * Deliberately assembled from the two existing gatherers rather than a third
 * of its own. A newspaper that disagreed with the recap about yesterday's
 * scores would be worse than no newspaper.
 */
export function assembleIssue(orgId: number) {
  const day = assembleDay(orgId);
  const club = assembleContext(orgId);
  const prospects = computeProspects(orgId) as {
    batters: Array<Record<string, unknown>>;
    pitchers: Array<Record<string, unknown>>;
  };

  const risers = [...prospects.batters, ...prospects.pitchers]
    .filter((p) => p.signal === 'promote' || p.signal === 'blocked')
    .slice(0, 6)
    .map((p) => ({
      name: p.name,
      level: p.levelName,
      position: p.positionName,
      verdict: p.signal,
      why: (p.reasons as string[])?.slice(0, 2).join('; '),
      move: (p.move as { note?: string } | null)?.note ?? null,
    }));

  return {
    league: day.league,
    seasonYear: day.seasonYear,
    date: day.date,
    readersClub: day.readersClub,
    /** Yesterday's scores and the tables they moved. */
    results: day.games,
    standings: day.standings,
    idleDivisions: day.idleDivisions,
    leaders: day.leaders,
    /** The wire: everything the league did off the field lately. */
    transactions: recentTransactions(orgId, 25).map((t) => ({
      date: t.date,
      kind: t.kind,
      what: t.plain,
      involvesTheReadersClub: t.yours,
    })),
    /** The reader's own club, in the depth the old storylines page had. */
    club: {
      name: club.organization,
      divisionStandings: club.divisionStandings,
      recentGames: club.recentGames,
      battingLeaders: club.battingLeaders,
      pitchingLeaders: club.pitchingLeaders,
    },
    farm: risers,
    leagueRules: day.leagueRules,
  };
}

const ISSUE_SCHEMA = {
  type: 'object',
  properties: {
    masthead: {
      type: 'string',
      description:
        "The paper's name. Invent one that suits the league — two or three words, " +
        'the way a real sports section is titled. Never the name of a real publication.',
    },
    lead: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: 'The front page. Six to ten words.' },
        standfirst: { type: 'string', description: 'One sentence under the headline.' },
        body: {
          type: 'string',
          description:
            'Three or four paragraphs on the biggest thing in the league right now, citing the ' +
            'figures it rests on. Separate paragraphs with a blank line.',
        },
      },
      required: ['headline', 'standfirst', 'body'],
      additionalProperties: false,
    },
    sections: {
      type: 'array',
      description:
        'Three to five sections. Use the ones the material supports: the pennant races, the ' +
        "reader's own club, the transaction wire, the farm system, individual performances. " +
        'Leave out any section the data cannot fill.',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          stories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                headline: { type: 'string' },
                body: {
                  type: 'string',
                  description: 'Two to four sentences, every claim carrying its number.',
                },
              },
              required: ['headline', 'body'],
              additionalProperties: false,
            },
          },
        },
        required: ['title', 'stories'],
        additionalProperties: false,
      },
    },
    briefs: {
      type: 'array',
      description: 'Four to eight one-sentence items, each with a figure in it.',
      items: { type: 'string' },
    },
  },
  required: ['masthead', 'lead', 'sections', 'briefs'],
  additionalProperties: false,
};

export { ISSUE_SCHEMA };

/** Filler a model reaches for when it has nothing. Same list as the storylines page. */
const FILLER = /^\s*(placeholder|lorem ipsum|tbd|todo|n\/a|example|headline|body|section|title)\b/i;

export function storyFault(s: Story): string | null {
  if (!s || typeof s.headline !== 'string' || typeof s.body !== 'string') return 'malformed';
  if (FILLER.test(s.headline)) return 'filler headline';
  if (FILLER.test(s.body)) return 'filler body';
  if (s.headline.trim().length < 8) return `headline too short (${s.headline.trim().length})`;
  if (s.body.trim().length < 60) return `body too short (${s.body.trim().length})`;
  return null;
}

export const usableStory = (s: Story): boolean => storyFault(s) === null;

/**
 * What came back from the model, made into an issue — or refused.
 *
 * Kept apart from the request so it can be exercised without one. Every rule
 * here is a way an issue can be worthless while still satisfying the schema,
 * which is the only kind of failure structured output cannot catch for you: a
 * string is a string whether or not it says anything.
 *
 * A missing front page is a refusal rather than a thin paper. Sections and
 * briefs are the opposite — a section the data could not fill is dropped and
 * the issue goes out shorter, because a real desk runs a four-page paper on a
 * quiet Tuesday rather than padding it to six.
 */
export function composeIssue(parsed: Issue | null | undefined, leagueName: string, model = aiModel()): Issue {
  const sections = (Array.isArray(parsed?.sections) ? parsed!.sections : [])
    .map((s) => ({ title: String(s?.title ?? ''), stories: (s?.stories ?? []).filter(usableStory) }))
    .filter((s) => s.title.trim().length > 0 && s.stories.length > 0);

  /*
   * The message reports what actually came back rather than guessing at a
   * cause — the storylines page learned that after three wrong diagnoses from
   * a one-line error.
   */
  if (!parsed?.lead || !usableStory(parsed.lead)) {
    console.error(
      '[newspaper]', model, 'returned no usable lead:',
      JSON.stringify({ fault: storyFault(parsed?.lead as Story), sample: parsed?.lead }, null, 1)
    );
    throw new Error(
      `${model} returned an issue with no front page ` +
      `(${storyFault(parsed?.lead as Story) ?? 'missing'}). ` +
      'Try again, or choose a different model in Settings.'
    );
  }

  return {
    masthead:
      typeof parsed.masthead === 'string' && parsed.masthead.trim().length > 2
        ? parsed.masthead.trim()
        : `${leagueName} Daily`,
    lead: parsed.lead,
    sections,
    // A brief is one sentence; anything shorter than a phrase is a fragment
    // the model left behind rather than an item
    briefs: Array.isArray(parsed.briefs)
      ? parsed.briefs.filter((b) => typeof b === 'string' && b.trim().length > 15)
      : [],
  };
}

async function generateIssue(orgId: number): Promise<IssueCache> {
  const context = assembleIssue(orgId);
  const provider = activeProvider();
  const key = getApiKey(provider);
  if (!key) throw Object.assign(new Error('missing-api-key'), { status: 401 });

  let notice: FallbackNotice | null = null;
  const text = await providerFor(provider).complete({
    key,
    model: aiModel(provider),
    maxTokens: 16000,
    schema: ISSUE_SCHEMA,
    onFallback: (n) => { notice = n; },
    system:
      /*
       * The framing every AI feature here needs. Without being told the league
       * is a simulation, the request reads as inventing news about real, named
       * public figures, and a model has good reason to decline that.
       */
      `You are the sports editor of a daily paper covering ${context.league}, a league inside a ` +
      `saved game of Out of the Park Baseball — a text simulation. Everything below happened in ` +
      `this player's save file: the scores, the standings, the deals and the statistics are ` +
      `outcomes the simulation generated and correspond to no real events. The names come from ` +
      `the game's database. Write about the simulated league only.\n\n` +
      `Put out one issue. A front page lead on the biggest thing in the league, then sections, ` +
      `then a column of shorts. Write like a sports desk: plain, quick, specific. Every claim ` +
      `carries the figure it rests on — a race is so many games, a run is so many starts, a deal ` +
      `is who for whom.\n\n` +
      `Choose the lead yourself. It is whatever the data says is most worth the front page: a ` +
      `race that turned, a deal that changed a contender, a man doing something historic. It ` +
      `does NOT have to be about ${context.readersClub}, and a paper that leads on the reader's ` +
      `club every day is a fanzine.\n\n` +
      `Invent nothing. No quotations, no words in anybody's mouth, no interviews, no injuries ` +
      `not listed, no games not played, no opinions attributed to managers or players. If you ` +
      `want a voice, it is the desk's own and it argues from the numbers given. Where a section ` +
      `has nothing behind it, leave the section out rather than padding it.\n\n` +
      `LEAGUE RULES: ${context.leagueRules} Write within these — this may not be the modern game.`,
    messages: [
      {
        role: 'user',
        content:
          `Today is ${context.date} of the ${context.seasonYear} season. The reader manages the ` +
          `${context.readersClub}. Here is the desk:\n\n${JSON.stringify(context, null, 1)}\n\n` +
          `Write today's issue.`,
      },
    ],
  }).catch((err: unknown) => {
    throw new Error(describeError(provider, err));
  });

  let parsed: Issue;
  try {
    parsed = JSON.parse(text) as Issue;
  } catch {
    console.error('[newspaper] response was not JSON:', text.slice(0, 2000));
    throw new Error(
      `${aiModel()} returned something that was not JSON. The raw reply is in the app's log.`
    );
  }

  const cache: IssueCache = {
    generatedAt: new Date().toISOString(),
    gameDate: context.date,
    leagueName: context.league,
    issue: composeIssue(parsed, context.league),
    notice,
  };
  fs.writeFileSync(cachePath(orgId), JSON.stringify(cache, null, 2));
  return cache;
}

newspaperRoutes.get('/newspaper/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  const job = jobStatus('newspaper', orgId);
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(orgId), 'utf8')) as IssueCache;
    res.json({ ...cached, job });
  } catch {
    res.json({ issue: null, gameDate: null, job });
  }
});

newspaperRoutes.post('/newspaper/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  if (!getApiKey()) {
    return res.status(401).json({
      error: 'No API key set. Open Settings and add your key — you can get one at console.claude.com.',
    });
  }
  const { started, status } = startJob('newspaper', orgId, () => generateIssue(orgId));
  res.json({ started, job: status });
});

/** Used by the importer when the club has asked for this to happen by itself. */
export function startNewspaperJob(orgId: number): void {
  startJob('newspaper', orgId, () => generateIssue(orgId));
}
