import { Router } from 'express';
import { db, tableExists } from './db.js';
import { contractsByPlayer, mlbPercentiler, valuesByPlayer, type PlayerValue } from './valuation.js';
import { padDate } from './rosterops.js';
import { contactProfiles } from './battedball.js';
import { POSITION_CODES, glovesLine } from './gloves.js';
import { computeBatting, computePitching, leagueBaseline } from './stats.js';

export const tradeRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const FIELD_SPOTS = [2, 3, 4, 5, 6, 7, 8, 9];
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

interface OrgProfile {
  orgId: number;
  label: string;
  weakest: Array<{ position: number; positionName: string; bestValue: number }>;
  surplus: Array<{ position: number; positionName: string; players: Array<{ player_id: number; name: string; value: number }> }>;
}

let mlbMedianCache: number | null = null;
function mlbMedianValue(values: Map<number, PlayerValue>): number {
  if (mlbMedianCache !== null) return mlbMedianCache;
  const ids = db
    .prepare(
      `SELECT p.player_id FROM players p JOIN teams t ON t.team_id = p.team_id
       WHERE t.level = 1 AND t.allstar_team = 0 AND p.retired = 0`
    )
    .all() as Array<{ player_id: number }>;
  const vals = ids
    .map((r) => values.get(r.player_id)?.overall)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  mlbMedianCache = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  return mlbMedianCache;
}

/**
 * Positional strength/surplus for one org's MLB club. Surplus requires a
 * quality backup (within 85% of the starter AND above the MLB median) —
 * two equally weak players at a spot is a hole, not depth.
 */
function orgProfile(orgId: number, values: Map<number, PlayerValue>): OrgProfile | null {
  const team = db.prepare(`SELECT ${teamLabel} AS label FROM teams t WHERE team_id = ?`).get(orgId) as
    | { label: string }
    | undefined;
  if (!team) return null;
  const players = db
    .prepare(
      `SELECT player_id, first_name || ' ' || last_name AS name, position
       FROM players WHERE team_id = ? AND retired = 0 AND position != 1`
    )
    .all(orgId) as Array<{ player_id: number; name: string; position: number }>;

  const byPos = new Map<number, Array<{ player_id: number; name: string; value: number }>>();
  for (const p of players) {
    const v = values.get(p.player_id)?.overall ?? 0;
    if (!byPos.has(p.position)) byPos.set(p.position, []);
    byPos.get(p.position)!.push({ player_id: p.player_id, name: p.name, value: v });
  }
  const strength = FIELD_SPOTS.map((pos) => {
    const ps = (byPos.get(pos) ?? []).sort((a, b) => b.value - a.value);
    return { position: pos, positionName: POSITION_NAMES[pos], best: ps[0]?.value ?? 0, players: ps };
  });
  const weakest = [...strength]
    .sort((a, b) => a.best - b.best)
    .slice(0, 3)
    .map((s) => ({ position: s.position, positionName: s.positionName, bestValue: s.best }));
  const median = mlbMedianValue(values);
  const surplus = strength
    .filter((s) => s.players.length >= 2 && s.players[1].value >= Math.max(s.best * 0.85, median))
    .map((s) => ({ position: s.position, positionName: s.positionName, players: s.players.slice(1, 3) }));
  return { orgId, label: team.label, weakest, surplus };
}

