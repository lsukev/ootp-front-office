import { Router } from 'express';
import { db, tableExists } from './db.js';
import { ON_ROSTER, usesDH, valuesByPlayer } from './valuation.js';
import { computeBatting, leagueBaseline } from './stats.js';

export const lineupRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

interface Candidate {
  player_id: number;
  name: string;
  age: number;
  position: number;
  positionName: string;
  bats: number;
  off: number; // offensive value for the chosen platoon side
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
  const sorted = [...batters].sort((a, b) => b.off - a.off);
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
  result.push({ slot: 3, player: take((c) => c.off), why: 'best all-around hitter' });
  result.push({ slot: 4, player: take((c) => c.power * 2 + c.off), why: 'cleanup power' });
  result.push({ slot: 5, player: take((c) => c.power + c.off), why: 'protection behind cleanup' });
  for (let slot = 6; slot <= batters.length; slot++) {
    result.push({ slot, player: take((c) => c.off), why: 'descending offense' });
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
             WHERE p.team_id = ? AND p.position = 1 AND p.retired = 0 AND ${ON_ROSTER}
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
    off: 0,
    contact: 0,
    power: 0,
    eye: 0,
    speed: 0,
    defense: {},
  };
}

lineupRoutes.get('/lineup/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  const vs = req.query.vs === 'l' ? 'l' : 'r';
  const style = req.query.style === 'trad' ? 'trad' : 'saber';
  // 'auto' follows the league; on/off let a manager see the other card without
  // changing his save — useful for interleague, and for judging how much the
  // rule is actually worth to this roster.
  const dhParam = req.query.dh === 'on' ? 'on' : req.query.dh === 'off' ? 'off' : 'auto';
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
              f.fielding_rating_pos8 AS d8, f.fielding_rating_pos9 AS d9
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_fielding f ON f.player_id = p.player_id
       LEFT JOIN players_roster_status rs ON rs.player_id = p.player_id
       WHERE p.team_id = ? AND p.retired = 0 AND p.position != 1 AND ${ON_ROSTER}`
    )
    .all(teamId) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    bats: number; contact: number | null; power: number | null; eye: number | null; speed: number | null;
    d2: number | null; d3: number | null; d4: number | null; d5: number | null;
    d6: number | null; d7: number | null; d8: number | null; d9: number | null;
  }>;

  const candidates: Candidate[] = raw.map((p) => {
    const v = values.get(p.player_id);
    return {
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      position: p.position,
      positionName: POSITION_NAMES[p.position] ?? '?',
      bats: p.bats,
      off: (vs === 'r' ? v?.offenseVsR : v?.offenseVsL) ?? v?.offense ?? 0,
      contact: p.contact ?? 0,
      power: p.power ?? 0,
      eye: p.eye ?? 0,
      speed: p.speed ?? 0,
      defense: {
        2: p.d2 ?? 0, 3: p.d3 ?? 0, 4: p.d4 ?? 0, 5: p.d5 ?? 0,
        6: p.d6 ?? 0, 7: p.d7 ?? 0, 8: p.d8 ?? 0, 9: p.d9 ?? 0,
      },
    };
  });

  /**
   * Fill the field, weighing the glove as well as the bat.
   *
   * This used to take the best bat whose listed position matched and stop
   * there, which ignored two things: whether he can actually field the spot,
   * and that most players are rated at several. OOTP publishes a 20-80 rating
   * per position — 0 meaning he cannot play there — so a man is now considered
   * anywhere he is rated, and ranked on offence adjusted for how well he
   * fields it.
   *
   * Positions are filled hardest-first down the defensive spectrum. Filling
   * greedily in numeric order would hand first base to the only catcher on the
   * roster and leave the position empty.
   */
  const FILL_ORDER = [2, 6, 8, 5, 4, 9, 7, 3];

  /**
   * What a point of fielding rating is worth against a point of offensive
   * value. Offence in this save spans roughly a thousand points and the rating
   * spans sixty, so eight keeps a ten-point glove difference meaningful —
   * about eighty points — without letting defence override a real bat.
   */
  const DEF_POINTS_PER_RATING = 8;
  const fieldingScore = (c: Candidate, pos: number): number =>
    c.off + DEF_POINTS_PER_RATING * ((c.defense[pos] ?? 0) - 50);

  const assigned = new Map<number, Candidate>(); // position -> player
  const used = new Set<number>();
  for (const pos of FILL_ORDER) {
    const rated = candidates.filter((c) => !used.has(c.player_id) && (c.defense[pos] ?? 0) > 0);
    // A short roster, or an export without fielding ratings, falls back to the
    // old behaviour rather than leaving the position unmanned
    const pool = rated.length > 0 ? rated : candidates.filter((c) => c.position === pos && !used.has(c.player_id));
    const best = [...pool].sort((a, b) => fieldingScore(b, pos) - fieldingScore(a, pos))[0];
    if (best) {
      assigned.set(pos, best);
      used.add(best.player_id);
    }
  }

  /**
   * Greedy alone is not enough: filling centre field before right hands it to
   * the biggest bat on the roster even when he is a poor centre fielder and a
   * good one is still unassigned. Swapping any two men improves the total when
   * both are better suited the other way round, so keep swapping until nothing
   * does. Eight positions make this trivial to run to completion.
   */
  const spots = [...assigned.keys()];
  for (let pass = 0; pass < 8; pass++) {
    let improved = false;
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        const [a, b] = [spots[i], spots[j]];
        const pa = assigned.get(a)!;
        const pb = assigned.get(b)!;
        // Neither may be swapped into a position he cannot play
        if ((pa.defense[b] ?? 0) === 0 || (pb.defense[a] ?? 0) === 0) continue;
        const now = fieldingScore(pa, a) + fieldingScore(pb, b);
        const swapped = fieldingScore(pb, a) + fieldingScore(pa, b);
        if (swapped > now) {
          assigned.set(a, pb);
          assigned.set(b, pa);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  const starters: Candidate[] = spots.map((pos) => {
    const c = assigned.get(pos)!;
    return {
      ...c,
      position: pos,
      positionName: POSITION_NAMES[pos] ?? c.positionName,
      playedRating: c.defense[pos] ?? 0,
    };
  });
  const leagueUsesDH = usesDH(teamId);
  const dh = dhParam === 'auto' ? leagueUsesDH : dhParam === 'on';
  const remaining = candidates.filter((c) => !used.has(c.player_id)).sort((a, b) => b.off - a.off);
  // With a DH the ninth bat is the best one left over. Without one, only the
  // eight fielders bat and the pitcher takes the ninth slot himself.
  const fieldersNeeded = dh ? 9 : 8;
  while (starters.length < fieldersNeeded && remaining.length) {
    const extra = remaining.shift()!;
    starters.push({
      ...extra,
      positionName: dh && starters.length === 8 ? 'DH' : extra.positionName,
    });
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
  const statsById = new Map<number, Record<string, number | null>>();
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
    for (const row of rows) statsById.set(row.player_id, computeBatting(row, base, teamId));
  }

  const ordered = style === 'saber' ? saberOrder(starters) : traditionalOrder(starters);
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
  });
});
