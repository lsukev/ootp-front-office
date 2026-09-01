import { Router } from 'express';
import { competitiveGamesSql, postseason } from './postseason.js';
import fs from 'node:fs';
import path from 'node:path';
import { db, hasColumns, tableExists } from './db.js';
import { DATA_DIR } from './config.js';
import { DATE_KEY } from './dashboard.js';
import { padDate } from './rosterops.js';
import { activeProvider, aiModel, getApiKey } from './settings.js';
import { describeError, providerFor, type FallbackNotice } from './providers.js';
import { rulesBriefing, seasonYear } from './valuation.js';
import { jobStatus, startJob } from './jobs.js';
import { recentTransactions } from './transactions.js';

export const recapRoutes = Router();

/**
 * Yesterday, around the league.
 *
 * Every other page in this app is about one club — the reader's. A manager
 * playing a season also wants what the morning paper gave him: who won, what
 * it did to the races, and who is out in front of the league in something.
 * OOTP prints the box scores and leaves the reader to assemble the meaning.
 *
 * The whole of the writing is done from numbers gathered here. Nothing is
 * asked of the model that the data does not already contain, and the day it
 * covers is the last one the league actually played rather than "today" —
 * export a save mid-morning and today's games have not happened yet.
 */

interface RecapSection {
  division: string;
  body: string;
}

interface Recap {
  /** One or two sentences over the whole day, before the divisions. */
  summary: string;
  divisions: RecapSection[];
  /** Leaderboard movement and individual milestones. */
  notes: string[];
}

interface RecapCache {
  generatedAt: string;
  /** The day the recap covers, which is the last one played, not the save's today. */
  gameDate: string | null;
  leagueName: string;
  recap: Recap | null;
  notice?: FallbackNotice | null;
}

const cachePath = (orgId: number) => path.join(DATA_DIR, `daily-recap-${orgId}.json`);

const teamLabel = (alias: string) =>
  `CASE WHEN ${alias}.name = ${alias}.nickname THEN ${alias}.name ELSE ${alias}.name || ' ' || ${alias}.nickname END`;

/** The last day this league actually played, which is the day worth writing up. */
export function lastPlayedDate(leagueId: number): string | null {
  const row = db
    .prepare(
      // Postseason days count: this is what stopped the recap dead on the
      // last day of the regular season and left it there
      `SELECT date FROM games g
       WHERE g.league_id = ? AND g.played = 1 AND ${competitiveGamesSql('g', leagueId)}
       ORDER BY ${DATE_KEY('g.date')} DESC LIMIT 1`
    )
    .get(leagueId) as { date: string } | undefined;
  return padDate(row?.date) ?? null;
}

/**
 * Everything that happened on one day, and what the table looked like after it.
 *
 * Deliberately compact. The recap is a page of prose, and handing a model
 * thirty box scores' worth of detail buys nothing it can use — the scores, the
 * records and the standings are what the sentences are made of.
 */
