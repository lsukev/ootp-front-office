import { Router } from 'express';
import { db, tableExists } from './db.js';
import { countsAsBatterSql, countsAsPitcherSql } from './twoway.js';
import { healthOf, type Health, type HealthFields } from './health.js';
import { ON_ROSTER, usesDH, valuesByPlayer } from './valuation.js';
import { computeBatting, leagueBaseline } from './stats.js';
import { climb, expectedRuns, outcomesFrom, type BattingLine } from './runs.js';

export const lineupRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/** OOTP's designated-hitter slot, carried through the fill as a position. */
const DH_POS = 10;

/**
 * Who cannot play tonight.
 *
 * The roster clause every other page shares deliberately counts the injured
 * list, because a man on it is still on the roster and still paid. Tonight's
 * lineup is the one place that is wrong: he is on the team and unavailable,
 * and a card that starts him is worse than no card at all.
 *
 * The judgement itself lives in health.ts, shared with the injury report and
 * the pitching staff — this used to read the injured-list flags directly and
 * dropped a healthy active player whose old IL flag OOTP had never cleared.
 */
function unavailability(p: HealthFields): Health | null {
  const health = healthOf(p);
  return health && !health.playable ? health : null;
}

export interface Candidate {
  player_id: number;
  name: string;
  age: number;
  position: number;
  positionName: string;
  bats: number;
  /** Playable but carrying something — the manager's call, not the app's. */
  dayToDay: boolean;
  off: number; // offensive value for the chosen platoon side
  /**
   * The number the order is actually built from — talent or production,
   * whichever was asked for. Kept separate from `off` so the card can still
   * show OOTP's valuation whichever way it was sorted.
   */
  rank: number;
  contact: number;
  power: number;
  eye: number;
  speed: number;
  /** OOTP's own 20-80 rating at each position; 0 means he cannot play there. */
  defense: Record<number, number>;
  /** Filled in once he is assigned somewhere. */
  playedRating?: number;
}

/**
 * Tango/The Book ordering: your best three hitters bat 1-2-4, with the single
 * best in the 2-hole. Slot fill priority: 2, 4, 1, 5, 3, then 6-9 descending.
 */
const SABER_PRIORITY: Array<{ slot: number; why: string }> = [
  { slot: 2, why: 'best hitter — The Book: the 2-hole gets prime situations AND more PA than 3rd' },
  { slot: 4, why: '2nd-best bat — cleanup drives in the top of the order' },
  { slot: 1, why: '3rd-best bat — most plate appearances over a season' },
  { slot: 5, why: '4th-best bat' },
  { slot: 3, why: '5th-best bat — the 3-hole bats with two outs and bases empty more than any other slot' },
  { slot: 6, why: 'descending offense' },
  { slot: 7, why: 'descending offense' },
  { slot: 8, why: 'descending offense' },
  { slot: 9, why: 'descending offense' },
];

function saberOrder(batters: Candidate[]): Array<{ slot: number; player: Candidate; why: string }> {
  const sorted = [...batters].sort((a, b) => b.rank - a.rank);
  // Without a DH only eight men bat before the pitcher, so the fill priority is
  // truncated rather than assumed to be nine deep
  return SABER_PRIORITY.slice(0, sorted.length)
    .map((p, i) => ({ slot: p.slot, player: sorted[i], why: p.why }))
    .sort((a, b) => a.slot - b.slot);
}

function traditionalOrder(batters: Candidate[]): Array<{ slot: number; player: Candidate; why: string }> {
  const pool = new Set(batters);
  const take = (score: (c: Candidate) => number): Candidate => {
    let best: Candidate | null = null;
    let bestScore = -Infinity;
    for (const c of pool) {
      const s = score(c);
      if (s > bestScore) {
        best = c;
        bestScore = s;
      }
    }
    pool.delete(best!);
    return best!;
  };
  const result: Array<{ slot: number; player: Candidate; why: string }> = [];
  result.push({ slot: 1, player: take((c) => c.speed * 2 + c.eye + c.contact), why: 'table-setter — speed and on-base' });
  result.push({ slot: 2, player: take((c) => c.contact * 2 + c.eye), why: 'bat control — moves the runner' });
  result.push({ slot: 3, player: take((c) => c.rank), why: 'best all-around hitter' });
  result.push({ slot: 4, player: take((c) => c.power * 2 + c.rank), why: 'cleanup power' });
  result.push({ slot: 5, player: take((c) => c.power + c.rank), why: 'protection behind cleanup' });
  for (let slot = 6; slot <= batters.length; slot++) {
    result.push({ slot, player: take((c) => c.rank), why: 'descending offense' });
  }
  return result;
}