tradeRoutes.get('/trade/fits/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_value')) return res.status(400).json({ error: 'No data imported yet' });
  const values = valuesByPlayer();
  const mine = orgProfile(orgId, values);
  if (!mine) return res.status(404).json({ error: 'Unknown org' });

  const otherOrgs = (
    db
      .prepare(
        `SELECT team_id FROM teams WHERE level = 1 AND allstar_team = 0 AND team_id != ?`
      )
      .all(orgId) as Array<{ team_id: number }>
  ).map((r) => r.team_id);

  const myWeak = new Set(mine.weakest.map((w) => w.position));
  const mySurplusPos = new Set(mine.surplus.map((s) => s.position));

  const fits = otherOrgs
    .map((id) => orgProfile(id, values))
    .filter((p): p is OrgProfile => p !== null)
    .map((theirs) => {
      // They're weak where I have surplus; they have surplus where I'm weak
      const theyNeed = theirs.weakest.filter((w) => mySurplusPos.has(w.position));
      const theyOffer = theirs.surplus.filter((s) => myWeak.has(s.position));
      return {
        orgId: theirs.orgId,
        label: theirs.label,
        score: theyNeed.length + theyOffer.length,
        theyNeed: theyNeed.map((w) => ({
          positionName: w.positionName,
          myCandidates: mine.surplus.find((s) => s.position === w.position)?.players ?? [],
        })),
        theyOffer: theyOffer.map((s) => ({ positionName: s.positionName, players: s.players })),
      };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score);

  res.json({ myWeakest: mine.weakest, mySurplus: mine.surplus, fits: fits.slice(0, 10) });
});

