import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'league.db'));
db.pragma('journal_mode = WAL');

export function tableExists(name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function tableColumns(name: string): string[] {
  if (!tableExists(name)) return [];
  return (db.prepare(`PRAGMA table_info("${name.replace(/"/g, '')}")`).all() as { name: string }[]).map(
    (r) => r.name
  );
}

/**
 * Whether a table has every column named.
 *
 * `tableExists` is not enough on its own. OOTP's CSV export changes shape
 * between versions, and a table that is present with an older set of columns
 * passes the existence check and then throws "no such column" the moment it is
 * queried — which reaches the reader as a bare 500 with nothing to act on.
 * Ask for the columns a query actually needs.
 */
export function hasColumns(table: string, ...columns: string[]): boolean {
  const present = new Set(tableColumns(table));
  return columns.every((c) => present.has(c));
}

/**
 * Find where a column lives. OOTP's CSV schema shifts slightly between
 * versions, so callers pass candidate (table, column) pairs and get back the
 * first one that exists in the imported data.
 */
export function locateColumn(candidates: Array<[table: string, column: string]>): [string, string] | null {
  for (const [table, column] of candidates) {
    if (tableColumns(table).includes(column)) return [table, column];
  }
  return null;
}

/**
 * OOTP writes dates unpadded — "2027-9-3" as readily as "2027-09-03" — so a
 * text sort puts the ninth of a month after the twenty-third. This turns a
 * date column into a sortable number and is the shared fix for a fault that
 * has appeared on the schedule, on snapshots, on the transaction wire and in
 * the recap's idea of which day was yesterday.
 */
export const DATE_KEY = (col: string) => `(
  CAST(substr(${col}, 1, 4) AS INTEGER) * 10000 +
  CAST(substr(${col}, 6, CASE WHEN substr(${col}, 7, 1) = '-' THEN 1 ELSE 2 END) AS INTEGER) * 100 +
  CAST(substr(${col}, 6 + CASE WHEN substr(${col}, 7, 1) = '-' THEN 2 ELSE 3 END) AS INTEGER)
)`;
