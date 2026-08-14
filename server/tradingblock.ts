import { db, tableExists } from './db.js';
import { computeBatting, computePitching, leagueBaseline } from './stats.js';
import {
  LEVEL_NAMES, contractsByPlayer, mlbPercentiler, valuesByPlayer,
} from './valuation.js';

/**
 * Who the rest of the league has actually put up for sale.
 *
 * The export has carried this all along and nothing read it: OOTP writes the
 * trading block into `players_roster_status.trade_status`, and the assistants
 * were reasoning about the whole league as though every player were equally
 * gettable. They were not — in the save this was built against, 153 men were
 * listed and the four best clubs had listed nobody at all, while the worst had
 * between four and ten each. Knowing which is the difference between "ask
 * anyway, sometimes people answer" and "he is already on the market".
 *
 * The meaning of the flag is read off the data rather than assumed: clubs
 * listing players are the ones out of the race, and the ones listed are aging
 * regulars on expiring money. That is a selling list, and nothing else fits.
 */

/** OOTP's value for a player his club has listed. Zero is everybody else. */
const ON_THE_BLOCK = 2;

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const HAND: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };

export interface BlockedPlayer {
  player_id: number;
  name: string;
  age: number;
  position: string;
  bats: string;
  throws: string;
  team: string;
  teamAbbr: string;
  level: number;
  levelName: string;
  /** OOTP's own overall and potential, on whatever scale the save uses. */
  oa: number | null;
  pot: number | null;
  salaryNow: number;
  /** Seasons still owed after this one. Zero means the deal is expiring. */
  yearsAfterThis: number;
  /** This season at his own level — the only line that describes him. */
  seasonLine: string | null;
  /** Percentile of OOTP's Value among comparable major leaguers. */
  valuePct: number | null;
}

/** The player ids the league has listed, for marking men already in a deal. */
export function blockedIds(): Set<number> {
  const out = new Set<number>();
  if (!tableExists('players_roster_status')) return out;
  const rows = db
    .prepare(`SELECT player_id FROM players_roster_status WHERE trade_status = ?`)
    .all(ON_THE_BLOCK) as Array<{ player_id: number }>;
  for (const r of rows) out.add(r.player_id);
  return out;
}

/**
 * Season lines for a set of players, each read at the level he is playing at.
 *
 * Scoped deliberately. Adding a man's Triple-A line to his major-league one
 * produces a season nobody had, and then scaling the total against the
 * major-league average makes an ordinary minor-league year look extraordinary
 * — which is exactly how a shuttling outfielder came to be recommended as the
 * best bat on somebody's roster.
 */
function linesFor(players: Array<{ player_id: number; level: number; league_id: number; position: number }>):
  Map<number, string> {
  const out = new Map<number, string>();
  if (players.length === 0) return out;

  const year = tableExists('players_career_batting_stats')
    ? (db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number | null }).y
    : null;
  if (year === null) return out;

  const ids = players.map((p) => p.player_id);
  const holes = ids.map(() => '?').join(',');
  const wanted = new Map(players.map((p) => [p.player_id, p]));

  if (tableExists('players_career_pitching_stats')) {
    const rows = db
      .prepare(
        `SELECT player_id, level_id, SUM(outs) AS outs, SUM(er) AS er, SUM(ha) AS ha,
                SUM(bb) AS bb, SUM(k) AS k, SUM(hra) AS hra, SUM(hp) AS hp, SUM(bf) AS bf,
                SUM(g) AS g, SUM(gs) AS gs, SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv,
                SUM(hld) AS hld, SUM(war) AS war
         FROM players_career_pitching_stats
         WHERE year = ? AND split_id = 1 AND league_id != 0 AND player_id IN (${holes})
         GROUP BY player_id, level_id`
      )
      .all(year, ...ids) as Array<Record<string, number>>;
    for (const row of rows) {
      const p = wanted.get(row.player_id);
      if (!p || p.position !== 1 || row.level_id !== p.level) continue;
      const s = computePitching(row, leagueBaseline(p.league_id, year, p.level), null);
      out.set(row.player_id, `${s.ip ?? 0} IP, ${(s.era ?? 0).toFixed(2)} ERA${s.eraPlus !== null ? `, ${s.eraPlus} ERA+` : ''}`);
    }
  }

  if (tableExists('players_career_batting_stats')) {
    const rows = db
      .prepare(
        `SELECT player_id, level_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d,
                SUM(t) AS t3, SUM(hr) AS hr, SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp,
                SUM(sf) AS sf, SUM(k) AS k, SUM(r) AS r, SUM(rbi) AS rbi, SUM(sb) AS sb,
                SUM(cs) AS cs, SUM(war) AS war
         FROM players_career_batting_stats
         WHERE year = ? AND split_id = 1 AND league_id != 0 AND player_id IN (${holes})
         GROUP BY player_id, level_id`
      )
      .all(year, ...ids) as Array<Record<string, number>>;
    for (const row of rows) {
      const p = wanted.get(row.player_id);
      if (!p || p.position === 1 || row.level_id !== p.level) continue;
      const s = computeBatting(row, leagueBaseline(p.league_id, year, p.level), null);
      const three = (v: number | null | undefined) =>
        v == null ? '—' : v.toFixed(3).replace(/^0\./, '.');
      out.set(
        row.player_id,
        `${row.pa ?? 0} PA, ${three(s.avg as number)}/${three(s.obp as number)}/${three(s.slg as number)}` +
        `${s.wrcPlus !== null ? `, ${s.wrcPlus} wRC+` : ''}`
      );
    }
  }

  return out;
}