tradeRoutes.get('/search-players', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2 || !tableExists('players')) return res.json([]);
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              ${teamLabel} AS team, t.level
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND p.team_id > 0
         AND (p.first_name || ' ' || p.last_name) LIKE ?
       ORDER BY t.level, p.age LIMIT 20`
    )
    .all(`%${q}%`) as Array<Record<string, unknown>>;
  const values = valuesByPlayer();
  res.json(
    rows.map((r) => ({
      ...r,
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      value: values.get(r.player_id as number)?.overall ?? 0,
    }))
  );
});

const LEVEL_NAMES: Record<number, string> = { 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R' };

/**
 * The trade talk sitting in your OOTP inbox.
 *
 * Trade traffic reaches a manager as messages, and the export carries the
 * structured part of them: who wrote, which club, and which player. That is
 * enough to list them — "Would it make sense to target Luis Castillo?" is a
 * question the app can already answer better than the message can.
 *
 * `sender_type = 0` with `recipient_id = 1` is mail written to the human
 * manager rather than league news broadcast to everyone; requiring both clubs
 * and a named player then separates the trade talk from the owner's PMs and
 * the waiver notices, which share the same sender.
 *
 * Note these name one player each — the export has no message carrying both
 * sides of a deal, so this is interest in a player rather than an offer with a
 * price on it. The analyser below is where the price gets worked out.
 */
/**
 * Actual offers sitting in the OOTP inbox.
 *
 * These were missed for a long time because of how they are stored. A proposal
 * looks almost exactly like the "would it make sense to target X?" notes from
 * your own staff — same message_type, same sender_type, same recipient — and
 * the earlier reader keyed on `team_id_0` and `team_id_1`, which a proposal
 * leaves empty. So every real offer was filtered out and only the suggestions
 * came through.
 *
 * What identifies a proposal is `sender_id` naming a club and `trade_id`
 * naming a deal. Which players go which way is not stored at all: the message
 * lists them together, and the sides are recovered by asking who each man
 * currently plays for. That reconstruction is checked against OOTP's own
 * wording — a Braves offer of Dylan Lee and Ivan Gomez for Henry Lalane comes
 * back exactly that way.
 *
 * Deliberately structural rather than textual. Reading the subject line would
 * work in English and quietly fail in every other language OOTP ships.
 */
tradeRoutes.get('/trade-proposals/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('messages') || !tableExists('players')) return res.json({ proposals: [] });

  const msgs = db
    .prepare(
      `SELECT m.message_id, m.subject, m.date, m.sender_id, m.trade_id,
              m.player_id_0, m.player_id_1, m.player_id_2, m.player_id_3, m.player_id_4,
              m.player_id_5, m.player_id_6, m.player_id_7, m.player_id_8, m.player_id_9,
              ${teamLabel} AS sender_label
       FROM messages m
       LEFT JOIN teams t ON t.team_id = m.sender_id
       WHERE m.recipient_id = 1 AND m.deleted = 0
         AND m.sender_id > 0 AND m.trade_id != 0 AND m.player_id_0 != 0`
    )
    .all() as Array<Record<string, number | string | null>>;

  const orgOf = db.prepare(`SELECT organization_id AS org FROM players WHERE player_id = ?`);

  const proposals = msgs
    .map((m) => {
      const sender = Number(m.sender_id);
      const ids = Array.from({ length: 10 }, (_, i) => Number(m[`player_id_${i}`] ?? 0)).filter(Boolean);
      const theirs: number[] = [];
      const ours: number[] = [];
      for (const id of ids) {
        const org = (orgOf.get(id) as { org: number } | undefined)?.org;
        if (org === sender) theirs.push(id);
        else if (org === orgId) ours.push(id);
      }
      // A message naming players on only one side is not an offer to weigh
      if (theirs.length === 0 || ours.length === 0) return null;
      return {
        message_id: Number(m.message_id),
        trade_id: Number(m.trade_id),
        subject: String(m.subject ?? ''),
        date: padDate(m.date),
        from: { team_id: sender, label: String(m.sender_label ?? 'Unknown') },
        theySend: summarizeSide(theirs),
        weSend: summarizeSide(ours),
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({
      ...p,
      // The same figures the analyser reports, so an offer read here and one
      // pasted into the builder can never disagree
      valueDiff: p.weSend.totalValue - p.theySend.totalValue,
      salaryDiff: p.weSend.totalSalary - p.theySend.totalSalary,
    }))
    .sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));

  res.json({ proposals });
});

tradeRoutes.get('/trade-talk/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('messages') || !tableExists('players')) return res.json({ items: [] });
  const rows = db
    .prepare(
      `SELECT m.message_id, m.subject, m.date, m.team_id_0 AS other_team, m.player_id_0 AS player_id,
              p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              ${teamLabel} AS other_label, t.level
       FROM messages m
       JOIN players p ON p.player_id = m.player_id_0
       LEFT JOIN teams t ON t.team_id = m.team_id_0
       WHERE m.recipient_id = 1 AND m.sender_type = 0 AND m.deleted = 0
         AND m.team_id_0 != 0 AND m.team_id_1 = ? AND m.player_id_0 != 0
         AND p.retired = 0`
    )
    .all(orgId) as Array<Record<string, unknown>>;

  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const contracts = contractsByPlayer();
  // The same player is asked about more than once as the season goes on; the
  // newest message is the live one, and repeating him is just noise
  const seen = new Set<number>();
  const items = rows
    // OOTP writes dates unpadded, so newest-first has to sort on a padded copy
    .sort((a, b) => String(padDate(b.date) ?? '').localeCompare(String(padDate(a.date) ?? '')))
    .filter((r) => !seen.has(r.player_id as number) && seen.add(r.player_id as number))
    .map((r) => {
      const id = r.player_id as number;
      const c = contracts.get(id);
      return {
        message_id: r.message_id as number,
        subject: r.subject as string,
        date: r.date as string,
        otherTeam: { orgId: r.other_team as number, label: (r.other_label as string) ?? 'Unknown' },
        player: {
          player_id: id,
          name: r.name as string,
          age: r.age as number,
          positionName: POSITION_NAMES[r.position as number] ?? '?',
          levelName: LEVEL_NAMES[r.level as number] ?? 'R',
          overallPct: overallPct(id),
          talentPct: talentPct(id),
          salaryNow: c?.salaryNow ?? 0,
          yearsAfterThis: c?.yearsAfterThis ?? 0,
        },
      };
    });
  res.json({ items });
});

/**
 * One club's whole organisation, ready to pick from.
 *
 * Typing each name is the slow part of judging an offer — a five-man deal is
 * five searches, and you are copying names off another screen while you do it.
 * An offer already names a club, so this hands back that club's players to
 * click through instead. Prospects are included because they are usually what
 * the other side is asking for.
 */
tradeRoutes.get('/trade/roster/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              ${teamLabel} AS team, t.level
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.organization_id = ? AND p.retired = 0 AND p.team_id > 0
         AND p.player_id IN (SELECT player_id FROM team_roster WHERE list_id = 1)`
    )
    .all(teamId) as Array<Record<string, unknown>>;
  const values = valuesByPlayer();
  const players = rows
    .map((r) => ({
      player_id: r.player_id as number,
      name: r.name as string,
      age: r.age as number,
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      team: r.team as string,
      levelName: LEVEL_NAMES[r.level as number] ?? 'R',
      value: values.get(r.player_id as number)?.overall ?? 0,
    }))
    // Best first: the men an offer is actually built around are at the top
    .sort((a, b) => b.value - a.value);
  res.json({ players });
});