export function assembleDay(orgId: number) {
  const org = db
    .prepare(`SELECT team_id, league_id, name, nickname FROM teams WHERE team_id = ?`)
    .get(orgId) as { team_id: number; league_id: number; name: string; nickname: string } | undefined;
  if (!org) throw new Error('Unknown org');

  const league = db.prepare(`SELECT name FROM leagues WHERE league_id = ?`).get(org.league_id) as
    | { name: string }
    | undefined;

  const date = lastPlayedDate(org.league_id);
  if (!date) throw new Error('No completed games in this league yet — nothing to recap.');

  /*
   * The day's results. Scores come back as away-then-home because that is how
   * a line score reads and how the model should write it; runs0 is the away
   * side and runs1 the home side, the same mapping the schedule page uses.
   */
  const games = db
    .prepare(
      `SELECT ${teamLabel('at2')} AS away, ${teamLabel('ht')} AS home,
              g.runs0 AS awayRuns, g.runs1 AS homeRuns, g.innings,
              at2.team_id AS awayId, ht.team_id AS homeId
       FROM games g
       JOIN teams ht ON ht.team_id = g.home_team
       JOIN teams at2 ON at2.team_id = g.away_team
       WHERE g.league_id = ? AND g.played = 1
         AND ${competitiveGamesSql('g', org.league_id as number)}
         AND ${DATE_KEY('g.date')} = ?`
    )
    // padDate has already normalised the date, so the same key the SQL builds
    // per row can simply be computed once here rather than six placeholders deep
    .all(org.league_id, Number(date.replace(/-/g, ''))) as Array<Record<string, unknown>>;

  /*
   * The table, division by division, named as the league names them. A recap
   * that says "in the NL East" has to have been told what the NL East is —
   * these are the save's own division names, not an assumption about which
   * league this is.
   */
  const rows = db
    .prepare(
      `SELECT ${teamLabel('t')} AS team, t.team_id,
              s.name AS subLeague, d.name AS division,
              r.w, r.l, r.pct, r.gb, r.streak, r.pos
       FROM teams t
       JOIN team_record r ON r.team_id = t.team_id
       LEFT JOIN sub_leagues s ON s.league_id = t.league_id AND s.sub_league_id = t.sub_league_id
       LEFT JOIN divisions d ON d.league_id = t.league_id
                            AND d.sub_league_id = t.sub_league_id
                            AND d.division_id = t.division_id
       WHERE t.league_id = ? AND t.allstar_team = 0
       ORDER BY s.name, d.name, r.pos`
    )
    .all(org.league_id) as Array<Record<string, unknown>>;

  const standings = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const name = [r.subLeague, r.division].filter(Boolean).join(' ') || 'League';
    const list = standings.get(name) ?? [];
    list.push({
      team: r.team, w: r.w, l: r.l, gb: r.gb, streak: r.streak,
      // Whether this club played on the day being written about, so the model
      // is not left guessing why a team is missing from the scores
      playedToday: games.some((g) => g.homeId === r.team_id || g.awayId === r.team_id),
    });
    standings.set(name, list);
  }

  return {
    league: league?.name ?? 'the league',
    seasonYear: seasonYear(org.league_id),
    date,
    readersClub: org.name === org.nickname ? org.name : `${org.name} ${org.nickname}`,
    games: games.map((g) => ({
      away: g.away, awayRuns: g.awayRuns, home: g.home, homeRuns: g.homeRuns,
      // Only worth a mention when it was not nine
      innings: g.innings === 9 ? undefined : g.innings,
    })),
    standings: Object.fromEntries(standings),
    /*
     * Divisions nobody in them played. Worked out here rather than asked of
     * the model: a division that simply vanishes from a recap reads as an
     * omission, and "the NL East was idle" is a fact the games table settles.
     */
    idleDivisions: [...standings.entries()]
      .filter(([, clubs]) => clubs.every((c) => !c.playedToday))
      .map(([name]) => name),
    /*
     * Anything the league did off the field on the day being written up. A
     * reader traded for a Hall of Famer and found the writing had not noticed;
     * a deal is the biggest thing that can happen on a quiet day and it was
     * the one thing the recap could not see.
     */
    transactions: recentTransactions(orgId, 40)
      .filter((t) => t.date === date)
      .map((t) => ({ kind: t.kind, what: t.plain, involvesTheReadersClub: t.yours })),
    leaders: seasonLeaders(org.league_id),
    /*
     * The bracket, once there is one. Null all season, and in October it is
     * the story — a recap that led on a division race while the Division
     * Series was being played would be reading the wrong month.
     */
    postseason: postseason(org.league_id),
    leagueRules: rulesBriefing(org.league_id, orgId),
  };
}

/**
 * Who is out in front of the league, in the categories a recap mentions.
 *
 * Read from this season's own lines rather than `players_league_leader`, which
 * OOTP fills in at the end of a season: mid-July it still holds last year's
 * winners, and "league-leading 30th home run" attached to the wrong man is
 * worse than no note at all.
 */