/**
 * Tonight's probable starter as a batting candidate, for leagues where he hits.
 * Falls back to any starter on the staff so the ninth slot is never empty.
 */
function startingPitcherCandidate(teamId: number): Candidate | null {
  let id: number | null = null;
  if (tableExists('projected_starting_pitchers')) {
    const row = db
      .prepare(`SELECT starter_0 FROM projected_starting_pitchers WHERE team_id = ?`)
      .get(teamId) as { starter_0: number | null } | undefined;
    id = row?.starter_0 ?? null;
  }
  const p = (
    id
      ? db
          .prepare(
            `SELECT player_id, first_name, last_name, age, position, bats FROM players WHERE player_id = ?`
          )
          .get(id)
      : db
          .prepare(
            `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position, p.bats
             FROM players p
             LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
             WHERE p.team_id = ? AND ${countsAsPitcherSql()} AND p.retired = 0 AND ${ON_ROSTER}
             LIMIT 1`
          )
          .get(teamId)
  ) as
    | { player_id: number; first_name: string; last_name: string; age: number; position: number; bats: number }
    | undefined;
  if (!p) return null;
  return {
    player_id: p.player_id,
    name: `${p.first_name} ${p.last_name}`,
    age: p.age,
    position: 1,
    positionName: 'P',
    bats: p.bats,
    dayToDay: false,
    off: 0,
    rank: 0,
    contact: 0,
    power: 0,
    eye: 0,
    speed: 0,
    defense: {},
  };
}

/** Hardest position first down the defensive spectrum; the DH is appended. */
const FIELD_POSITIONS = [2, 6, 8, 5, 4, 9, 7, 3];

/**
 * What a point of fielding rating is worth against a point of offensive value.
 * Offence in this save spans roughly a thousand points and the rating spans
 * sixty, so eight keeps a ten-point glove difference meaningful — about eighty
 * points — without letting defence override a real bat.
 */
const DEF_POINTS_PER_RATING = 8;

/** A position nobody is rated at still has to be manned; this is the last resort. */
const UNMANNED_RATING = 20;

/**
 * What a player is worth at a position: his bat, adjusted for how well he
 * fields it.
 *
 * The half point settles ties. Two men rated identically at a spot score
 * identically, and the tie used to fall to whatever order the roster came back
 * in — which is how an everyday second baseman ends up at DH while his backup
 * fields with the same glove and a worse bat. Half a point cannot outweigh any
 * real difference, since offensive value is whole numbers, but it settles a tie
 * in favour of the man OOTP already lists there.
 */
function slotValue(c: Candidate, pos: number, rating: number): number {
  return c.off + DEF_POINTS_PER_RATING * (rating - 50) + (c.position === pos ? 0.5 : 0);
}

/**
 * Choose the best possible set of fielders, not merely a good one.
 *
 * This was a greedy fill followed by swapping pairs until nothing improved,
 * and the swap only ever looked at men already on the field. A better fielder
 * who lost the greedy pass could therefore never get back in, however much the
 * card would improve — which is how a 60-glove centre fielder rated at exactly
 * one position ends up off the lineup entirely while a 55 plays there. Putting
 * him back needs two men to move at once, and a pair swap can only move one.
 *
 * Nine positions is small enough to stop approximating. This walks every
 * candidate against every subset of filled positions and keeps the best total:
 * a few thousand steps, and the answer is the optimum rather than wherever the
 * search happened to stall.
 */