export interface TradeSideSummary {
  players: Array<{
    player_id: number; name: string; age: number; positionName: string; team: string | null;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
  }>;
  totalValue: number;
  totalTalent: number;
  totalSalary: number;
}

export function summarizeSide(ids: number[]): TradeSideSummary {
  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const contracts = contractsByPlayer();
  let totalValue = 0;
  let totalTalent = 0;
  let totalSalary = 0;
  const players = ids
    .map((id) => {
      const p = db
        .prepare(
          `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
                  ${teamLabel} AS team
           FROM players p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.player_id = ?`
        )
        .get(id) as Record<string, unknown> | undefined;
      if (!p) return null;
      const v = values.get(id);
      const c = contracts.get(id);
      totalValue += v?.overall ?? 0;
      totalTalent += v?.talent ?? 0;
      totalSalary += c?.salaryNow ?? 0;
      return {
        player_id: id,
        name: p.name as string,
        age: p.age as number,
        positionName: POSITION_NAMES[p.position as number] ?? '?',
        team: (p.team as string) ?? null,
        overallPct: overallPct(id),
        talentPct: talentPct(id),
        salaryNow: c?.salaryNow ?? 0,
        yearsAfterThis: c?.yearsAfterThis ?? 0,
      };
    })
    .filter(Boolean) as TradeSideSummary['players'];
  return { players, totalValue, totalTalent, totalSalary };
}

tradeRoutes.post('/trade/analyze', (req, res) => {
  const { sideA, sideB } = req.body as { sideA: number[]; sideB: number[] };
  if (!Array.isArray(sideA) || !Array.isArray(sideB)) {
    return res.status(400).json({ error: 'sideA and sideB arrays required' });
  }
  const a = summarizeSide(sideA);
  const b = summarizeSide(sideB);
  res.json({
    sideA: a,
    sideB: b,
    valueDiff: a.totalValue - b.totalValue,
    talentDiff: a.totalTalent - b.totalTalent,
    salaryDiff: a.totalSalary - b.totalSalary,
  });
});

// ── Context for judging a trade ─────────────────────────────────────────

const ROLE_NAMES: Record<number, string> = { 11: 'Starter', 12: 'Reliever', 13: 'Closer' };

/**
 * A player as a trade needs him described: what he is, how he is playing, and
 * where he would actually stand on this club.
 */
