import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { importCsvDir, type ImportProgress } from '../server/importer.js';

/**
 * An import that reports where it has got to, and answers while it does.
 *
 * A reader pressed Refresh and watched the app hang for thirty seconds and then
 * simply work, with no way to tell whether it was busy or broken. The cause was
 * not the length of the import but its shape: seventy files and three hundred
 * megabytes read in one synchronous run, on a single-threaded server. The page
 * could poll for progress all it liked — the reply was queued behind the very
 * work it was asking about.
 *
 * So the loop yields between chunks now. These hold down the two properties
 * that makes possible: that it says where it is, and that it genuinely gives
 * the event loop back rather than merely claiming to.
 */

function tinyExport(rows: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ootp-import-'));
  const body = Array.from({ length: rows }, (_, i) => `${i},Player ${i},${20 + (i % 15)}`).join('\n');
  fs.writeFileSync(path.join(dir, 'alpha_table.csv'), `id,name,age\n${body}`);
  fs.writeFileSync(path.join(dir, 'beta_table.csv'), `id,note\n1,first\n2,second`);
  return dir;
}

describe('importing an export', () => {
  it('reports every file it touches, in order', async () => {
    const seen: ImportProgress[] = [];
    const result = await importCsvDir(tinyExport(50), (p) => seen.push({ ...p }));

    expect(result.tables).toBe(2);
    expect(seen.length).toBeGreaterThan(0);
    // Files are numbered from one, so the reader sees "1 of 2" not "0 of 2"
    expect(Math.min(...seen.map((p) => p.fileIndex))).toBe(1);
    expect(Math.max(...seen.map((p) => p.fileIndex))).toBe(2);
    for (const p of seen) expect(p.files).toBe(2);
  });

  it('names the table it is working on', async () => {
    const seen: ImportProgress[] = [];
    await importCsvDir(tinyExport(10), (p) => seen.push({ ...p }));
    const tables = new Set(seen.map((p) => p.table));
    expect(tables.has('alpha_table')).toBe(true);
    expect(tables.has('beta_table')).toBe(true);
  });

  it('says when it is reading and when it is writing', async () => {
    const seen: ImportProgress[] = [];
    await importCsvDir(tinyExport(10), (p) => seen.push({ ...p }));
    const phases = new Set(seen.map((p) => p.phase));
    expect(phases.has('reading')).toBe(true);
    expect(phases.has('writing')).toBe(true);
    // The indexes are built last and take their own visible moment
    expect(seen[seen.length - 1].phase).toBe('indexing');
  });

  it('never counts rows backwards', async () => {
    // A bar that goes back on itself reads as a fault even when nothing is wrong
    const rows: number[] = [];
    await importCsvDir(tinyExport(120), (p) => rows.push(p.rows));
    for (let i = 1; i < rows.length; i++) expect(rows[i]).toBeGreaterThanOrEqual(rows[i - 1]);
  });

  it('gives the event loop back while it runs', async () => {
    /*
     * The point of the whole change. A timer set before the import must get its
     * turn before the import finishes — under the old synchronous loop it could
     * not, which is exactly why the page froze.
     */
    let tickedDuring = false;
    const timer = setInterval(() => { tickedDuring = true; }, 5);
    await importCsvDir(tinyExport(60_000));
    clearInterval(timer);
    expect(tickedDuring, 'the import never yielded — the server would be frozen').toBe(true);
  });

  it('counts every row it was given', async () => {
    const result = await importCsvDir(tinyExport(45_000));
    // 45,000 in one table plus two in the other, across the chunk boundary
    expect(result.rows).toBe(45_002);
  });
});