function seasonLeaders(leagueId: number) {
  if (!tableExists('players_career_batting_stats')) return {};
  const year = seasonYear(leagueId);

  const bat = db
    .prepare(
      `SELECT p.first_name || ' ' || p.last_name AS name, t.abbr AS team,
              SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h, SUM(s.hr) AS hr,
              SUM(s.rbi) AS rbi, SUM(s.sb) AS sb
       FROM players_career_batting_stats s
       JOIN players p ON p.player_id = s.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = 1 AND t.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, leagueId) as Array<Record<string, number | string>>;

  const pitch = tableExists('players_career_pitching_stats')
    ? (db
        .prepare(
          `SELECT p.first_name || ' ' || p.last_name AS name, t.abbr AS team,
                  SUM(s.w) AS w, SUM(s.k) AS k, SUM(s.s) AS sv, SUM(s.er) AS er, SUM(s.outs) AS outs
           FROM players_career_pitching_stats s
           JOIN players p ON p.player_id = s.player_id
           JOIN teams t ON t.team_id = p.team_id
           WHERE s.year = ? AND s.split_id = 1 AND s.level_id = 1 AND t.league_id = ?
           GROUP BY s.player_id`
        )
        .all(year, leagueId) as Array<Record<string, number | string>>)
    : [];

  /*
   * A rate needs a qualifier or the leaderboard is whoever went 3-for-4 in his
   * only start. Counting stats need none — thirty home runs are thirty home
   * runs however many times a man has batted.
   */
  const teamGames =
    ((db.prepare(`SELECT MAX(g) AS g FROM team_record r JOIN teams t ON t.team_id = r.team_id
                  WHERE t.league_id = ? AND t.level = 1`).get(leagueId) as { g: number | null } | undefined)?.g) ?? 0;
  const minPA = Math.round(teamGames * 3.1);
  const minOuts = Math.round(teamGames * 3);

  /*
   * Three deep, and how many of them share the top mark.
   *
   * The first version returned only the ranking, and the model duly wrote
   * "Kyle Schwarber leads MLB with 13 home runs" on a day three men had
   * thirteen. Nothing in the data contradicted it — being first in a sorted
   * list is not the same as leading, and the difference has to be handed over
   * rather than left to be inferred.
   */
  const top = (
    rows: Array<Record<string, number | string>>,
    value: (r: Record<string, number | string>) => number,
    dir: 1 | -1,
    places = 2
  ) => {
    const sorted = [...rows]
      .sort((a, b) => dir * (value(a) - value(b)))
      .map((r) => ({ name: r.name, team: r.team, value: Number(value(r).toFixed(places)) }));
    const best = sorted[0]?.value;
    return {
      top: sorted.slice(0, 3),
      sharedByCount: best === undefined ? 0 : sorted.filter((r) => r.value === best).length,
    };
  };

  const qualifiedBats = bat.filter((r) => (r.pa as number) >= minPA);
  const qualifiedArms = pitch.filter((r) => (r.outs as number) >= minOuts);

  return {
    homeRuns: top(bat, (r) => r.hr as number, -1, 0),
    rbi: top(bat, (r) => r.rbi as number, -1, 0),
    steals: top(bat, (r) => r.sb as number, -1, 0),
    average: top(qualifiedBats, (r) => ((r.ab as number) ? (r.h as number) / (r.ab as number) : 0), -1, 3),
    wins: top(pitch, (r) => r.w as number, -1, 0),
    strikeouts: top(pitch, (r) => r.k as number, -1, 0),
    saves: top(pitch, (r) => r.sv as number, -1, 0),
    era: top(qualifiedArms, (r) => ((r.outs as number) ? ((r.er as number) * 27) / (r.outs as number) : 99), 1, 2),
  };
}

const RECAP_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description:
        'One or two sentences on the day as a whole. Cite something specific that happened.',
    },
    divisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          division: { type: 'string', description: 'The division name exactly as given in the data.' },
          body: {
            type: 'string',
            description:
              'Two to four sentences on this division: who played, what the results did to the ' +
              'race, and where the clubs now stand. Cite scores and games back.',
          },
        },
        required: ['division', 'body'],
        additionalProperties: false,
      },
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Short individual notes — league leaders and milestones, one sentence each, with the figure.',
    },
  },
  required: ['summary', 'divisions', 'notes'],
  additionalProperties: false,
};

export { RECAP_SCHEMA };

/** Filler the model emits when it has nothing to say. Same rule as storylines. */
const FILLER = /^\s*(placeholder|lorem ipsum|tbd|todo|n\/a|example|division|body|summary)\b/i;

export function sectionFault(s: RecapSection): string | null {
  if (!s || typeof s.division !== 'string' || typeof s.body !== 'string') return 'malformed';
  if (FILLER.test(s.division)) return 'filler division';
  if (FILLER.test(s.body)) return 'filler body';
  if (s.body.trim().length < 60) return `body too short (${s.body.trim().length})`;
  return null;
}

export function usableSection(s: RecapSection): boolean {
  return sectionFault(s) === null;
}

async function generateRecap(orgId: number): Promise<RecapCache> {
  const context = assembleDay(orgId);
  const provider = activeProvider();
  const key = getApiKey(provider);
  if (!key) throw Object.assign(new Error('missing-api-key'), { status: 401 });

  let notice: FallbackNotice | null = null;
  const text = await providerFor(provider).complete({
    key,
    model: aiModel(provider),
    maxTokens: 16000,
    schema: RECAP_SCHEMA,
    onFallback: (n) => { notice = n; },
    system:
      /*
       * The same framing storylines needs, and for the same reason: without
       * being told the league is a simulation, the request reads as inventing
       * news about real, named public figures, and a model has good reason to
       * decline that.
       */
      `You are the beat writer for ${context.league} in a saved game of Out of the Park Baseball ` +
      `— a text simulation. Everything below happened inside this player's save file: the scores, ` +
      `the standings and the statistics are outcomes the simulation generated, and they do not ` +
      `correspond to real events. The names come from the game's database. Write about the ` +
      `simulated season only, entirely from the numbers provided.\n\n` +
      `Write the morning recap of yesterday's action across the whole league, the way a wire ` +
      `service would: one short paragraph per division, saying who won, what it did to the race, ` +
      `and where the clubs stand now. Name the score of a game you mention. Use the division names ` +
      `exactly as they appear in the data. Cover every division that had a game. The divisions named ` +
      `in idleDivisions had none at all — leave those out entirely rather than writing that ` +
      `nothing happened in them.\n\n` +
      // October changes what the piece is about, and a model handed a bracket
      // without being told what it means will still write up the division races
      (context.postseason
        ? `THE REGULAR SEASON IS OVER. The postseason block carries the bracket: who is playing ` +
          `whom, in which round, and where each series stands. Write about that — the races and ` +
          `the standings are settled history now, and a recap that leads on them in October is ` +
          `reading the wrong month. Name the round as the data names it.\n\n`
        : '') +
      `Where the transactions list is not empty, those are the day's deals — say what happened and ` +
      `who it involves, and lead with one if it is the biggest thing that happened. Never invent a ` +
      `deal that is not in that list.\n\n` +
      `Then a handful of one-sentence notes on the individual leaders — always with the figure, ` +
      `as in "Paul James hit his league-leading 30th home run". Every category carries ` +
      `sharedByCount: where it is above one, that many men are level at the top, and you must ` +
      `write "shares the league lead" rather than "leads". Never claim a man leads a category the ` +
      `data does not show him alone at the top of.\n\n` +
      `Never invent a result, a statistic or a quotation. Do not attribute statements to anyone. ` +
      `Do not editorialise about clubs that did not play. Write plainly and keep it tight — this ` +
      `is a recap somebody reads over coffee, not a feature.\n\n` +
      `LEAGUE RULES: ${context.leagueRules} Write within these rules — this may not be the modern game.`,
    messages: [
      {
        role: 'user',
        content:
          `Recap the games of ${context.date}, ${context.seasonYear} season. The reader manages the ` +
          `${context.readersClub}, so mention them where they played, but this is a league-wide ` +
          `recap and not a team page.\n\n${JSON.stringify(context, null, 1)}\n\nWrite the recap.`,
      },
    ],
  }).catch((err: unknown) => {
    throw new Error(describeError(provider, err));
  });

  let parsed: Recap;
  try {
    parsed = JSON.parse(text) as Recap;
  } catch {
    console.error('[recap] response was not JSON:', text.slice(0, 2000));
    throw new Error(
      `${aiModel()} returned something that was not JSON. The raw reply is in the app's log.`
    );
  }

  const returned = Array.isArray(parsed?.divisions) ? parsed.divisions : [];
  const divisions = returned.filter(usableSection);

  /*
   * An empty recap is not worth caching: it would be handed straight back to
   * anybody who pressed the button again. The message says what actually came
   * back rather than guessing at a cause — the same lesson the storylines page
   * learned after three wrong diagnoses from a one-line error.
   */
  if (divisions.length === 0) {
    const faults = returned.map((s) => sectionFault(s));
    console.error(
      '[recap]', aiModel(), 'returned', returned.length, 'sections, none usable:',
      JSON.stringify({ faults, sample: returned.slice(0, 2) }, null, 1)
    );
    throw new Error(
      `${aiModel()} returned ${returned.length} division${returned.length === 1 ? '' : 's'}, ` +
      `none usable${faults.length ? ` (${[...new Set(faults)].filter(Boolean).join(', ')})` : ''}. ` +
      'Trying again, or choosing a different model in Settings, usually clears it.'
    );
  }

  const cache: RecapCache = {
    generatedAt: new Date().toISOString(),
    gameDate: context.date,
    leagueName: context.league,
    recap: {
      summary: typeof parsed.summary === 'string' ? parsed.summary : '',
      divisions,
      notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n) => typeof n === 'string' && n.trim().length > 15) : [],
    },
    notice,
  };
  fs.writeFileSync(cachePath(orgId), JSON.stringify(cache, null, 2));
  return cache;
}

