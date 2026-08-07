/**
 * Sanity-checks the league-relative stat engine.
 *
 * OPS+, wRC+, and ERA+ are defined so that a league-average player scores 100.
 * If the PA/IP-weighted league mean drifts off 100, the baseline or the formula
 * is wrong — this catches that immediately after any change.
 *
 * Run with: npm run check:stats
 */
import Database from 'better-sqlite3';
import { computeBatting, computePitching, leagueBaseline } from '../server/stats.js';

const db = new Database('./data/league.db', { readonly: true });

const year = (db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number }).y;
const leagues = db
  .prepare(
    `SELECT DISTINCT t.league_id AS id, t.level, l.name
     FROM teams t JOIN leagues l ON l.league_id = t.league_id
     WHERE t.allstar_team = 0 AND t.level <= 4 ORDER BY t.level, t.league_id`
  )
  .all() as Array<{ id: number; level: number; name: string }>;

let failures = 0;
for (const lg of leagues) {
  const base = leagueBaseline(lg.id, year, lg.level);
  if (base.lgOBP === 0) continue;

  const bat = db
    .prepare(
      `SELECT s.player_id, p.team_id, SUM(s.pa) AS pa, SUM(s.ab) AS ab, SUM(s.h) AS h,
              SUM(s.d) AS d, SUM(s.t) AS t3, SUM(s.hr) AS hr, SUM(s.bb) AS bb,
              SUM(s.ibb) AS ibb, SUM(s.hp) AS hp, SUM(s.sf) AS sf, SUM(s.k) AS k,
              SUM(s.r) AS r, SUM(s.rbi) AS rbi, SUM(s.sb) AS sb, SUM(s.cs) AS cs
       FROM players_career_batting_stats s JOIN players p ON p.player_id = s.player_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND s.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, lg.level, lg.id) as Array<Record<string, number>>;

  let paSum = 0;
  let opsPlusSum = 0;
  let wrcPlusSum = 0;
  for (const row of bat) {
    const c = computeBatting(row, base, row.team_id ?? null);
    if (c.opsPlus === null || c.wrcPlus === null || !row.pa) continue;
    paSum += row.pa;
    opsPlusSum += c.opsPlus * row.pa;
    wrcPlusSum += c.wrcPlus * row.pa;
  }

  const pit = db
    .prepare(
      `SELECT s.player_id, p.team_id, SUM(s.outs) AS outs, SUM(s.er) AS er, SUM(s.ha) AS ha,
              SUM(s.bb) AS bb, SUM(s.k) AS k, SUM(s.hra) AS hra, SUM(s.bf) AS bf
       FROM players_career_pitching_stats s JOIN players p ON p.player_id = s.player_id
       WHERE s.year = ? AND s.split_id = 1 AND s.level_id = ? AND s.league_id = ?
       GROUP BY s.player_id`
    )
    .all(year, lg.level, lg.id) as Array<Record<string, number>>;

  // Averaging per-pitcher ERA+ can't validate anything: ERA+ inverts ERA, so
  // its mean is biased upward, and pitchers with a 0.00 ERA are infinite and
  // must be excluded — which biases it back down. The invariant that MUST hold
  // is that the league's own aggregate line scores exactly 100.
  const lgPitchLine = pit.reduce<Record<string, number>>((acc, row) => {
    for (const k of ['outs', 'er', 'ha', 'bb', 'k', 'hra', 'bf']) acc[k] = (acc[k] ?? 0) + (row[k] ?? 0);
    return acc;
  }, {});
  const aggregateEraPlus = computePitching(lgPitchLine, base, null).eraPlus;

  if (paSum === 0) continue;
  const meanOps = opsPlusSum / paSum;
  const meanWrc = wrcPlusSum / paSum;

  const okOps = Math.abs(meanOps - 100) <= 3;
  const okWrc = Math.abs(meanWrc - 100) <= 3;
  const okEra = aggregateEraPlus === null || Math.abs(aggregateEraPlus - 100) <= 1;
  const meanEra = aggregateEraPlus ?? NaN;
  if (!okOps || !okWrc || !okEra) failures++;

  console.log(
    `${okOps && okWrc && okEra ? '✓' : '❌'} ${lg.name.slice(0, 30).padEnd(31)} ` +
      `lgOBP ${base.lgOBP.toFixed(3)}  lgERA ${base.lgERA.toFixed(2)}   ` +
      `mean OPS+ ${meanOps.toFixed(1)}  wRC+ ${meanWrc.toFixed(1)}  aggregate ERA+ ${Number.isFinite(meanEra) ? meanEra.toFixed(1) : 'n/a'}`
  );
}
// Direct identity check: a player whose line exactly equals the league's
// should score exactly 100 on all three.
const mlb = leagueBaseline(
  (db.prepare(`SELECT league_id AS id FROM teams WHERE level = 1 LIMIT 1`).get() as { id: number }).id,
  year
);
const lgLine = db
  .prepare(
    `SELECT SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3, SUM(hr) AS hr,
            SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf, SUM(k) AS k
     FROM players_career_batting_stats WHERE year = ? AND split_id = 1 AND level_id = 1`
  )
  .get(year) as Record<string, number>;
const lgBat = computeBatting(lgLine, mlb, null);
const lgPitch = computePitching(
  { outs: 300, er: Math.round((mlb.lgERA * 100) / 9), bf: 400, ha: 100, bb: 30, k: 90, hra: 10 },
  mlb,
  null
);
console.log(
  `\nIdentity check — a league-average line scores: ` +
    `OPS+ ${lgBat.opsPlus}, wRC+ ${lgBat.wrcPlus}, ERA+ ${lgPitch.eraPlus} (all should be 100)`
);

console.log(failures === 0 ? 'All leagues center on 100.' : `${failures} league(s) off-center — check the baseline.`);
