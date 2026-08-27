import { Router } from 'express';
import { db, hasColumns, tableExists } from './db.js';
import { DATE_KEY } from './dashboard.js';
import { padDate } from './rosterops.js';

export const transactionRoutes = Router();

/**
 * What the league has been doing.
 *
 * A reader traded for a future Hall of Famer, cut a man to make room, and
 * found that nothing in the app had noticed either. He asked for a
 * transactions section, and for the reason that makes it more than a diary:
 * "so we can watch similar moves we might want to jump on — a player who fits
 * our needs gets waived, released, etc."
 *
 * OOTP exports this and no screen here was reading it. `trade_history` carries
 * every deal in the universe with a written summary, both clubs and every
 * player in it; `messages` carries the signings and the waiver claims, which
 * are not trades and appear nowhere else.
 *
 * Nothing is inferred. Earlier versions of features in this app have tried to
 * work out what happened by comparing one import against the next, and a
 * player who simply changed level looks identical to one who was sold. These
 * are the game's own records of its own transactions.
 */

/** Trades are `messages` rows too; the trade table tells it better. */
const TRADE_MESSAGE = 1;
const SIGNING_MESSAGE = 2;

/**
 * OOTP writes names into its prose as `<Aaron Judge:player#12345>`, so a
 * summary can be printed as text or rendered with every name a link. Broken up
 * here rather than on the page, because the id is the half that matters and it
 * is thrown away by anything that just strips the markup.
 */
export interface Segment {
  text: string;
  kind?: 'player' | 'team';
  id?: number;
}

const MARKUP = /<([^:<>]+):(player|team)#(\d+)>/g;

export function parseSummary(raw: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of raw.matchAll(MARKUP)) {
    if (m.index > at) out.push({ text: raw.slice(at, m.index) });
    out.push({ text: m[1], kind: m[2] as 'player' | 'team', id: Number(m[3]) });
    at = m.index + m[0].length;
  }
  if (at < raw.length) out.push({ text: raw.slice(at) });
  return out;
}

/** The same thing as one line of prose, for the AI and for a narrow column. */
export const plainSummary = (raw: string): string => raw.replace(MARKUP, '$1');

interface Transaction {
  date: string | null;
  dateKey: number;
  kind: 'trade' | 'signing' | 'waiver';
  summary: Segment[];
  plain: string;
  teams: number[];
  players: number[];
  /** True where the reader's own organisation is on either side of it. */
  yours: boolean;
}

/** Every player id column OOTP spreads a trade across: ten a side, both sides. */
const TRADE_PLAYER_COLUMNS = Array.from({ length: 10 }, (_, i) => [
  `player_id_0_${i}`,
  `player_id_1_${i}`,
]).flat();

export function recentTransactions(orgId: number, limit = 200): Transaction[] {
  const out: Transaction[] = [];

  const org = db.prepare(`SELECT league_id FROM teams WHERE team_id = ?`).get(orgId) as
    | { league_id: number }
    | undefined;

  /*
   * Which clubs are the reader's. A trade with his Triple-A affiliate is still
   * his organisation's business, and a man moving between two other clubs'
   * farm systems is not.
   */
  const ours = new Set(
    (
      db
        .prepare(`SELECT team_id FROM teams WHERE team_id = ? OR parent_team_id = ?`)
        .all(orgId, orgId) as Array<{ team_id: number }>
    ).map((t) => t.team_id)
  );

  if (tableExists('trade_history') && hasColumns('trade_history', 'date', 'summary')) {
    const rows = db
      .prepare(
        `SELECT * FROM trade_history ORDER BY ${DATE_KEY('date')} DESC LIMIT ?`
      )
      .all(limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const players = TRADE_PLAYER_COLUMNS.map((c) => Number(r[c] ?? 0)).filter((n) => n > 0);
      const teams = [Number(r.team_id_0 ?? 0), Number(r.team_id_1 ?? 0)].filter((n) => n > 0);
      const raw = String(r.summary ?? '');
      out.push({
        date: padDate(r.date),
        dateKey: dateKey(r.date),
        kind: 'trade',
        summary: parseSummary(raw),
        plain: plainSummary(raw),
        teams,
        players,
        yours: teams.some((t) => ours.has(t)),
      });
    }
  }

  /*
   * Signings and waiver claims. Trades are in this table as well — every one of
   * the 232 in my own save matches a message — so they are excluded by the id
   * the trade table already carries rather than by guessing from the wording.
   */
  if (tableExists('messages') && hasColumns('messages', 'subject', 'date', 'message_type')) {
    const traded = new Set(
      tableExists('trade_history')
        ? (db.prepare(`SELECT message_id FROM trade_history`).all() as Array<{ message_id: number }>)
            .map((m) => m.message_id)
        : []
    );
    const rows = db
      .prepare(
        `SELECT message_id, subject, date, message_type, team_id_0, team_id_1, player_id_0
         FROM messages
         WHERE message_type IN (?, ?) AND COALESCE(deleted, 0) = 0
           ${org ? 'AND (league_id_0 = ? OR league_id_0 IS NULL)' : ''}
         ORDER BY ${DATE_KEY('date')} DESC LIMIT ?`
      )
      .all(...[TRADE_MESSAGE, SIGNING_MESSAGE, ...(org ? [org.league_id] : []), limit]) as Array<
      Record<string, unknown>
    >;
    for (const r of rows) {
      if (traded.has(Number(r.message_id))) continue;
      const subject = String(r.subject ?? '');
      const teams = [Number(r.team_id_0 ?? 0), Number(r.team_id_1 ?? 0)].filter((n) => n > 0);
      const players = [Number(r.player_id_0 ?? 0)].filter((n) => n > 0);
      out.push({
        date: padDate(r.date),
        dateKey: dateKey(r.date),
        // A claim is worth telling apart from a signing: it is a man another
        // club has just let go of, which is the case he asked to be shown
        kind: /waiv|claim/i.test(subject) ? 'waiver' : 'signing',
        summary: parseSummary(subject),
        plain: plainSummary(subject),
        teams,
        players,
        yours: teams.some((t) => ours.has(t)),
      });
    }
  }

  // Newest first, on the date read as a number — OOTP writes them unpadded
  return out.sort((a, b) => b.dateKey - a.dateKey).slice(0, limit);
}

/** `2027-5-9` becomes 20270509, so the ninth stops outranking the twenty-third. */
function dateKey(raw: unknown): number {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(raw ?? '').trim());
  return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : 0;
}

transactionRoutes.get('/transactions/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('teams')) return res.status(400).json({ error: 'No data imported yet' });
  const all = recentTransactions(orgId);
  res.json({
    transactions: all,
    yours: all.filter((t) => t.yours).length,
    /*
     * Said plainly where the export has none. A league that has not traded
     * yet and an app that cannot read trades look identical otherwise.
     */
    available: tableExists('trade_history') || tableExists('messages'),
  });
});
