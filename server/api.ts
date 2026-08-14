import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists, tableColumns, locateColumn } from './db.js';
import { detectSaves, resolveChosenFolder, searchLocations } from './paths.js';
import { DATA_DIR, loadConfig, saveConfig } from './config.js';
import { importCsvDir, type ImportResult } from './importer.js';
import { clearPendingExport, pendingExport, startWatcher } from './watcher.js';
import { getApiKey, loadSettings } from './settings.js';
import { orgRoutes } from './org.js';
import { contractRoutes } from './contracts.js';
import { freeAgentRoutes } from './freeagents.js';
import { lineupRoutes } from './lineup.js';
import { storylineRoutes, startStorylineJob } from './storylines.js';
import { playerRoutes } from './player.js';
import { historyRoutes, takeSnapshot } from './history.js';
import { clearStatCaches, computeBatting, computePitching, leagueBaseline } from './stats.js';
import { ratingScaleMax, clearScaleCache, clearValuationCaches, valuesByPlayer } from './valuation.js';
import { clearTwoWayCache } from './twoway.js';
import { dashboardRoutes } from './dashboard.js';
import { rosterOpsRoutes } from './rosterops.js';
import { tradeRoutes } from './trade.js';
import { contactProfiles } from './battedball.js';
import { standingOf, type StandingFields } from './health.js';
import { gameplanRoutes } from './gameplan.js';
import { aiRoutes, startBriefingJob } from './ai.js';
import { logoRoutes, logoToken } from './logos.js';
import { settingsRoutes } from './settings.js';
import { modelRoutes } from './models.js';
import { exportRoutes } from './exporter.js';
import { franchiseRoutes } from './franchise.js';
import { leagueRoutes } from './league.js';
import { pitchingRoutes } from './pitching.js';
import { scheduleRoutes } from './schedule.js';
import { payrollRoutes } from './payroll.js';
import { trendsRoutes } from './trends.js';
import { chatRoutes } from './chat.js';

export const api = Router();
api.use(logoRoutes);
api.use(settingsRoutes);
api.use(modelRoutes);
api.use(exportRoutes);
api.use(franchiseRoutes);
api.use(leagueRoutes);
api.use(pitchingRoutes);
api.use(scheduleRoutes);
api.use(payrollRoutes);
api.use(trendsRoutes);
api.use(chatRoutes);
api.use(playerRoutes);
api.use(historyRoutes);
api.use(dashboardRoutes);
api.use(rosterOpsRoutes);
api.use(tradeRoutes);
api.use(gameplanRoutes);
api.use(aiRoutes);
api.use(orgRoutes);
api.use(contractRoutes);
api.use(freeAgentRoutes);
api.use(lineupRoutes);
api.use(storylineRoutes);

const META_PATH = path.join(DATA_DIR, 'last-import.json');

function loadImportMeta(): ImportResult | null {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch {
    return null;
  }
}

export const importState: {
  importing: boolean;
  lastImport: ImportResult | null;
  lastError: string | null;
} = { importing: false, lastImport: loadImportMeta(), lastError: null };

/**
 * Kicks off the storylines and the briefing after an import, when the club has
 * asked for that.
 *
 * Both cost money on the user's own key, so this happens only when the setting
 * is on and a key exists — and it starts jobs rather than waiting on them, so
 * an import is never held up by an API call. A club that has not been chosen
 * yet is skipped: there would be no way to know whose season to write about.
 */
function autoGenerate(): void {
  try {
    const settings = loadSettings();
    if (!settings.autoGenerateAfterImport || !getApiKey()) return;
    const orgId = settings.defaultOrgId ?? humanOrgId();
    if (!orgId) return;
    console.log('[import] starting storylines and briefing for org', orgId);
    startStorylineJob(orgId);
    startBriefingJob(orgId);
  } catch (err) {
    // A failure here must never take the import down with it
    console.error('[import] could not start the generations:', err);
  }
}

