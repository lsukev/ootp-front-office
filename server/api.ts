import { Router } from 'express';
import fs from 'node:fs';
import { db, tableExists, tableColumns, locateColumn } from './db.js';
import { detectSaves } from './paths.js';
import { loadConfig, saveConfig } from './config.js';
import { importCsvDir, type ImportResult } from './importer.js';
import { startWatcher } from './watcher.js';
import { orgRoutes } from './org.js';
import { contractRoutes } from './contracts.js';
import { freeAgentRoutes } from './freeagents.js';
import { lineupRoutes } from './lineup.js';
import { storylineRoutes } from './storylines.js';
import { playerRoutes } from './player.js';
import { historyRoutes, takeSnapshot } from './history.js';
import { dashboardRoutes } from './dashboard.js';
import { rosterOpsRoutes } from './rosterops.js';
import { tradeRoutes } from './trade.js';
import { aiRoutes } from './ai.js';
import { logoRoutes } from './logos.js';

export const api = Router();
api.use(logoRoutes);
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

const META_PATH = new URL('../data/last-import.json', import.meta.url);

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
    fs.writeFileSync(META_PATH, JSON.stringify(importState.lastImport));
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

  // Current-season batting stats (split_id 1 = overall, latest year in export)
  const battingByPlayer = new Map<number, Record<string, number>>();
  const bt = 'players_career_batting_stats';
  if (tableExists(bt)) {
    const bcols = tableColumns(bt);
    const year = bcols.includes('year')
      ? (db.prepare(`SELECT MAX(year) AS y FROM "${bt}"`).get() as { y: number }).y
      : null;
    const statCols = ['ab', 'h', 'd', 't', 'hr', 'bb', 'hp', 'k', 'sf', 'sb', 'cs', 'r', 'rbi', 'pa'].filter(
      (c) => bcols.includes(c)
    );
    if (statCols.length && bcols.includes('player_id')) {
      const sums = statCols.map((c) => `SUM("${c}") AS "${c}"`).join(', ');
      const where = [
        year !== null ? `year = ${year}` : null,
        bcols.includes('split_id') ? `split_id = 1` : null,
      ]
        .filter(Boolean)
        .join(' AND ');
      const rows = db
        .prepare(`SELECT player_id, ${sums} FROM "${bt}" ${where ? `WHERE ${where}` : ''} GROUP BY player_id`)
        .all() as Array<Record<string, number>>;
      for (const row of rows) battingByPlayer.set(row.player_id, row);
    }
  }

  // Current-season pitching stats
  const pitchingByPlayer = new Map<number, Record<string, number>>();
  const pt = 'players_career_pitching_stats';
  if (tableExists(pt)) {
    const pcols = tableColumns(pt);
    const year = pcols.includes('year')
      ? (db.prepare(`SELECT MAX(year) AS y FROM "${pt}"`).get() as { y: number }).y
      : null;
    const statCols = ['ip', 'ipf', 'outs', 'er', 'bb', 'k', 'ha', 'hra', 'g', 'gs', 'w', 'l', 's'].filter((c) =>
      pcols.includes(c)
    );
    if (statCols.length && pcols.includes('player_id')) {
      const sums = statCols.map((c) => `SUM("${c}") AS "${c}"`).join(', ');
      const where = [
        year !== null ? `year = ${year}` : null,
        pcols.includes('split_id') ? `split_id = 1` : null,
      ]
        .filter(Boolean)
        .join(' AND ');
      const rows = db
        .prepare(`SELECT player_id, ${sums} FROM "${pt}" ${where ? `WHERE ${where}` : ''} GROUP BY player_id`)
        .all() as Array<Record<string, number>>;
      for (const row of rows) pitchingByPlayer.set(row.player_id, row);
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
