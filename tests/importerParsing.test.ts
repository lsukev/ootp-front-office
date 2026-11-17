import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from '../server/db.js';
import { importCsvDir } from '../server/importer.js';

/**
 * What the CSV reader is actually asked to cope with.
 *
 * The importer hands csv-parse four options and every row in this app arrives
 * through them. They had no test of their own: the import was covered for
 * progress reporting and for how it builds tables, and not at all for how it
 * reads a file. That was fine until the parser needed a major version bump for
 * a security advisory, at which point there was nothing to say whether the new
 * one still read an OOTP export the same way.
 *
 * Each of these is one of those four options, exercised through the real
 * import rather than against the parser directly — the question is not whether
 * csv-parse works, it is whether this app still gets the rows it did.
 */

function exportDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ootp-parse-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

const rows = (table: string) =>
  db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;

describe('reading an export', () => {
  it('reads a plain comma file', async () => {
    await importCsvDir(exportDir({
      'plain_table.csv': 'id,name,age\n1,Alpha,25\n2,Beta,31',
    }));
    expect(rows('plain_table')).toEqual([
      { id: 1, name: 'Alpha', age: 25 },
      { id: 2, name: 'Beta', age: 31 },
    ]);
  });

  /*
   * A semicolon export, which is what OOTP writes on a European locale where
   * the comma is the decimal separator. Read as commas the whole row becomes
   * one column called `id;name;age` and every query against it fails.
   */
  it('detects a semicolon delimiter from the header', async () => {
    await importCsvDir(exportDir({
      'euro_table.csv': 'id;name;age\n1;Alpha;25\n2;Beta;31',
    }));
    expect(Object.keys(rows('euro_table')[0])).toEqual(['id', 'name', 'age']);
    expect(rows('euro_table')[1].name).toBe('Beta');
  });

  it('detects a tab delimiter', async () => {
    await importCsvDir(exportDir({
      'tabbed_table.csv': 'id\tname\n1\tAlpha\n2\tBeta',
    }));
    expect(Object.keys(rows('tabbed_table')[0])).toEqual(['id', 'name']);
  });

  /*
   * relax_column_count. OOTP writes short and long rows — a trailing delimiter
   * here, a missing field there — and a parser that throws on the first one
   * loses the entire table rather than the row.
   */
  it('keeps a file whose rows do not all have the same number of fields', async () => {
    await importCsvDir(exportDir({
      'ragged_table.csv': 'id,name,age\n1,Alpha,25\n2,Beta\n3,Gamma,19,extra',
    }));
    const got = rows('ragged_table');
    expect(got, 'a ragged row must cost that row at most, never the table').toHaveLength(3);
    expect(got[1].name).toBe('Beta');
    expect(got[2].name).toBe('Gamma');
  });

  /*
   * relax_quotes. A quote in the middle of an unquoted field is malformed CSV
   * and OOTP emits it in player nicknames and park names.
   */
  it('keeps a file with a stray quote inside a field', async () => {
    await importCsvDir(exportDir({
      'quoted_table.csv': 'id,name\n1,Dan "The Man" Smith\n2,Plain',
    }));
    const got = rows('quoted_table');
    expect(got, 'a stray quote must not cost the table').toHaveLength(2);
    expect(String(got[0].name)).toContain('Man');
  });

  it('reads a properly quoted field containing the delimiter', async () => {
    await importCsvDir(exportDir({
      'commas_table.csv': 'id,name\n1,"Smith, Dan"\n2,Plain',
    }));
    expect(rows('commas_table')[0].name).toBe('Smith, Dan');
  });

  /* skip_empty_lines. Exports end with a blank line, and some have them inside. */
  it('ignores blank lines rather than importing them as rows', async () => {
    await importCsvDir(exportDir({
      'blanks_table.csv': 'id,name\n1,Alpha\n\n2,Beta\n\n',
    }));
    expect(rows('blanks_table')).toHaveLength(2);
  });

  it('reads a file with Windows line endings, which is what OOTP writes', async () => {
    await importCsvDir(exportDir({
      'crlf_table.csv': 'id,name\r\n1,Alpha\r\n2,Beta\r\n',
    }));
    const got = rows('crlf_table');
    expect(got).toHaveLength(2);
    expect(got[1].name, 'a carriage return left on the value is the classic symptom').toBe('Beta');
  });

  it('keeps a numeric-looking value numeric and a textual one textual', async () => {
    await importCsvDir(exportDir({
      'types_table.csv': 'id,era,name\n1,3.25,Alpha',
    }));
    const row = rows('types_table')[0];
    expect(typeof row.id).toBe('number');
    expect(row.era).toBe(3.25);
    expect(typeof row.name).toBe('string');
  });

  it('survives a file with a header and no rows at all', async () => {
    const dir = exportDir({
      'empty_table.csv': 'id,name\n',
      'other_table.csv': 'id,name\n1,Alpha',
    });
    const result = await importCsvDir(dir);
    expect(result.tables, 'an empty file must not stop the files after it').toBeGreaterThanOrEqual(1);
    expect(rows('other_table')).toHaveLength(1);
  });
});