/** The club the save says is being managed, when no default has been chosen. */
function humanOrgId(): number | null {
  try {
    const row = db.prepare(`SELECT team_id FROM teams WHERE human_team = 1 LIMIT 1`).get() as
      | { team_id: number }
      | undefined;
    return row?.team_id ?? null;
  } catch {
    return null;
  }
}

export function runImport(csvDir: string): void {
  if (importState.importing) return;
  importState.importing = true;
  importState.lastError = null;
  try {
    importState.lastImport = importCsvDir(csvDir);
    // Whatever was waiting on disk has now been read
    clearPendingExport();
    fs.writeFileSync(META_PATH, JSON.stringify(importState.lastImport));
    clearStatCaches(); // league baselines are per-import
    clearValuationCaches();
    try {
      takeSnapshot(); // development-tracking snapshot, keyed by in-game date
    } catch (err) {
      console.error('[history] snapshot failed:', err);
    }
    console.log(
      `[import] ${importState.lastImport.tables} tables, ${importState.lastImport.rows} rows imported`
    );
    clearScaleCache();
    clearTwoWayCache();
    autoGenerate();
  } catch (err) {
    importState.lastError = (err as Error).message;
    console.error('[import] failed:', err);
  } finally {
    importState.importing = false;
  }
}

api.get('/saves', (_req, res) => {
  res.json(detectSaves());
});

/** Where we looked, so the user can see why auto-detection came up empty. */
api.get('/search-locations', (_req, res) => {
  res.json({ platform: process.platform, locations: searchLocations() });
});

/** Checks a folder the user picked or typed, before committing to it. */
api.post('/resolve-folder', (req, res) => {
  const { path: chosen } = req.body as { path?: string };
  if (!chosen?.trim()) return res.status(400).json({ ok: false, error: 'No folder given.' });
  res.json(resolveChosenFolder(chosen));
});

function csvExportedAt(csvDir: string): string | null {
  try {
    let latest = 0;
    for (const f of fs.readdirSync(csvDir)) {
      if (!f.endsWith('.csv')) continue;
      const mtime = fs.statSync(`${csvDir}/${f}`).mtimeMs;
      if (mtime > latest) latest = mtime;
    }
    return latest ? new Date(latest).toISOString() : null;
  } catch {
    return null;
  }
}

api.get('/status', (_req, res) => {
  const config = loadConfig();
  res.json({
    csvExportedAt: config.csvDir ? csvExportedAt(config.csvDir) : null,
    configured: !!config.csvDir,
    saveName: config.saveName,
    csvDir: config.csvDir,
    csvDirExists: config.csvDir ? fs.existsSync(config.csvDir) : false,
    importing: importState.importing,
    lastImport: importState.lastImport,
    lastError: importState.lastError,
    hasData: tableExists('players') && tableExists('teams'),
    /** Set when OOTP has written a fresh export the app has not imported yet. */
    exportPending: pendingExport(),
    /*
     * Changes with the save, and rides along on every logo URL. Without it the
     * browser's day-long cache served the previous save's art for team ids the
     * new one reuses.
     */
    logoToken: logoToken(),
    /*
     * The scale OOTP is set to show ratings on, read off the save. Bars used
     * to divide by eighty regardless, so a 5 on the 1-to-5 scale drew at six
     * per cent of the width.
     */
    ratingScaleMax: tableExists('players') ? ratingScaleMax() : 80,
  });
});

api.post('/config', (req, res) => {
  const { csvDir, saveName } = req.body as { csvDir?: string; saveName?: string };
  if (!csvDir) return res.status(400).json({ error: 'csvDir is required' });
  saveConfig({ csvDir, saveName: saveName ?? null });
  if (fs.existsSync(csvDir)) {
    importState.importing = true; // visible to /status before the import starts
    setImmediate(() => {
      importState.importing = false;
      runImport(csvDir);
    });
    startWatcher(csvDir);
  }
  res.json({ ok: true });
});

