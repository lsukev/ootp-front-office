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
