import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import request from './request.js';
import { isTruncated, parseSummary, plainSummary, recentTransactions } from '../server/transactions.js';
import { IDS, SEASON } from './fixture.js';

/**
 * The league's paperwork.
 *
 * "I just made a deal for a future Hall of Famer. That would be a big deal, but
 * the AI didn't pick up on it anywhere. I wonder if having a transactions
 * section somewhere is a good idea? I also had to make a corresponding move and
 * DFA'd Mike Torrez. I think that may be helpful so we can watch similar moves
 * we might want to jump on — a player who fits our needs gets waived, released,
 * etc."
 *
 * Two wants, and the second is the one that makes it more than a diary: not
 * what I did, but what everybody else did, so an opportunity can be spotted
 * while it is still one.
 *
 * None of it is inferred. OOTP exports `trade_history` with the summary already
 * written, and `messages` with the signings and the claims; no screen here was
 * reading either. Working out what happened by comparing one import against the
 * next would have been the alternative, and a man who changed level looks
 * exactly like one who was sold.
 */

const OTHER_CLUB = IDS.otherMlbTeam;

beforeAll(() => {
  const trade = db.prepare(
    `INSERT INTO trade_history (date, summary, message_id, team_id_0, team_id_1,
                                player_id_0_0, player_id_1_0)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const message = db.prepare(
    `INSERT INTO messages (message_id, subject, date, message_type, team_id_0, team_id_1,
                           player_id_0, league_id_0)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // The reader's own deal, and the same deal as it appears in the news
  trade.run(
    `${SEASON}-6-9`,
    `The <Test Nine:team#${IDS.mlbTeam}> trade 30-year old RHP <Gone Away:player#${IDS.tradedAway}> ` +
      `to the <Other Club:team#${OTHER_CLUB}> for 26-year old LHP <Locked Up:player#${IDS.extended}>.`,
    500, IDS.mlbTeam, OTHER_CLUB, IDS.tradedAway, IDS.extended
  );
  message.run(500, 'Test Nine and Other Club Swap', `${SEASON}-6-9`, 1, IDS.mlbTeam, OTHER_CLUB, IDS.tradedAway, IDS.league);

  /*
   * Dated the twenty-third against a ninth, because OOTP writes dates unpadded
   * and as text the ninth sorts after — this feed is ordered newest first and
   * would have had them the wrong way round.
   */
  trade.run(
    `${SEASON}-6-23`,
    `The <Other Club:team#${OTHER_CLUB}> trade 33-year old 1B <Paid Off:player#${IDS.retainedGuy}> ` +
      `to the <Test Nine:team#${IDS.mlbTeam}>.`,
    501, OTHER_CLUB, IDS.mlbTeam, IDS.retainedGuy, 0
  );
  message.run(501, 'Other Club Deals Paid Off', `${SEASON}-6-23`, 1, OTHER_CLUB, IDS.mlbTeam, IDS.retainedGuy, IDS.league);

  // A claim: a man another club has just let go of, which is the case he asked for
  message.run(600, 'Regular waiver claim finished and executed successfully', `${SEASON}-6-20`, 1,
              OTHER_CLUB, 0, IDS.starter, IDS.league);
  // And an ordinary signing
  message.run(601, 'Other Club, Paid Off Agree to Extension Deal', `${SEASON}-6-18`, 2,
              OTHER_CLUB, 0, IDS.retainedGuy, IDS.league);
});

interface Txn {
  date: string | null; kind: string; plain: string;
  teams: number[]; players: number[]; yours: boolean;
  summary: Array<{ text: string; kind?: string; id?: number }>;
}

const feed = async (): Promise<{ transactions: Txn[]; yours: number; available: boolean }> =>
  request(`/api/transactions/${IDS.mlbTeam}`);

describe('the summary OOTP writes', () => {
  it('is broken into the names it marked up, with their ids', () => {
    // The id is the half that matters and the half that anything merely
    // stripping the markup throws away
    const segs = parseSummary('The <Reds:team#7> trade <Joe Bloggs:player#42> away.');
    expect(segs.map((s) => s.text)).toEqual(['The ', 'Reds', ' trade ', 'Joe Bloggs', ' away.']);
    expect(segs[1]).toMatchObject({ kind: 'team', id: 7 });
    expect(segs[3]).toMatchObject({ kind: 'player', id: 42 });
  });

  it('also reads as a plain sentence, for the AI and a narrow column', () => {
    expect(plainSummary('The <Reds:team#7> sign <Joe Bloggs:player#42>.')).toBe(
      'The Reds sign Joe Bloggs.'
    );
  });

  it('survives a summary with no markup in it at all', () => {
    expect(parseSummary('Nothing to link here.')).toEqual([{ text: 'Nothing to link here.' }]);
  });
});

describe('the feed', () => {
  it('carries the league\'s trades, both sides named', async () => {
    const t = (await feed()).transactions.find((x) => x.plain.includes('Gone Away'));
    expect(t, 'the trade never appeared').toBeDefined();
    expect(t!.kind).toBe('trade');
    expect(t!.teams.sort()).toEqual([IDS.mlbTeam, OTHER_CLUB].sort());
    expect(t!.players).toContain(IDS.tradedAway);
    expect(t!.players).toContain(IDS.extended);
  });

  it('does not print a trade twice because the news carried it too', async () => {
    /*
     * Every trade is a message as well. They are excluded by the id the trade
     * table already holds rather than by guessing from the wording.
     */
    const all = (await feed()).transactions;
    expect(all.filter((x) => x.plain.includes('Gone Away'))).toHaveLength(1);
    expect(all.some((x) => x.plain === 'Test Nine and Other Club Swap')).toBe(false);
  });

  it('tells a waiver claim from a signing', async () => {
    // One is a man somebody has just let go of, which is the whole point
    const all = (await feed()).transactions;
    expect(all.find((x) => /waiver claim/i.test(x.plain))?.kind).toBe('waiver');
    expect(all.find((x) => /Extension Deal/.test(x.plain))?.kind).toBe('signing');
  });

  it('marks the reader\'s own moves and nobody else\'s', async () => {
    const all = (await feed()).transactions;
    expect(all.find((x) => x.plain.includes('Gone Away'))!.yours).toBe(true);
    expect(all.find((x) => /waiver claim/i.test(x.plain))!.yours).toBe(false);
  });

  it('counts the reader\'s moves for the filter to name', async () => {
    const d = await feed();
    expect(d.yours).toBe(d.transactions.filter((t) => t.yours).length);
    expect(d.yours).toBe(2);
  });

  it('runs newest first, by date rather than by spelling', async () => {
    /*
     * The twenty-third against the ninth. OOTP writes dates unpadded and as
     * text the ninth wins — the same fault that put the development page's
     * snapshots in an order with no meaning.
     */
    const all = (await feed()).transactions;
    const ninth = all.findIndex((x) => x.plain.includes('Gone Away'));
    const twentyThird = all.findIndex((x) => x.plain.includes('Paid Off') && x.kind === 'trade');
    expect(twentyThird).toBeLessThan(ninth);
    expect(all[0].date).toBe(`${SEASON}-06-23`);
  });

  it('reports the affiliates as the reader\'s own', async () => {
    // A deal with his Triple-A club is his organisation's business
    const txns = recentTransactions(IDS.mlbTeam);
    expect(txns.length).toBeGreaterThan(0);
    const farmDeal = txns.find((t) => t.teams.includes(IDS.aaaTeam));
    if (farmDeal) expect(farmDeal.yours).toBe(true);
  });
});

const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('what the AI can see', () => {
  it('can ask for the transactions itself', () => {
    // "the AI didn't pick up on it anywhere" — it had no way to
    const chat = read('server/chat.ts');
    expect(chat).toMatch(/name: 'get_transactions'/);
    expect(chat).toMatch(/case 'get_transactions':/);
  });

  it('is handed the day\'s deals when writing the recap', () => {
    // A deal is the biggest thing that can happen on a quiet day
    const recap = read('server/recap.ts');
    expect(recap).toMatch(/recentTransactions\(orgId, 40\)/);
    expect(recap).toMatch(/Never invent a ` \+\s*`deal/s);
  });
});

/**
 * OOTP's summary column stops at 255 characters, mid-word and often mid-tag.
 *
 * "Only issue is it cuts off bigger deals." He was right, and it was not the
 * page doing the cutting — 81 of the 232 summaries in my own save are exactly
 * 255 characters long and 33 of those break inside a name's markup, which is
 * why one of his rows ended at a bare `<Gary Gaetti`: half a tag, rendered as
 * the text it looks like.
 *
 * A big trade is precisely the one worth reading, so the biggest being the one
 * that arrives unreadable is the wrong way round. The columns carry every
 * player on both sides whatever the prose did, so where the prose was cut the
 * sentence is written from them instead.
 */
describe('a summary OOTP cut off', () => {
  const LONG_TRADE = 700;

  beforeAll(() => {
    /*
     * A six-player deal whose prose stops mid-name, exactly as the export
     * delivers one. The last tag is deliberately left open.
     */
    db.prepare(
      `INSERT INTO trade_history (date, summary, message_id, team_id_0, team_id_1,
                                  player_id_0_0, player_id_0_1, player_id_1_0, player_id_1_1)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `${SEASON}-7-1`,
      `The <Test Nine:team#${IDS.mlbTeam}> trade <Reg Ular:player#${IDS.starter}> and ` +
        `<Lefty Swinger:player#${IDS.lefty}> to the <Other Club:team#${OTHER_CLUB}> for ` +
        `<Paid Off:player#${IDS.retainedGuy}> and <Gone Awa`,
      LONG_TRADE, IDS.mlbTeam, OTHER_CLUB,
      IDS.starter, IDS.lefty, IDS.retainedGuy, IDS.tradedAway
    );
  });

  it('knows a summary has been cut', () => {
    expect(isTruncated('x'.repeat(255))).toBe(true);
    expect(isTruncated('The <Reds:team#7> trade <Half A Nam')).toBe(true);
    expect(isTruncated('The <Reds:team#7> sign <Joe Bloggs:player#42>.')).toBe(false);
  });

  it('writes the sentence itself rather than printing half of one', async () => {
    const t = (await feed()).transactions.find((x) => x.plain.includes('Reg Ular'));
    expect(t, 'the trade never appeared').toBeDefined();
    // Every man in the deal, including the one whose name the export lost
    for (const who of ['Reg Ular', 'Lefty Swinger', 'Paid Off', 'Gone Away']) {
      expect(t!.plain, `${who} was dropped from the composed sentence`).toContain(who);
    }
    expect(t!.plain.trimEnd().endsWith('.'), 'the sentence does not finish').toBe(true);
  });

  it('never leaves half a markup tag on screen', async () => {
    /*
     * `<Gary Gaetti` with no closing bracket is what the reader actually saw.
     * Nothing that reaches the page should contain the markup at all.
     */
    for (const t of (await feed()).transactions) {
      expect(t.plain, `raw markup in: ${t.plain}`).not.toMatch(/[<>]/);
    }
  });

  it('still links every name in a sentence it wrote', async () => {
    const t = (await feed()).transactions.find((x) => x.plain.includes('Reg Ular'))!;
    const linked = t.summary.filter((seg) => seg.kind === 'player').map((seg) => seg.id);
    expect(linked).toContain(IDS.starter);
    expect(linked).toContain(IDS.tradedAway);
  });

  it('leaves an intact summary exactly as OOTP wrote it', async () => {
    // Its wording is better than mine wherever it survived
    const t = (await feed()).transactions.find((x) => x.plain.includes('Locked Up'))!;
    expect(t, 'the untouched trade went missing').toBeDefined();
    expect(t.plain).toContain('30-year old RHP Gone Away');
    expect(t.plain).toContain('26-year old LHP Locked Up');
  });
});

/**
 * "It also doesn't show that I claimed Rick Honeycutt off waivers and signed
 * him to a 3 year extension."
 *
 * OOTP records a waiver claim with every id on the row set to zero — no club,
 * no player, no league. The feed was asking for messages in the manager's own
 * league, so the one row that was genuinely his was the one thrown away.
 */
describe('a waiver claim, which names nobody at all', () => {
  const CLAIM = 701;
  const ELSEWHERE = 702;

  beforeAll(() => {
    const message = db.prepare(
      `INSERT INTO messages (message_id, subject, date, message_type, team_id_0, team_id_1,
                             player_id_0, league_id_0, recipient_id)
       VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)`
    );
    // Every id zero, addressed to the manager: his claim
    message.run(CLAIM, 'Rick Honeycutt waiver claim finished and executed successfully',
                `${SEASON}-7-2`, 1, 1);
    // Also in his post, also league-less, but plainly somebody else's business
    message.run(ELSEWHERE, 'Some Body signs with Los Angeles', `${SEASON}-7-3`, 2, 1);
  });

  it('appears at all', async () => {
    const t = (await feed()).transactions.find((x) => x.plain.includes('Honeycutt'));
    expect(t, 'the claim was filtered out by a league it does not name').toBeDefined();
    expect(t!.kind).toBe('waiver');
  });

  it('is counted as the manager\'s own move', async () => {
    /*
     * Nothing on the row says whose it was except who OOTP sent it to, and a
     * claim reported to the manager is his own business by construction.
     */
    const t = (await feed()).transactions.find((x) => x.plain.includes('Honeycutt'))!;
    expect(t.yours).toBe(true);
  });

  it('does not sweep in every signing that lands in his post', async () => {
    /*
     * The same reasoning is deliberately not extended to signings: those name
     * a club, and "X signs with Los Angeles" arrives in his messages without
     * being his.
     */
    const t = (await feed()).transactions.find((x) => x.plain.includes('signs with Los Angeles'))!;
    expect(t, 'the signing vanished').toBeDefined();
    expect(t.yours, 'somebody else\'s free-agent signing was called his').toBe(false);
  });
});