export function chooseFielders(
  candidates: Candidate[],
  slots: number[]
): Map<number, Candidate> {
  const slotCount = slots.length;
  const FULL_MASK = (1 << slotCount) - 1;
  const anyRated = slots.map((pos) => candidates.some((c) => (c.defense[pos] ?? 0) > 0));
  const canPlay = (c: Candidate, slot: number): boolean =>
    !anyRated[slot] || (c.defense[slots[slot]] ?? 0) > 0;
  const score = (c: Candidate, slot: number): number =>
    slotValue(c, slots[slot], anyRated[slot] ? (c.defense[slots[slot]] ?? 0) : UNMANNED_RATING);

  let value = new Float64Array(1 << slotCount).fill(-Infinity);
  value[0] = 0;
  // Which slot each candidate took to reach each subset of filled positions;
  // -1 means he sat, and is how the walk back knows to skip him
  const tookSlot: Int8Array[] = [];
  for (const c of candidates) {
    const next = Float64Array.from(value);
    const took = new Int8Array(1 << slotCount).fill(-1);
    for (let mask = 0; mask <= FULL_MASK; mask++) {
      if (value[mask] === -Infinity) continue;
      for (let slot = 0; slot < slotCount; slot++) {
        if (mask & (1 << slot)) continue;
        if (!canPlay(c, slot)) continue;
        const filled = mask | (1 << slot);
        const total = value[mask] + score(c, slot);
        if (total > next[filled]) {
          next[filled] = total;
          took[filled] = slot;
        }
      }
    }
    value = next;
    tookSlot.push(took);
  }

  // Man as many positions as the roster allows, and among those, score best
  const filledCount = (m: number): number => m.toString(2).split('1').length - 1;
  let bestMask = 0;
  for (let m = 0; m <= FULL_MASK; m++) {
    if (value[m] === -Infinity) continue;
    if (
      filledCount(m) > filledCount(bestMask) ||
      (filledCount(m) === filledCount(bestMask) && value[m] > value[bestMask])
    ) {
      bestMask = m;
    }
  }

  const assigned = new Map<number, Candidate>();
  let mask = bestMask;
  for (let k = candidates.length - 1; k >= 0; k--) {
    const slot = tookSlot[k][mask];
    if (slot < 0) continue;
    assigned.set(slots[slot], candidates[k]);
    mask ^= 1 << slot;
  }
  return assigned;
}