recapRoutes.get('/daily-recap/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  const job = jobStatus('recap', orgId);
  /*
   * The day the league has since moved past. A recap of the fourth of July
   * read on the sixth is not wrong, but presenting it without saying so is —
   * the page shows the date it covers and offers to write the new one.
   */
  let latest: string | null = null;
  try {
    const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
      | { league_id: number }
      | undefined;
    if (org && tableExists('games') && hasColumns('games', 'league_id', 'played')) {
      latest = lastPlayedDate(org.league_id);
    }
  } catch {
    // A save that cannot answer simply gets no staleness marker
  }
  try {
    const cached = JSON.parse(fs.readFileSync(cachePath(orgId), 'utf8')) as RecapCache;
    res.json({ ...cached, latestPlayed: latest, stale: Boolean(latest && cached.gameDate !== latest), job });
  } catch {
    res.json({ recap: null, gameDate: null, latestPlayed: latest, stale: false, job });
  }
});

recapRoutes.post('/daily-recap/:orgId', (req, res) => {
  if (!tableExists('games')) return res.status(400).json({ error: 'No data imported yet' });
  const orgId = Number(req.params.orgId);
  if (!getApiKey()) {
    return res.status(401).json({
      error: 'No API key set. Open Settings and add your key — you can get one at console.claude.com.',
    });
  }
  const { started, status } = startJob('recap', orgId, () => generateRecap(orgId));
  res.json({ started, job: status });
});

/** Used by the importer when the club has asked for this to happen by itself. */
export function startRecapJob(orgId: number): void {
  startJob('recap', orgId, () => generateRecap(orgId));
}
