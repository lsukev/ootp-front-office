import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists, tableColumns, locateColumn } from './db.js';
import { detectSaves, resolveChosenFolder, searchLocations } from './paths.js';
import { DATA_DIR, loadConfig, saveConfig } from './config.js';
import { importCsvDir, type ImportResult } from './importer.js';
import { clearPendingExport, pendingExport, startWatcher } from './watcher.js';
import { orgRoutes } from './org.js';
import { contractRoutes } from './contracts.js';
import { freeAgentRoutes } from './freeagents.js';
import { lineupRoutes } from './lineup.js';
import { storylineRoutes } from './storylines.js';
import { playerRoutes } from './player.js';
import { historyRoutes, takeSnapshot } from './history.js';
import { clearStatCaches, computeBatting, computePitching, leagueBaseline } from './stats.js';
import { dashboardRoutes } from './dashboard.js';
import { rosterOpsRoutes } from './rosterops.js';
import { tradeRoutes } from './trade.js';
import { aiRoutes } from './ai.js';
import { logoRoutes } from './logos.js';
import { settingsRoutes } from './settings.js';
import { leagueRoutes } from './league.js';
import { pitchingRoutes } from './pitching.js';
import { scheduleRoutes } from './schedule.js';
import { payrollRoutes } from './payroll.js';
import { trendsRoutes } from './trends.js';
import { chatRoutes } from './chat.js';

export const api = Router();
api.use(logoRoutes);
api.use(settingsRoutes);
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
    try {
      takeSnapshot(); // development-tracking snapshot, keyed by in-game date
    } catch (err) {
      console.error('[history] snapshot failed:', err);
    }
    console.log(
      `[import] ${importState.lastImport.tables} tables, ${importState.lastImport.rows} rows imported`
    );
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

  const players = db
    .prepare(`SELECT ${select} FROM players WHERE team_id = ?`)
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
  const ratingsByPlayer = new Map<number, Record<string, unknown>>();
  for (const [table, specs] of byTable) {
    if (!tableColumns(table).includes('player_id')) continue;
    const sel = specs.map((s) => `"${s.column}" AS "${s.key}"`).join(', ');
    const rows = db
      .prepare(`SELECT player_id, ${sel} FROM "${table}"`)
      .all() as Array<Record<string, unknown> & { player_id: number }>;
    for (const row of rows) {
      const existing = ratingsByPlayer.get(row.player_id) ?? {};
      const { player_id, ...rest } = row;
      ratingsByPlayer.set(player_id, { ...existing, ...rest });
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
  if (tableExists('players_career_batting_stats') && statYear !== null && baseline) {
    const rows = db
      .prepare(
        `SELECT player_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d, SUM(t) AS t3,
                SUM(hr) AS hr, SUM(bb) AS bb, SUM(ibb) AS ibb, SUM(hp) AS hp, SUM(sf) AS sf,
                SUM(k) AS k, SUM(sb) AS sb, SUM(cs) AS cs, SUM(r) AS r, SUM(rbi) AS rbi,
                SUM(war) AS war
         FROM players_career_batting_stats
         WHERE year = ? AND split_id = 1 GROUP BY player_id`
      )
      .all(statYear) as Array<Record<string, number>>;
    for (const row of rows) {
      battingByPlayer.set(row.player_id, computeBatting(row, baseline, teamId));
    }
  }

  const pitchingByPlayer = new Map<number, Record<string, number | null>>();
  if (tableExists('players_career_pitching_stats') && statYear !== null && baseline) {
    const rows = db
      .prepare(
        `SELECT player_id, SUM(outs) AS outs, SUM(er) AS er, SUM(ra) AS ra, SUM(ha) AS ha,
                SUM(bb) AS bb, SUM(k) AS k, SUM(hra) AS hra, SUM(bf) AS bf, SUM(g) AS g,
                SUM(gs) AS gs, SUM(w) AS w, SUM(l) AS l, SUM(s) AS sv, SUM(hld) AS hld,
                SUM(war) AS war
         FROM players_career_pitching_stats
         WHERE year = ? AND split_id = 1 GROUP BY player_id`
      )
      .all(statYear) as Array<Record<string, number>>;
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
      batting: battingByPlayer.get(id) ?? null,
      pitching: pitchingByPlayer.get(id) ?? null,
    };
  });

  res.json({ players: roster, ratingMax, ratingKeys: [...ratingSources.keys()] });
});
