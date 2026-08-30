import { db, hasColumns, tableExists } from './db.js';
import { DATE_KEY } from './dashboard.js';
import { padDate } from './rosterops.js';
import { parseSummary, plainSummary, type Segment } from './transactions.js';

/**
 * The two things a player card was missing, and one it had but barely said.
 *
 * "On the player cards could you include a brief scouting report transactions
 * and contract info?"
 *
 * The contract was there — a bare salary schedule. The other two were not, and
 * one of them cannot be, in the form the request implies: OOTP exports no
 * scouting prose at all. A hundred and sixteen columns on the players table and
 * not one of them is a sentence about anybody.
 *
 * So the report is composed rather than quoted, from the man's own ratings
 * graded against the league he plays in — which is the only kind this app
 * should be writing anyway. Every line carries the number behind it, for the
 * same reason every recommendation here does: a verdict without its arithmetic
 * is something a reader has to take on trust, and there is no reason to.
 */

/**
 * How a rating ranks among the men he is actually up against.
 *
 * Not among everybody the export knows about, which was the first version and
 * badly wrong: `players_batting` carries a hundred and thirty-three thousand
 * rows across every league and every age, and its median contact rating is 20.
 * Against that population a contact grade of 50 came out at the 99th
 * percentile and a 40 at the 96th — which would have told a reader that an
 * ordinary major-league bat was one of the best in the world.
 *
 * Against major-league position players the same two grades are 80th and 71st.
 * That is the comparison a scouting line means, and it is the same mistake this
 * app has had to fix elsewhere: a number from one level presented as though it
 * came from another.
 *
 * Pitchers are excluded from the batting population and everybody else from the
 * pitching one, because a pitcher's contact rating is not a hitter he competes
 * with.
 */
const peerCache = new Map<string, number[]>();

function peerGroup(table: string, column: string, level: number, pitchers: boolean): number[] {
  const key = `${table}.${column}.${level}.${pitchers}`;
  if (!peerCache.has(key)) {
    try {
      peerCache.set(
        key,
        (
          db
            .prepare(
              `SELECT r."${column}" AS v
               FROM "${table}" r
               JOIN players p ON p.player_id = r.player_id
               JOIN teams t ON t.team_id = p.team_id
               WHERE t.level = ? AND p.retired = 0
                 AND r."${column}" IS NOT NULL AND r."${column}" > 0
                 AND p.position ${pitchers ? '=' : '!='} 1
               ORDER BY r."${column}"`
            )
            .all(level) as Array<{ v: number }>
        ).map((r) => r.v)
      );
    } catch {
      peerCache.set(key, []);
    }
  }
  return peerCache.get(key)!;
}

/**
 * Where a value falls in a sorted population, as a percentile.
 *
 * Ties count half, which is not a nicety. Scouting grades are coarse — whole
 * fives, and most of a league shares a handful of them — so counting only the
 * men strictly below puts everybody on the commonest grade at the bottom of
 * the distribution. In a population where every man is a 40, a 40 came out at
 * the 0th percentile and was reported as a weakness.
 */
function rankIn(all: number[], value: number): number | null {
  if (all.length < 20) return null; // too few to rank anybody against
  const below = lowerBound(all, value);
  const atOrBelow = upperBound(all, value);
  const ties = atOrBelow - below;
  return Math.round(((below + ties / 2) / all.length) * 100);
}