lineupRoutes.get('/lineup/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  const vs = req.query.vs === 'l' ? 'l' : 'r';
  const style = req.query.style === 'trad' ? 'trad' : 'saber';
  // 'auto' follows the league; on/off let a manager see the other card without
  // changing his save — useful for interleague, and for judging how much the
  // rule is actually worth to this roster.
  const dhParam = req.query.dh === 'on' ? 'on' : req.query.dh === 'off' ? 'off' : 'auto';
  /*
   * What to build the order from. Talent is OOTP's own valuation and stays the
   * default: it is a projection, and over the rest of a season a projection
   * beats a third of a season of results. Production is here because plenty of
   * managers want the card to say what has actually happened — a man hitting
   * .274 on-base batting cleanup on the strength of his ratings is correct and
   * still hard to look at. Neither is the better answer; they answer different
   * questions.
   */
  const sortBy = req.query.sort === 'production' ? 'production' : 'talent';
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });

  const values = valuesByPlayer();
  const raw = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position, p.bats,
              b.batting_ratings_overall_contact AS contact,
              b.batting_ratings_overall_power AS power,
              b.batting_ratings_overall_eye AS eye,
              b.running_ratings_speed AS speed,
              f.fielding_rating_pos2 AS d2, f.fielding_rating_pos3 AS d3,
              f.fielding_rating_pos4 AS d4, f.fielding_rating_pos5 AS d5,
              f.fielding_rating_pos6 AS d6, f.fielding_rating_pos7 AS d7,
              f.fielding_rating_pos8 AS d8, f.fielding_rating_pos9 AS d9,
              p.injury_is_injured, p.injury_dtd_injury, p.injury_left,
              rs.is_on_dl, rs.is_on_dl60, rs.is_active
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_fielding f ON f.player_id = p.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       -- A pitcher who genuinely hits is a bat available to the card
       WHERE p.team_id = ? AND p.retired = 0 AND ${countsAsBatterSql()} AND ${ON_ROSTER}`
    )
    .all(teamId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    bats: number; contact: number | null; power: number | null; eye: number | null; speed: number | null;
    d2: number | null; d3: number | null; d4: number | null; d5: number | null;
    d6: number | null; d7: number | null; d8: number | null; d9: number | null;
    injury_is_injured: number | null; injury_dtd_injury: number | null; injury_left: number | null;
    is_on_dl: number | null; is_on_dl60: number | null; is_active: number | null;
  }>;

  const unavailable = raw
    .map((p) => ({ p, out: unavailability(p) }))
    .filter((r): r is { p: (typeof raw)[number]; out: Health } => r.out !== null)
    .map(({ p, out }) => ({
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      positionName: POSITION_NAMES[p.position] ?? '?',
      status: out.status,
      daysLeft: out.daysLeft,
    }));
  const sidelined = new Set(unavailable.map((u) => u.player_id));

  const candidates: Candidate[] = raw
    .filter((p) => !sidelined.has(p.player_id))
    .map((p) => {
      const v = values.get(p.player_id);
      return {
        player_id: p.player_id,
        name: `${p.first_name} ${p.last_name}`,
        age: p.age,
        position: p.position,
        positionName: POSITION_NAMES[p.position] ?? '?',
        bats: p.bats,
        dayToDay: p.injury_dtd_injury === 1,
        off: (vs === 'r' ? v?.offenseVsR : v?.offenseVsL) ?? v?.offense ?? 0,
        rank: 0, // filled in below, once the season lines are known
        contact: p.contact ?? 0,
        power: p.power ?? 0,
        eye: p.eye ?? 0,
        speed: p.speed ?? 0,
        defense: {
          2: p.d2 ?? 0, 3: p.d3 ?? 0, 4: p.d4 ?? 0, 5: p.d5 ?? 0,
          6: p.d6 ?? 0, 7: p.d7 ?? 0, 8: p.d8 ?? 0, 9: p.d9 ?? 0,
          // Anyone can DH, and nobody fields it, so it scores as a neutral
          // glove — which makes the bat the only thing separating candidates
          [DH_POS]: 50,
        },
      };
    });

  const leagueUsesDH = usesDH(teamId);
  const dh = dhParam === 'auto' ? leagueUsesDH : dhParam === 'on';
  const FILL_ORDER = dh ? [...FIELD_POSITIONS, DH_POS] : [...FIELD_POSITIONS];
  const assigned = chooseFielders(candidates, FILL_ORDER);
  const used = new Set([...assigned.values()].map((c) => c.player_id));
  const spots = FILL_ORDER.filter((pos) => assigned.has(pos));

  const starters: Candidate[] = spots.map((pos) => {
    const c = assigned.get(pos)!;
    return {
      ...c,
      position: pos,
      positionName: POSITION_NAMES[pos] ?? c.positionName,
      // The DH's neutral 50 is a scoring device, not a glove he is using
      playedRating: pos === DH_POS ? undefined : (c.defense[pos] ?? 0),
    };
  });
  /*
   * Talent, not the chosen sort: this runs before the season lines are
   * assembled, and it only decides who backfills a position a short roster has
   * left unmanned — not where anybody bats.
   */
  const remaining = candidates.filter((c) => !used.has(c.player_id)).sort((a, b) => b.off - a.off);
  // Without a DH only the eight fielders bat and the pitcher takes the ninth
  // slot himself. A position left unmanned by a short roster is backfilled
  // with the best bat still standing rather than left empty.
  const fieldersNeeded = dh ? 9 : 8;
  while (starters.length < fieldersNeeded && remaining.length) {
    const extra = remaining.shift()!;
    starters.push(extra);
    used.add(extra.player_id);
  }
  if (starters.length < fieldersNeeded) {
    return res.status(400).json({ error: 'Not enough position players on this roster to fill a lineup' });
  }

  // The man who actually bats ninth in a no-DH league is tonight's starter
  const pitcher = dh ? null : startingPitcherCandidate(teamId);

  // Season rate stats for the chosen nine, so the card can be judged on
  // production as well as OOTP's internal offensive value
  const teamRow = db.prepare(`SELECT league_id, level FROM teams WHERE team_id = ?`).get(teamId) as
    | { league_id: number; level: number }
    | undefined;
  const statYear = tableExists('players_career_batting_stats')
    ? (db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number }).y
    : null;
  /** What the search did, reported so the page can show it rather than assert it. */
  let searchNote: {
    seededRuns: number; optimisedRuns: number; gain: number; evaluations: number; moved: boolean;
  } | null = null;
  const statsById = new Map<number, Record<string, number | null>>();
  /** Raw season lines and the league's, for the expected-runs search below. */
  const rawById = new Map<number, BattingLine>();
  let leagueLine: BattingLine | null = null;
  if (teamRow && statYear !== null) {
    const base = leagueBaseline(teamRow.league_id, statYear, teamRow.level);
    const rows = db
      .prepare(
        `SELECT player_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3,
                SUM(hr) AS hr, SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf,
                SUM(k) AS k, SUM(sb) AS sb, SUM(cs) AS cs, SUM(r) AS r, SUM(rbi) AS rbi,
                SUM(war) AS war
         FROM players_career_batting_stats
         WHERE year = ? AND split_id = 1 AND level_id = ?
         GROUP BY player_id`
      )
      .all(statYear, teamRow.level) as Array<Record<string, number>>;
    for (const row of rows) {
      statsById.set(row.player_id, computeBatting(row, base, teamId));
      // The raw line as well, because the run model needs events per plate
      // appearance rather than the rate stats computed from them
      rawById.set(row.player_id, {
        pa: row.pa ?? 0, h: row.h ?? 0, d: row.d ?? 0, t: row.t3 ?? 0,
        hr: row.hr ?? 0, bb: row.bb ?? 0, hp: row.hp ?? 0,
      });
    }
    leagueLine = db
      .prepare(
        `SELECT SUM(pa) AS pa, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t,
                SUM(hr) AS hr, SUM(bb) AS bb, SUM(hp) AS hp
         FROM players_career_batting_stats
         WHERE year = ? AND split_id = 1 AND level_id = ? AND league_id = ?`
      )
      .get(statYear, teamRow.level, teamRow.league_id) as BattingLine | undefined ?? null;
  }

  /*
   * The number a production-sorted card is built from.
   *
   * wRC+ regressed toward league average on plate appearances, because the
   * unregressed version hands the leadoff spot to whoever is hottest in twenty
   * trips. A hundred and fifty is the weight of the prior: at 150 PA a man is
   * read half on what he has done and half on the league, and by a full season
   * he is read almost entirely on himself. Somebody with no plate appearances
   * comes out at exactly average, which is the honest reading of no evidence.
   */
  const PRIOR_PA = 150;
  const productionScore = (playerId: number): number => {
    const s = statsById.get(playerId);
    const rate = s?.wrcPlus ?? s?.opsPlus ?? null;
    const pa = s?.pa ?? 0;
    if (rate === null || pa <= 0) return 100;
    return (rate * pa + 100 * PRIOR_PA) / (pa + PRIOR_PA);
  };
  /*
   * Applied to the starters as well, and that is the whole of it: `starters`
   * are spread copies taken before the season lines existed, so setting this
   * on `candidates` alone left every one of them ranked zero and the sort
   * quietly did nothing at all.
   */
  for (const c of [...candidates, ...starters]) {
    c.rank = sortBy === 'production' ? productionScore(c.player_id) : c.off;
  }

  const seeded = style === 'saber' ? saberOrder(starters) : traditionalOrder(starters);

  /*
   * The slot rule gets the card written; a search decides the sequence.
   *
   * Measured against every one of the 362,880 ways to order a real club's
   * nine: the rule's card ranked 16,718th and was worth 736.7 runs a season,
   * the true optimum 746.2. Seeding this search from the rule's own card
   * reached 744.3 in 109 evaluations and half a second — most of the gap, for
   * a cost a page can pay.
   *
   * Seeded rather than started cold on purpose. It cannot return anything the
   * rule beats, it converges in a fraction of the evaluations, and the answer
   * still looks like an order a person would recognise rather than one
   * arrived at by machine.
   *
   * Only where there is enough season to believe. Rates are pulled toward the
   * league by sample size before they are used, but a club in April has
   * nothing worth searching over, and a search will always find SOMETHING to
   * rearrange — which is how a fortnight of noise becomes a batting order.
   */
  const ordered = optimiseOrder(seeded);
  function optimiseOrder(card: typeof seeded): typeof seeded {
    if (leagueLine === null || (leagueLine.pa ?? 0) <= 0) return card;
    const lines = card.map((l) => rawById.get(l.player.player_id));
    if (lines.some((l) => l === undefined)) return card;
    const played = lines.reduce((sum, l) => sum + (l?.pa ?? 0), 0);
    // A club that has not yet batted around ten times over
    if (played < 900) return card;

    const outcomes = lines.map((l) => outcomesFrom(l as BattingLine, leagueLine as BattingLine));
    const before = expectedRuns(outcomes);
    const { order, runs, evaluations } = climb(outcomes);
    searchNote = {
      seededRuns: Number((before * 162).toFixed(1)),
      optimisedRuns: Number((runs * 162).toFixed(1)),
      gain: Number(((runs - before) * 162).toFixed(1)),
      evaluations,
      moved: order.some((from, to) => from !== to),
    };
    /*
     * Below a run a season the search is reading noise in the rates rather
     * than anything about baseball, and shuffling a card the manager has got
     * used to for a fortieth of a win is not worth doing.
     */
    if (searchNote.gain < 1) return card;
    /*
     * Re-seat the men in the searched sequence, keeping the slot numbers — and
     * do not carry the rule's reasoning across with them. The first version of
     * this did, and the card then explained that the man batting third was
     * there because "the 2-hole gets prime situations", which is a sentence
     * about a slot he is no longer in. A reason that survives the move is not
     * a reason, and a card that argues for itself wrongly is worse than one
     * that says plainly who put him there.
     */
    return order.map((from, to) => ({
      ...card[from],
      slot: card[to].slot,
      /*
       * Each reason is "<what he is> — <why that suits this slot>". Only the
       * second half stops being true when he moves, so only the second half
       * goes: "best hitter" still describes him wherever he bats, while "the
       * 2-hole gets prime situations" describes a slot he has left.
       */
      why: from === to
        ? card[from].why
        : `${card[from].why.split(' — ')[0]}, placed by the run search`,
    }));
  }
  // The pitcher is appended rather than ranked: he bats ninth because of where
  // he stands in the field, not because of how the bats sorted.
  const lineup =
    pitcher !== null
      ? [...ordered, { slot: 9, player: pitcher, why: 'pitcher — no DH in this league' }]
      : ordered;
  const bench = candidates
    .filter((c) => !used.has(c.player_id))
    .sort((a, b) => b.off - a.off)
    .slice(0, 8);

  res.json({
    vs,
    style,
    /** Null when the search was skipped, or moved nobody worth moving. */
    runSearch: searchNote,
    usesDH: dh,
    leagueUsesDH,
    dhOverridden: dh !== leagueUsesDH,
    lineup: lineup.map((l) => {
      const s = statsById.get(l.player.player_id);
      return {
        slot: l.slot,
        player_id: l.player.player_id,
        name: l.player.name,
        positionName: l.player.positionName,
        defRating: l.player.playedRating ?? null,
        bats: { 1: 'R', 2: 'L', 3: 'S' }[l.player.bats] ?? '?',
        dayToDay: l.player.dayToDay === true,
        off: l.player.off,
        speed: l.player.speed,
        power: l.player.power,
        why: l.why,
        pa: s?.pa ?? null,
        ops: s?.ops ?? null,
        opsPlus: s?.opsPlus ?? null,
        wrcPlus: s?.wrcPlus ?? null,
        war: s?.war ?? null,
      };
    }),
    bench: bench.map((c) => ({
      player_id: c.player_id,
      name: c.name,
      positionName: c.positionName,
      off: c.off,
    })),
    // Named rather than silently dropped: a coach who does not see why his
    // best hitter is missing will assume the card is broken
    unavailable,
  });
});
