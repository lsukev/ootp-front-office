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

  return {
    tables: result.length,
    rows: totalRows,
    startedAt,
    finishedAt: new Date().toISOString(),
    files: result,
  };
}