/** First index whose value is >= v. */
function lowerBound(all: number[], v: number): number {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index whose value is > v. */
function upperBound(all: number[], v: number): number {
  let lo = 0;
  let hi = all.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (all[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function clearScoutingCache(): void {
  peerCache.clear();
}

/**
 * The makeup ratings OOTP keeps and no screen here showed.
 *
 * They sit on an index around a hundred — the median of every one of them in
 * my own save is between 95 and 107 — so they are reported as a rank rather
 * than as the raw number, which means nothing to a reader on its own.
 */
const MAKEUP: Array<{ column: string; high: string; low: string }> = [
  { column: 'personality_work_ethic', high: 'works hard', low: 'poor work ethic' },
  { column: 'personality_leader', high: 'a leader in the room', low: 'no leadership to speak of' },
  { column: 'personality_intelligence', high: 'reads the game well', low: 'low baseball intelligence' },
  { column: 'personality_greed', high: 'money matters to him', low: 'not motivated by money' },
  { column: 'personality_loyalty', high: 'loyal to the club', low: 'little loyalty to the club' },
];

/** Ranks past these are worth remarking on; between them a man is unremarkable. */
const NOTABLE_HIGH = 75;
const NOTABLE_LOW = 25;

export interface ScoutingReport {
  /** Tools that stand out either way, best first, each with its rank. */
  tools: Array<{ label: string; rank: number; grade: number; good: boolean }>;
  makeup: string[];
  /** Who the ranks are against, so the reader knows what a percentile means. */
  peers: string | null;
  /** Said plainly where there is nothing to say. */
  empty: boolean;
}

const BAT_TOOLS: Array<[string, string]> = [
  ['Contact', 'batting_ratings_overall_contact'],
  ['Gap power', 'batting_ratings_overall_gap'],
  ['Power', 'batting_ratings_overall_power'],
  ['Eye', 'batting_ratings_overall_eye'],
  ['Avoiding strikeouts', 'batting_ratings_overall_strikeouts'],
];
const ARM_TOOLS: Array<[string, string]> = [
  ['Stuff', 'pitching_ratings_overall_stuff'],
  ['Movement', 'pitching_ratings_overall_movement'],
  ['Control', 'pitching_ratings_overall_control'],
];

const LEVEL_LABEL: Record<number, string> = {
  1: 'major-league', 2: 'Triple-A', 3: 'Double-A', 4: 'Single-A', 5: 'Single-A', 6: 'rookie-ball',
};

/** 22nd, not 22th. */
const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
};

export function scoutingReport(playerId: number, isPitcher: boolean): ScoutingReport {
  const empty: ScoutingReport = { tools: [], makeup: [], peers: null, empty: true };
  const level = (
    db
      .prepare(
        `SELECT t.level FROM players p JOIN teams t ON t.team_id = p.team_id
         WHERE p.player_id = ?`
      )
      .get(playerId) as { level: number } | undefined
  )?.level;
  if (level === undefined) return empty;

  const tools: ScoutingReport['tools'] = [];
  const table = isPitcher ? 'players_pitching' : 'players_batting';
  const list = isPitcher ? ARM_TOOLS : BAT_TOOLS;

  if (tableExists(table)) {
    const row = db.prepare(`SELECT * FROM "${table}" WHERE player_id = ?`).get(playerId) as
      | Record<string, number>
      | undefined;
    for (const [label, column] of list) {
      if (!row || !hasColumns(table, column)) continue;
      const grade = row[column];
      if (grade === null || grade === undefined || grade <= 0) continue;
      const rank = rankIn(peerGroup(table, column, level, isPitcher), grade);
      if (rank === null) continue;
      if (rank >= NOTABLE_HIGH || rank <= NOTABLE_LOW) {
        tools.push({ label, rank, grade, good: rank >= NOTABLE_HIGH });
      }
    }
  }
  // Best first, then worst — a report reads as what he is before what he is not
  tools.sort((a, b) => b.rank - a.rank);

  const makeup: string[] = [];
  if (hasColumns('players', ...MAKEUP.map((m) => m.column))) {
    const row = db
      .prepare(
        `SELECT ${MAKEUP.map((m) => m.column).join(', ')} FROM players WHERE player_id = ?`
      )
      .get(playerId) as Record<string, number> | undefined;
    for (const m of MAKEUP) {
      const v = row?.[m.column];
      if (v === null || v === undefined || v <= 0) continue;
      const rank = rankIn(peerGroup('players', m.column, level, isPitcher), v);
      if (rank === null) continue;
      if (rank >= NOTABLE_HIGH) makeup.push(`${m.high} (${ordinal(rank)})`);
      else if (rank <= NOTABLE_LOW) makeup.push(`${m.low} (${ordinal(rank)})`);
    }
  }

  const peers = `${LEVEL_LABEL[level] ?? `level ${level}`} ${isPitcher ? 'pitchers' : 'position players'}`;
  return { tools, makeup, peers, empty: tools.length === 0 && makeup.length === 0 };
}

export interface PlayerTransaction {
  date: string | null;
  kind: 'trade' | 'signing' | 'waiver';
  summary: Segment[];
  plain: string;
}

/**
 * How he got here, and what has happened to him since.
 *
 * The same two sources the league-wide page reads, asked about one man. Trades
 * spread a player across twenty columns, so he is looked for in all of them.
 */
export function playerTransactions(playerId: number, limit = 12): PlayerTransaction[] {
  const out: PlayerTransaction[] = [];

  if (tableExists('trade_history') && hasColumns('trade_history', 'date', 'summary')) {
    // Ten a side is what a full export carries; a leaner one carries fewer, and
    // naming a column that is not there costs the whole player card
    const columns = Array.from({ length: 10 }, (_, i) => [
      `player_id_0_${i}`,
      `player_id_1_${i}`,
    ])
      .flat()
      .filter((c) => hasColumns('trade_history', c));
    if (columns.length === 0) return out;
    const rows = db
      .prepare(
        `SELECT date, summary FROM trade_history
         WHERE ${columns.map((c) => `${c} = ?`).join(' OR ')}
         ORDER BY ${DATE_KEY('date')} DESC LIMIT ?`
      )
      .all(...columns.map(() => playerId), limit) as Array<{ date: string; summary: string }>;
    for (const r of rows) {
      const raw = String(r.summary ?? '');
      out.push({
        date: padDate(r.date),
        kind: 'trade',
        summary: parseSummary(raw),
        plain: plainSummary(raw),
      });
    }
  }

  if (tableExists('messages') && hasColumns('messages', 'subject', 'date', 'message_type', 'player_id_0')) {
    const traded = new Set(
      tableExists('trade_history')
        ? (db.prepare(`SELECT message_id FROM trade_history`).all() as Array<{ message_id: number }>)
            .map((m) => m.message_id)
        : []
    );
    const rows = db
      .prepare(
        `SELECT message_id, subject, date FROM messages
         WHERE player_id_0 = ? AND message_type IN (1, 2) AND COALESCE(deleted, 0) = 0
         ORDER BY ${DATE_KEY('date')} DESC LIMIT ?`
      )
      .all(playerId, limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (traded.has(Number(r.message_id))) continue;
      const subject = String(r.subject ?? '');
      out.push({
        date: padDate(r.date),
        kind: /waiv|claim/i.test(subject) ? 'waiver' : 'signing',
        summary: parseSummary(subject),
        plain: plainSummary(subject),
      });
    }
  }

  return out
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')))
    .slice(0, limit);
}