api.post('/import', (_req, res) => {
  const config = loadConfig();
  if (!config.csvDir) return res.status(400).json({ error: 'No save configured' });
  if (!fs.existsSync(config.csvDir)) {
    return res.status(400).json({ error: `CSV directory not found: ${config.csvDir}` });
  }
  runImport(config.csvDir);
  res.json({ ok: true, lastImport: importState.lastImport, lastError: importState.lastError });
});

api.get('/teams', (_req, res) => {
  if (!tableExists('teams')) return res.json([]);
  const cols = tableColumns('teams');
  const pick = (...names: string[]) => names.find((n) => cols.includes(n));
  const id = pick('team_id') ?? cols[0];
  const name = pick('name');
  const nickname = pick('nickname');
  const abbr = pick('abbr');
  const level = pick('level');
  const parent = pick('parent_team_id');
  const league = pick('league_id');
  const select = [
    `"${id}" AS team_id`,
    name ? `"${name}" AS name` : `'?' AS name`,
    nickname ? `"${nickname}" AS nickname` : `NULL AS nickname`,
    abbr ? `"${abbr}" AS abbr` : `NULL AS abbr`,
    level ? `"${level}" AS level` : `NULL AS level`,
    parent ? `"${parent}" AS parent_team_id` : `NULL AS parent_team_id`,
    league ? `"${league}" AS league_id` : `NULL AS league_id`,
  ].join(', ');
  res.json(db.prepare(`SELECT ${select} FROM teams ORDER BY name`).all());
});

/** Rating fields we surface, with candidate locations per OOTP schema version. */
const RATING_SPECS: Array<{ key: string; candidates: Array<[string, string]> }> = [
  { key: 'contact', candidates: [['players_batting', 'batting_ratings_overall_contact']] },
  { key: 'gap', candidates: [['players_batting', 'batting_ratings_overall_gap']] },
  { key: 'power', candidates: [['players_batting', 'batting_ratings_overall_power']] },
  { key: 'eye', candidates: [['players_batting', 'batting_ratings_overall_eye']] },
  { key: 'avoidK', candidates: [['players_batting', 'batting_ratings_overall_strikeouts']] },
  { key: 'contactPot', candidates: [['players_batting', 'batting_ratings_talent_contact']] },
  { key: 'powerPot', candidates: [['players_batting', 'batting_ratings_talent_power']] },
  { key: 'eyePot', candidates: [['players_batting', 'batting_ratings_talent_eye']] },
  { key: 'stuff', candidates: [['players_pitching', 'pitching_ratings_overall_stuff']] },
  { key: 'movement', candidates: [['players_pitching', 'pitching_ratings_overall_movement']] },
  { key: 'control', candidates: [['players_pitching', 'pitching_ratings_overall_control']] },
  { key: 'stuffPot', candidates: [['players_pitching', 'pitching_ratings_talent_stuff']] },
  { key: 'movementPot', candidates: [['players_pitching', 'pitching_ratings_talent_movement']] },
  { key: 'controlPot', candidates: [['players_pitching', 'pitching_ratings_talent_control']] },
  {
    key: 'speed',
    candidates: [
      ['players_batting', 'running_ratings_speed'],
      ['players', 'running_ratings_speed'],
    ],
  },
];

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
// Verified against a real OOTP 27 export (Judge 1/1 R/R, Soto 2/2 L/L, Raleigh bats 3 S)
const BATS: Record<number, string> = { 1: 'R', 2: 'L', 3: 'S' };
const THROWS: Record<number, string> = { 1: 'R', 2: 'L' };

