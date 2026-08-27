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

/**
 * OOTP's summary column stops at 255 characters, mid-word and often mid-tag.
 *
 * A reader saw a deal end "...and 21-year old minor league" and another end at
 * a bare `<Gary Gaetti`, which is a markup tag cut in half and rendered as the
 * text it looks like. In my own save 81 of 232 summaries are exactly 255 long
 * and 33 of those break inside a tag.
 *
 * A big trade is precisely the one worth reading, so a bigger deal being the
 * one that gets cut is the wrong way round. Where the prose has been cut the
 * sentence is written here instead, from the columns that carry every player
 * on both sides — which the export gives in full whatever the summary did.
 */
const SUMMARY_LIMIT = 255;

export function isTruncated(raw: string): boolean {
  if (raw.length >= SUMMARY_LIMIT) return true;
  // A tag opened and never closed is a cut in the middle of a name
  const opens = (raw.match(/</g) ?? []).length;
  const closes = (raw.match(/>/g) ?? []).length;
  return opens !== closes;
}

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/**
 * The men in a deal, written the way OOTP writes them — "24-year old minor
 * league SS" — so a sentence composed here reads like the ones beside it.
 */
function describePlayers(ids: number[]): Map<number, { name: string; blurb: string }> {
  const out = new Map<number, { name: string; blurb: string }>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              p.throws, t.level
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.player_id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{
    player_id: number; name: string; age: number; position: number; throws: number; level: number | null;
  }>;
  for (const r of rows) {
    const minor = r.level !== null && r.level > 1 ? 'minor league ' : '';
    // OOTP writes a pitcher's hand into the position, and a sentence composed
    // here sits beside ones that came from OOTP
    const pos =
      r.position === 1
        ? `${r.throws === 2 ? 'LHP' : 'RHP'}`
        : POSITION_NAMES[r.position] ?? '';
    out.set(r.player_id, {
      name: r.name,
      blurb: `${r.age}-year old ${minor}${pos}`.replace(/\s+/g, ' ').trim(),
    });
  }
  return out;
}

/** A club, named as the rest of the app names it. */
function teamLabels(ids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (ids.length === 0) return out;
  const rows = db
    .prepare(
      `SELECT team_id, CASE WHEN name = nickname THEN name ELSE name || ' ' || nickname END AS label
       FROM teams WHERE team_id IN (${ids.map(() => '?').join(',')})`
    )
    .all(...ids) as Array<{ team_id: number; label: string }>;
  for (const r of rows) out.set(r.team_id, r.label);
  return out;
}

/**
 * The deal as a sentence, written from the columns rather than read from the
 * prose. Used only where OOTP's own summary was cut off — its wording is
 * better where it survived, and this exists so that a big trade is not the one
 * that arrives unreadable.
 */
function composeTrade(
  row: Record<string, unknown>,
  sideA: number[],
  sideB: number[]
): string {
  const teams = teamLabels([Number(row.team_id_0 ?? 0), Number(row.team_id_1 ?? 0)]);
  const people = describePlayers([...sideA, ...sideB]);
  const a = Number(row.team_id_0 ?? 0);
  const b = Number(row.team_id_1 ?? 0);

  const list = (ids: number[], from: number): string[] => {
    const parts = ids
      .map((id) => {
        const p = people.get(id);
        return p ? `${p.blurb} <${p.name}:player#${id}>` : null;
      })
      .filter((x): x is string => x !== null);
    const picks = [0, 1, 2, 3, 4]
      .map((i) => Number(row[`draft_round_${from === a ? 0 : 1}_${i}`] ?? 0))
      .filter((r) => r > 0)
      .map((r) => `a round-${r} pick`);
    const cash = Number(row[from === a ? 'cash_0' : 'cash_1'] ?? 0);
    if (cash > 0) picks.push(`$${cash.toLocaleString('en-US')}`);
    return [...parts, ...picks];
  };

  const join = (parts: string[]): string =>
    parts.length <= 1
      ? parts[0] ?? 'nothing'
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;

  const teamA = teams.get(a) ? `<${teams.get(a)}:team#${a}>` : 'One club';
  const teamB = teams.get(b) ? `<${teams.get(b)}:team#${b}>` : 'another club';
  const got = list(sideB, b);
  const gave = list(sideA, a);
  return got.length > 0
    ? `The ${teamA} trade ${join(gave)} to the ${teamB} for ${join(got)}.`
    : `The ${teamA} trade ${join(gave)} to the ${teamB}.`;
}

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
      const exported = String(r.summary ?? '');
      const sideA = Array.from({ length: 10 }, (_, i) => Number(r[`player_id_0_${i}`] ?? 0)).filter((n) => n > 0);
      const sideB = Array.from({ length: 10 }, (_, i) => Number(r[`player_id_1_${i}`] ?? 0)).filter((n) => n > 0);
      const raw =
        isTruncated(exported) && (sideA.length > 0 || sideB.length > 0)
          ? composeTrade(r, sideA, sideB)
          : exported;
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
      /*
       * No league filter. A reader claimed a man off waivers and signed him to
       * an extension, and neither appeared: OOTP records a waiver claim with
       * every id on the row set to zero — no club, no player, no league — so a
       * filter asking for his league threw away the one row that was his. The
       * message type is the only thing worth filtering on here.
       */
      .prepare(
        `SELECT message_id, subject, date, message_type, team_id_0, team_id_1, player_id_0,
                recipient_id
         FROM messages
         WHERE message_type IN (?, ?) AND COALESCE(deleted, 0) = 0
         ORDER BY ${DATE_KEY('date')} DESC LIMIT ?`
      )
      .all(TRADE_MESSAGE, SIGNING_MESSAGE, limit) as Array<Record<string, unknown>>;
    for (const r of rows) {
      if (traded.has(Number(r.message_id))) continue;
      const subject = String(r.subject ?? '');
      const teams = [Number(r.team_id_0 ?? 0), Number(r.team_id_1 ?? 0)].filter((n) => n > 0);
      const players = [Number(r.player_id_0 ?? 0)].filter((n) => n > 0);
      // A claim is worth telling apart from a signing: it is a man another
      // club has just let go of, which is the case he asked to be shown
      const claim = /waiv|claim/i.test(subject);
      out.push({
        date: padDate(r.date),
        dateKey: dateKey(r.date),
        kind: claim ? 'waiver' : 'signing',
        summary: parseSummary(subject),
        plain: plainSummary(subject),
        teams,
        players,
        /*
         * A waiver claim names no club at all, so the ordinary test cannot see
         * whose it was. What it does carry is who OOTP sent it to, and a claim
         * reported to the manager is his own business by construction. The
         * same reasoning is NOT extended to signings: those name a club, and
         * "X signs with Los Angeles" arrives in his post without being his.
         */
        yours: teams.some((t) => ours.has(t)) || (claim && Number(r.recipient_id ?? 0) === 1),
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