/**
 * The league's trading block.
 *
 * `teamId` narrows it to one club — the natural question when a deal with
 * somebody specific is being weighed. `level` defaults to the majors, because
 * a listed Single-A arm is rarely the point, but every level is available.
 */
export function tradingBlock(opts: { teamId?: number; level?: number | 'all'; limit?: number } = {}): {
  listed: BlockedPlayer[];
  /** How many clubs have listed anybody, which says what kind of market it is. */
  sellingClubs: number;
  total: number;
} {
  const empty = { listed: [], sellingClubs: 0, total: 0 };
  if (!tableExists('players_roster_status') || !tableExists('players')) return empty;

  const level = opts.level === undefined ? 1 : opts.level;
  const conditions = ['rs.trade_status = ?', 'p.retired = 0', 't.allstar_team = 0'];
  const args: unknown[] = [ON_THE_BLOCK];
  if (level !== 'all') {
    conditions.push('t.level = ?');
    args.push(level);
  }
  if (opts.teamId) {
    conditions.push('p.team_id = ?');
    args.push(opts.teamId);
  }

  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name, p.last_name, p.age, p.position, p.bats, p.throws,
              t.name, t.nickname, t.abbr, t.level, t.league_id
       FROM players_roster_status rs
       JOIN players p ON p.player_id = rs.player_id
       JOIN teams t ON t.team_id = p.team_id
       WHERE ${conditions.join(' AND ')}`
    )
    .all(...args) as Array<{
    player_id: number; first_name: string; last_name: string; age: number; position: number;
    bats: number; throws: number; name: string; nickname: string; abbr: string;
    level: number; league_id: number;
  }>;
  if (rows.length === 0) return empty;

  const lines = linesFor(rows.map((r) => ({
    player_id: r.player_id, level: r.level, league_id: r.league_id, position: r.position,
  })));
  const contracts = contractsByPlayer();
  const values = valuesByPlayer();
  const { overallPct } = mlbPercentiler(values);

  const listed: BlockedPlayer[] = rows.map((r) => {
    const c = contracts.get(r.player_id);
    const v = values.get(r.player_id);
    return {
      player_id: r.player_id,
      name: `${r.first_name} ${r.last_name}`,
      age: r.age,
      position: POSITION_NAMES[r.position] ?? '?',
      bats: HAND[r.bats] ?? '?',
      throws: HAND[r.throws] ?? '?',
      team: r.name === r.nickname ? r.name : `${r.name} ${r.nickname}`,
      teamAbbr: r.abbr,
      level: r.level,
      levelName: LEVEL_NAMES[r.level] ?? `L${r.level}`,
      oa: v?.oaRating ?? null,
      pot: v?.potRating ?? null,
      salaryNow: c?.salaryNow ?? 0,
      yearsAfterThis: c?.yearsAfterThis ?? 0,
      seasonLine: lines.get(r.player_id) ?? null,
      valuePct: overallPct(r.player_id),
    };
  });

  // Best first, so a truncated list is still the useful end of it
  listed.sort((a, b) => (b.valuePct ?? -1) - (a.valuePct ?? -1));

  const sellingClubs = new Set(rows.map((r) => r.abbr)).size;
  const limit = opts.limit && opts.limit > 0 ? opts.limit : 40;
  return { listed: listed.slice(0, limit), sellingClubs, total: listed.length };
}
