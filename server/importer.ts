import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { db } from './db.js';

export interface ImportResult {
  tables: number;
  rows: number;
  startedAt: string;
  finishedAt: string;
  files: Array<{ table: string; rows: number }>;
}

const NUMERIC = /^-?\d+(\.\d+)?$/;

function sanitizeIdent(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

function decodeCsv(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  let text = buf.toString('utf8');
  // OOTP exports can be Latin-1; fall back if UTF-8 decoding produced
  // replacement characters (accented player names, etc.)
  if (text.includes('�')) text = buf.toString('latin1');
  return text;
}

/**
 * Works out which character separates the fields.
 *
 * OOTP has an "Export Field Delimiter" setting, and it is not always a comma —
 * semicolon is common on European locales, where a comma is the decimal
 * separator. Reading a semicolon file as comma-delimited produces one giant
 * column per row, so the table ends up with a single column named
 * `team_id;name;abbr;...` and every query fails with "no such column: team_id".
 *
 * The header row decides it: whichever candidate appears most often outside
 * quotes is the separator. A one-column file legitimately has none of them, in
 * which case the choice does not matter and comma is as good as any.
 */
function detectDelimiter(text: string): string {
  const header = text.slice(0, text.indexOf('\n') === -1 ? undefined : text.indexOf('\n'));
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    let count = 0;
    let inQuotes = false;
    for (const ch of header) {
      if (ch === '"') inQuotes = !inQuotes;
      else if (ch === candidate && !inQuotes) count += 1;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Import every CSV in the export directory into SQLite, one table per file,
 * columns taken from each file's header row. Values that look numeric are
 * stored as numbers so comparisons and math work in SQL.
 */
export function importCsvDir(csvDir: string): ImportResult {
  const startedAt = new Date().toISOString();
  const files = fs
    .readdirSync(csvDir)
    .filter((f) => f.endsWith('.csv'))
    .sort();
  if (files.length === 0) throw new Error(`No .csv files found in ${csvDir}`);

  const result: ImportResult['files'] = [];
  let totalRows = 0;

  for (const file of files) {
    const tableName = sanitizeIdent(file.replace(/\.csv$/, ''));
    const text = decodeCsv(path.join(csvDir, file));
    let records: string[][];
    try {
      records = parse(text, {
        delimiter: detectDelimiter(text),
        relax_column_count: true,
        relax_quotes: true,
        skip_empty_lines: true,
      }) as string[][];
    } catch (err) {
      console.warn(`[import] Skipping ${file}: parse error — ${(err as Error).message}`);
      continue;
    }
    if (records.length < 1) continue;

    const header = records[0].map((h, i) => sanitizeIdent(h.trim() || `col_${i}`));
    const dataRows = records.slice(1);

    const columnDefs = header.map((h) => `"${h}"`).join(', ');
    const placeholders = header.map(() => '?').join(', ');

    db.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    db.exec(`CREATE TABLE "${tableName}" (${columnDefs})`);
    const insert = db.prepare(`INSERT INTO "${tableName}" VALUES (${placeholders})`);

    const insertAll = db.transaction((rows: string[][]) => {
      for (const row of rows) {
        const values = header.map((_, i) => {
          const v = row[i];
          if (v === undefined || v === '') return null;
          return NUMERIC.test(v) ? Number(v) : v;
        });
        insert.run(values);
      }
    });
    insertAll(dataRows);

    result.push({ table: tableName, rows: dataRows.length });
    totalRows += dataRows.length;
  }

  buildIndexes();

  return {
    tables: result.length,
    rows: totalRows,
    startedAt,
    finishedAt: new Date().toISOString(),
    files: result,
  };
}

/**
 * Indexes the columns every page actually filters on.
 *
 * The import creates plain tables with no indexes, so a lookup like "this
 * player's career stats" scanned all 679,000 rows of players_career_batting_stats.
 * Nothing was obviously broken — the app just did far more work than it needed
 * to on every page, and a player card cost about 0.4s of that.
 *
 * Columns are discovered rather than listed, because the importer is
 * deliberately schema-tolerant: OOTP adds and renames fields between versions,
 * and a hardcoded list would quietly stop covering new tables.
 */
export function buildIndexes(): void {
  const started = Date.now();
  // Startup calls this on every launch; once the indexes exist there is nothing
  // to do and the check costs a single query
  const existing = (
    db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)
      .get() as { n: number }
  ).n;
  if (existing > 0) return;
  const tables = (
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
  ).map((t) => t.name);

  let made = 0;
  for (const table of tables) {
    const columns = new Set(
      (db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>).map((c) => c.name)
    );
    for (const column of ['player_id', 'team_id', 'game_id', 'league_id']) {
      if (!columns.has(column)) continue;
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS "idx_${table}_${column}" ON "${table}" ("${column}")`);
        made += 1;
      } catch (err) {
        // A malformed table should not fail the whole import
        console.warn(`[import] index on ${table}.${column} failed:`, (err as Error).message);
      }
    }
  }
  // Lets SQLite pick between the indexes it now has rather than guessing
  db.exec('ANALYZE');
  console.log(`[import] ${made} indexes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