api.get('/roster/:teamId', (req, res) => {
  const teamId = Number(req.params.teamId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No player data imported yet' });

  const cols = tableColumns('players');
  const pick = (...names: string[]) => names.find((n) => cols.includes(n));
  const select = [
    `"${pick('player_id') ?? cols[0]}" AS player_id`,
    pick('first_name') ? `"first_name"` : `NULL AS first_name`,
    pick('last_name') ? `"last_name"` : `NULL AS last_name`,
    pick('age') ? `"age"` : `NULL AS age`,
    pick('position') ? `"position"` : `NULL AS position`,
    pick('role') ? `"role"` : `NULL AS role`,
    pick('bats') ? `"bats"` : `NULL AS bats`,
    pick('throws') ? `"throws"` : `NULL AS throws`,
    pick('uniform_number') ? `"uniform_number"` : `NULL AS uniform_number`,
  ].join(', ');

  /**
   * Who is actually on this club's roster.
   *
   * `players.team_id` is not a roster. OOTP parks players on a club without
   * giving them a spot — newly signed international free agents sit on the
   * parent club until they are assigned, and unsigned veterans keep pointing at
   * their last team — so a bare team_id swept 132 men across the league onto
   * major-league roster pages who were not on those rosters.
   *
   * team_roster with list_id = 1 is OOTP's own answer and works at every level:
   * for a major-league club it is the active roster plus the injured list, and
   * for an affiliate it is that affiliate's full roster. The roster-status flags
   * cannot be used here — is_active means "on the MLB active roster", so it
   * would empty every minor-league page.
   */
  const useRosterList = tableExists('team_roster');
  const players = db
    .prepare(
      useRosterList
        ? `SELECT ${select} FROM players
           WHERE player_id IN (SELECT player_id FROM team_roster WHERE team_id = ? AND list_id = 1)`
        : // An export without the table behaves as it always did
          `SELECT ${select} FROM players WHERE team_id = ?`
    )
    .all(teamId) as Record<string, unknown>[];

  // Attach ratings from wherever they live in this export's schema
  const ratingSources = new Map<string, [string, string]>();
  for (const spec of RATING_SPECS) {
    const loc = locateColumn(spec.candidates);
    if (loc) ratingSources.set(spec.key, loc);
  }
  const byTable = new Map<string, Array<{ key: string; column: string }>>();
  for (const [key, [table, column]] of ratingSources) {
    if (!byTable.has(table)) byTable.set(table, []);
    byTable.get(table)!.push({ key, column });
  }
  /**
   * Only this roster's men. The stat blocks below were being computed for every
   * player in the league — some twelve thousand rows and as many calls into the
   * stat engine — to display forty of them.
   */
  const rosterIds = players.map((p) => p.player_id as number);
  const idFilter = rosterIds.length > 0 ? `AND player_id IN (${rosterIds.map(() => '?').join(',')})` : '';

  const ratingsByPlayer = new Map<number, Record<string, unknown>>();
  for (const [table, specs] of byTable) {
    if (!tableColumns(table).includes('player_id')) continue;
    const sel = specs.map((s) => `"${s.column}" AS "${s.key}"`).join(', ');
    // Every ratings table was being read whole — every player in the save,
    // several times over — to fill in one roster
    const rows = db
      .prepare(`SELECT player_id, ${sel} FROM "${table}" WHERE player_id IN (${rosterIds.map(() => '?').join(',')})`)
      .all(...rosterIds) as Array<Record<string, unknown> & { player_id: number }>;
    for (const row of rows) {
      const { player_id, ...rest } = row;
      // Mutated in place rather than rebuilt: the spread was copying the whole
      // accumulated object once per row
      const existing = ratingsByPlayer.get(player_id);
      if (existing) Object.assign(existing, rest);
      else ratingsByPlayer.set(player_id, rest);
    }
  }

  // Current-season stats. Rate and league-relative stats (OPS+, wRC+, ERA+)
  // are computed server-side so every page shares one source of truth.
  const teamRow = db.prepare(`SELECT league_id, level FROM teams WHERE team_id = ?`).get(teamId) as
    | { league_id: number; level: number }
    | undefined;
  const statYear = tableExists('players_career_batting_stats')
    ? (db.prepare(`SELECT MAX(year) AS y FROM players_career_batting_stats`).get() as { y: number }).y
    : null;
  // League-relative stats are only meaningful against a baseline from the same
  // league and level, so minor-league clubs are compared to their own league.
  const baseline =
    teamRow && statYear !== null
      ? leagueBaseline(teamRow.league_id, statYear, teamRow.level)
      : null;

  const battingByPlayer = new Map<number, Record<string, number | null>>();
  if (tableExists('players_career_batting_stats') && statYear !== null && baseline && teamRow) {
    const rows = db
      .prepare(
        `SELECT player_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3,
                SUM(hr) AS hr, SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf,
                SUM(k) AS k, SUM(sb) AS sb, SUM(cs) AS cs, SUM(r) AS r, SUM(rbi) AS rbi,
                SUM(war) AS war
         FROM players_career_batting_stats
         -- A drafted amateur's school season lives here under no league at
         -- all, and summing it in credits him with what he did to schoolboys
         --
         -- And only what he did AT THIS LEVEL. A shuttling player has a line at
         -- each, and adding them together produces a season nobody had: a
         -- reader was shown a man recommended as a trade target on .313/.372/
         -- .552 and a 155 wRC+ when almost all of it was Triple-A. Worse, the
         -- rate stats below are scaled against this club's own league, so a
         -- Triple-A line was being measured against major-league pitching and
         -- coming out extraordinary.
         WHERE year = ? AND split_id = 1 AND league_id != 0 AND level_id = ?
               ${idFilter} GROUP BY player_id`
      )
      .all(statYear, teamRow.level, ...rosterIds) as Array<Record<string, number>>;
    for (const row of rows) {
      battingByPlayer.set(row.player_id, computeBatting(row, baseline, teamId));
    }
  }

  // OOTP's own 20-80 grades, for cross-checking against the game's own screens
  const playerValues = valuesByPlayer();

  /*
   * Where each man stands: designated, on waivers, on the injured list, or
   * simply active. OOTP's roster list keeps designated players on it, so
   * without this a man on the DFA clock reads as a regular — which is exactly
   * how the manager came to call one the starting third baseman.
   */
  const standingByPlayer = new Map<number, ReturnType<typeof standingOf>>();
  if (tableExists('players_roster_status') && rosterIds.length > 0) {
    // Named one at a time against the export's own schema: OOTP's roster-status
    // table has varied, and a column this app expects but a save does not have
    // would take the whole roster page down rather than losing one badge
    const statusCols = tableColumns('players_roster_status');
    const want = [
      'is_active', 'is_on_dl', 'is_on_dl60',
      'designated_for_assignment', 'days_on_dfa_left', 'is_on_waivers',
    ].filter((c) => statusCols.includes(c));
    const rows = db
      .prepare(
        `SELECT rs.player_id${want.map((c) => `, rs."${c}"`).join('')},
                p.injury_is_injured, p.injury_dtd_injury, p.injury_left
         FROM players_roster_status rs JOIN players p ON p.player_id = rs.player_id
         WHERE rs.player_id IN (${rosterIds.map(() => '?').join(',')})`
      )
      .all(...rosterIds) as Array<StandingFields & { player_id: number }>;
    for (const r of rows) standingByPlayer.set(r.player_id, standingOf(r));
  }

  // Contact quality for the whole roster in one pass — the batted-ball table is
  // large, so it is queried once per page rather than once per player
  const contactByPlayer = contactProfiles(players.map((p) => p.player_id as number));

  // Season fielding for the roster's optional defensive columns. Summed across
  // positions: a utility man's total workload is the useful number in a roster
  // row, and his split by position is on his card.
  const fieldingByPlayer = new Map<number, Record<string, number | null>>();
  if (tableExists('players_career_fielding_stats') && statYear !== null) {
    const rows = db
      .prepare(
        `SELECT player_id, SUM(g) AS fg, SUM(gs) AS fgs, SUM(ip) AS finn,
                SUM(po) AS po, SUM(a) AS a, SUM(e) AS e, SUM(dp) AS dp
         FROM players_career_fielding_stats
         -- No split filter: OOTP writes the CURRENT season's fielding with
         -- split_id 0 and past seasons with 1, so filtering on 1 silently
         -- dropped this year entirely. Each year carries exactly one split id,
         -- so leaving it out cannot double count. Batting and pitching are
         -- different — they really do split 1/2/3 — and keep their filter.
         --
         -- This club's level, for the same reason the batting above is: a man
         -- who has shuttled fields at each, and adding them together describes
         -- nobody. On this roster it was showing 587 innings and six errors
         -- for a shortstop who has played 28 innings in the majors and made
         -- none of them.
         WHERE year = ? AND level_id = ? ${idFilter} GROUP BY player_id`
      )
      .all(statYear, teamRow?.level ?? 1, ...rosterIds) as Array<Record<string, number>>;
    for (const r of rows) {
      const chances = (r.po ?? 0) + (r.a ?? 0) + (r.e ?? 0);
      const innings = r.finn ?? 0;
      fieldingByPlayer.set(r.player_id, {
        fg: r.fg ?? 0,
        fgs: r.fgs ?? 0,
        finn: innings,
        po: r.po ?? 0,
        a: r.a ?? 0,
        e: r.e ?? 0,
        dp: r.dp ?? 0,
        fpct: chances > 0 ? Math.round(((r.po + r.a) / chances) * 1000) / 1000 : null,
        // Chances handled per nine innings — the standard way to express range
        rf9: innings > 0 ? Math.round((((r.po + r.a) / innings) * 9) * 100) / 100 : null,
      });
    }
  }

  const pitchingByPlayer = new Map<number, Record<string, number | null>>();
  if (tableExists('players_career_pitching_stats') && statYear !== null && baseline && teamRow) {
    const rows = db
      .prepare(
        `SELECT player_id, SUM(outs) AS outs, SUM(er) AS er, SUM(ra) AS ra, SUM(ha) AS ha,
                SUM(bb) AS bb, SUM(k) AS k, SUM(hra) AS hra, SUM(bf) AS bf, SUM(g) AS g,
                SUM(gs) AS gs, SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv, SUM(hld) AS hld,
                SUM(war) AS war
         FROM players_career_pitching_stats
         -- This club's level only, for the same reason as the batting above
         WHERE year = ? AND split_id = 1 AND league_id != 0 AND level_id = ?
               ${idFilter} GROUP BY player_id`
      )
      .all(statYear, teamRow.level, ...rosterIds) as Array<Record<string, number>>;
    for (const row of rows) {
      pitchingByPlayer.set(row.player_id, computePitching(row, baseline, teamId));
    }
  }

  // Scale bar rendering to the highest rating in this export
  let ratingMax = 0;
  for (const r of ratingsByPlayer.values()) {
    for (const v of Object.values(r)) {
      if (typeof v === 'number' && v > ratingMax) ratingMax = v;
    }
  }

  const roster = players.map((p) => {
    const id = p.player_id as number;
    const pos = p.position as number | null;
    return {
      ...p,
      positionName: pos !== null && POSITION_NAMES[pos] ? POSITION_NAMES[pos] : String(pos ?? '?'),
      batsName: BATS[p.bats as number] ?? String(p.bats ?? '?'),
      throwsName: THROWS[p.throws as number] ?? String(p.throws ?? '?'),
      ratings: ratingsByPlayer.get(id) ?? {},
      fielding: fieldingByPlayer.get(id) ?? null,
      oaRating: playerValues.get(id)?.oaRating ?? null,
      potRating: playerValues.get(id)?.potRating ?? null,
      batting: battingByPlayer.get(id) ?? null,
      pitching: pitchingByPlayer.get(id) ?? null,
      contact: contactByPlayer.get(id) ?? null,
      standing: standingByPlayer.get(id) ?? null,
    };
  });

  res.json({ players: roster, ratingMax, ratingKeys: [...ratingSources.keys()] });
});