function tradePlayer(id: number, statYear: number | null) {
  const p = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position, p.role,
              p.bats, p.throws, ${teamLabel} AS team, t.level, p.organization_id
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.player_id = ?`
    )
    .get(id) as Record<string, number | string | null> | undefined;
  if (!p) return null;

  const values = valuesByPlayer();
  const contracts = contractsByPlayer();
  const v = values.get(id);
  const c = contracts.get(id);
  const level = p.level as number | null;
  const isPitcher = p.position === 1;

  /*
   * The season line, at whatever level he played it — a Double-A ERA is not a
   * major-league one and the reader must be able to tell them apart.
   *
   * The baseline has to come from the league he actually played in. Measuring
   * an A-ball arm against the major-league average is how ERA+ came back null
   * for every minor leaguer, which is worse than useless in a comparison the
   * whole point of which is to place him.
   */
  let line: Record<string, number | null> | null = null;
  const league = (db
    .prepare(`SELECT league_id FROM teams WHERE team_id = (SELECT team_id FROM players WHERE player_id = ?)`)
    .get(id) as { league_id: number } | undefined)?.league_id;
  if (statYear !== null && level !== null && league) {
    const baseline = leagueBaseline(league, statYear, level);
    const table = isPitcher ? 'players_career_pitching_stats' : 'players_career_batting_stats';
    const cols = isPitcher
      ? `SUM(outs) AS outs, SUM(er) AS er, SUM(ra) AS ra, SUM(ha) AS ha, SUM(bb) AS bb,
         SUM(k) AS k, SUM(hra) AS hra, SUM(bf) AS bf, SUM(g) AS g, SUM(gs) AS gs,
         SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv, SUM(hld) AS hld, SUM(war) AS war`
      : `SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3, SUM(hr) AS hr,
         SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf, SUM(k) AS k,
         SUM(sb) AS sb, SUM(cs) AS cs, SUM(r) AS r, SUM(rbi) AS rbi, SUM(war) AS war`;
    const row = db
      .prepare(
        `SELECT player_id, ${cols} FROM ${table}
         WHERE player_id = ? AND year = ? AND split_id = 1 AND league_id != 0 GROUP BY player_id`
      )
      .get(id, statYear) as Record<string, number> | undefined;
    if (row) {
      line = isPitcher
        ? computePitching(row, baseline, 0)
        : computeBatting(row, baseline, 0);
    }
  }

  return {
    player_id: id,
    name: p.name,
    age: p.age,
    position: POSITION_NAMES[p.position as number] ?? '?',
    role: isPitcher ? (ROLE_NAMES[p.role as number] ?? 'Pitcher') : null,
    bats: ({ 1: 'R', 2: 'L', 3: 'S' } as Record<number, string>)[p.bats as number] ?? '?',
    throws: ({ 1: 'R', 2: 'L' } as Record<number, string>)[p.throws as number] ?? '?',
    currentClub: p.team,
    level: LEVEL_NAMES[level ?? 0] ?? 'unknown',
    isMajorLeaguer: level === 1,
    oaRating: v?.oaRating ?? null,
    potRating: v?.potRating ?? null,
    salaryNow: c?.salaryNow ?? 0,
    yearsAfterThis: c?.yearsAfterThis ?? 0,
    seasonLine: line,
    contact: isPitcher ? null : (contactProfiles([id]).get(id) ?? null),
    /*
     * Where he can play, and how well. Without this the desk was judging men
     * on their bats alone — and said so when asked whether a second baseman
     * could be moved to short, which is exactly the question a trade raises.
     */
    fielding: glovesLine(id),
    fieldingStats: fieldingRecord(id, statYear),
  };
}

/**
 * What he has actually done in the field, position by position.
 *
 * The ratings say what he is; this says what happened. A man rated 60 at short
 * who has made fourteen errors in forty games is a different proposition from
 * one who has not, and only one of those two facts is in the ratings.
 *
 * The current season is stored under split 0 and completed ones under split 1,
 * which is worth knowing: filtering on split 1 alone returns every year except
 * the one being asked about. Last season is carried too, because a handful of
 * games at a position he no longer plays is the strongest evidence there is
 * that he can — which is the question a trade actually raises.
 */
function fieldingRecord(id: number, statYear: number | null): string | null {
  if (statYear === null || !tableExists('players_career_fielding_stats')) return null;
  const rows = db
    .prepare(
      `SELECT year, position, SUM(g) AS g, SUM(po) AS po, SUM(a) AS a, SUM(e) AS e,
              SUM(dp) AS dp, AVG(zr) AS zr
       FROM players_career_fielding_stats
       -- The season in progress is split 0; the ones behind it are split 1
       WHERE player_id = ? AND year >= ? AND split_id IN (0, 1)
       GROUP BY year, position HAVING g > 0 ORDER BY year DESC, g DESC`
    )
    .all(id, statYear - 1) as Array<Record<string, number>>;
  if (rows.length === 0) return null;
  return rows
    .slice(0, 5)
    .map((r) => {
      const chances = (r.po ?? 0) + (r.a ?? 0) + (r.e ?? 0);
      const pct = chances > 0 ? ((r.po + r.a) / chances).toFixed(3).replace(/^0/, '') : '—';
      const zr = r.zr ? `, ${r.zr > 0 ? '+' : ''}${r.zr.toFixed(2)} ZR` : '';
      const when = r.year === statYear ? 'this year' : `${r.year}`;
      return `${POSITION_CODES[(r.position ?? 1) - 1] ?? '?'} ${when}: ${r.g}g, ${r.e}E, ${pct} fpct${zr}`;
    })
    .join('; ');
}

/**
 * Everything needed to judge a trade rather than merely price it.
 *
 * Value percentiles alone produce a verdict about numbers: this man grades
 * higher than that one, accept. A club does not run on percentiles — it runs on
 * a roster with a fixed number of places, each already occupied by somebody.
 * So the incoming players arrive with their season line at the level they
 * played it, and beside them the men they would actually have to displace,
 * with theirs, plus what the club is short of and what it has spare.
 */
export function tradeContext(orgId: number, giveIds: number[], getIds: number[]) {
  const statYear = tableExists('players_career_batting_stats')
    ? ((db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number }).y ?? null)
    : null;

  const give = giveIds.map((id) => tradePlayer(id, statYear)).filter(Boolean);
  const get = getIds.map((id) => tradePlayer(id, statYear)).filter(Boolean);

  // Who already holds the jobs the incoming men would want. Only the
  // major-league roster: a prospect is not competing with anybody yet.
  /*
   * Grouped by the job, which for a pitcher is his role rather than "P".
   * Listing Max Fried as a man a relief arm would displace is not a comparison
   * anybody would make: a reliever competes with relievers.
   */
  const jobOf = (p: { position: string; role: string | null }): string => p.role ?? p.position;
  const incomingPositions = new Set(
    get.filter((p) => p && p.isMajorLeaguer).map((p) => jobOf(p!))
  );
  const leaving = new Set(giveIds);
  const incumbents: Record<string, unknown[]> = {};
  if (incomingPositions.size > 0 && tableExists('team_roster')) {
    const roster = db
      .prepare(
        `SELECT p.player_id FROM players p
         WHERE p.organization_id = ? AND p.retired = 0
           AND p.player_id IN (SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1)`
      )
      .all(orgId, orgId) as Array<{ player_id: number }>;
    for (const { player_id } of roster) {
      if (leaving.has(player_id)) continue;
      const man = tradePlayer(player_id, statYear);
      if (!man || !man.isMajorLeaguer) continue;
      if (!incomingPositions.has(jobOf(man))) continue;
      (incumbents[jobOf(man)] ??= []).push(man);
    }
    // Best first, so the man actually holding the job leads the list
    for (const pos of Object.keys(incumbents)) {
      (incumbents[pos] as Array<{ oaRating: number | null }>).sort(
        (a, b) => (b.oaRating ?? 0) - (a.oaRating ?? 0)
      );
      incumbents[pos] = (incumbents[pos] as unknown[]).slice(0, 4);
    }
  }

  const values = valuesByPlayer();
  const mine = orgProfile(orgId, values);

  // The same totals the Compare cards put on screen, so a verdict citing a
  // number and the panel beside it can never disagree
  const giveTotals = summarizeSide(giveIds);
  const getTotals = summarizeSide(getIds);

  return {
    weGive: give,
    weReceive: get,
    totals: {
      valueSent: Math.round(giveTotals.totalValue),
      valueReceived: Math.round(getTotals.totalValue),
      talentSent: Math.round(giveTotals.totalTalent),
      talentReceived: Math.round(getTotals.totalTalent),
      salarySent: giveTotals.totalSalary,
      salaryReceived: getTotals.totalSalary,
    },
    whoTheyWouldDisplace: incumbents,
    clubNeeds: mine
      ? { weakestPositions: mine.weakest, surplusPositions: mine.surplus }
      : null,
  };
}
