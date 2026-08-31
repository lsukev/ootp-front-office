import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { compareVersions, parseChangelog, versionOf } from '../src/changelog.js';

/**
 * The release notes, read in the app.
 *
 * "I want release notes to start being within the app... Users are complaining
 * about having to go to GitHub to read the notes."
 *
 * The notes are the repo's own changelog files, bundled into the build. That
 * makes these files a rendering input rather than a document nobody parses, so
 * these tests run over all fifty of the real ones — a note written in a shape
 * the panel cannot render is now a broken feature, and it should fail here
 * rather than in front of a reader.
 */

const ROOT = path.join(__dirname, '..');
const FILES = fs
  .readdirSync(ROOT)
  .filter((f) => /^CHANGELOG-\d+\.\d+\.\d+\.txt$/.test(f))
  .sort();

describe('which files are notes', () => {
  it('takes a changelog for a version', () => {
    expect(versionOf('/CHANGELOG-0.36.0.txt')).toBe('0.36.0');
    expect(versionOf('/some/nested/CHANGELOG-1.2.30.txt')).toBe('1.2.30');
  });

  /*
   * The forum copies are the same notes in bbcode. Listing both would show
   * every version twice, and the second copy would render its markup as text.
   */
  it('leaves the forum copies out', () => {
    expect(versionOf('/CHANGELOG-0.36.0-bbcode.txt')).toBeNull();
  });

  it('ignores anything that is not a changelog', () => {
    expect(versionOf('/FORUM_POST.md')).toBeNull();
    expect(versionOf('/CHANGELOG.txt')).toBeNull();
  });
});

/**
 * Text sorting is the fault this app has had to fix three times — unpadded
 * dates on the schedule, on snapshots and on transactions. It is the same
 * fault here: as text, "0.9.6" sorts after "0.11.0" and the oldest release in
 * the app would be listed as the newest, with "This version" against it.
 */
describe('the order versions are listed in', () => {
  it('puts 0.9.6 below 0.11.0, where a text sort would not', () => {
    expect(['0.11.0', '0.9.6'].sort(compareVersions)).toEqual(['0.11.0', '0.9.6']);
    expect(['0.9.6', '0.11.0'].sort()).toEqual(['0.11.0', '0.9.6']); // the trap, as text
  });

  /*
   * The panel labels the newest notes it has bundled "This version", and that
   * claim is only true because the changelog and the version bump are written
   * in the same commit. This is what holds that: ship a version without notes
   * and the app would put the tag against the version before it.
   */
  it('has notes for the version being shipped, newest first', () => {
    const shipping = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const versions = FILES.map((f) => versionOf(f)!).sort(compareVersions);
    expect(versions[0], `no CHANGELOG-${shipping}.txt for the version in package.json`).toBe(shipping);
    expect(versions[versions.length - 1]).toBe('0.9.6');
    // Every neighbour is genuinely newer than the one after it
    for (let i = 1; i < versions.length; i += 1) {
      expect(compareVersions(versions[i - 1], versions[i])).toBeLessThan(0);
    }
  });

  it('compares each segment as a number, not a character', () => {
    expect(compareVersions('0.34.10', '0.34.9')).toBeLessThan(0);
    expect(compareVersions('0.2.0', '0.10.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });
});

describe('reading one set of notes', () => {
  const text = [
    'OOTP Front Office 0.36.0 — everything since 0.35.1',
    'New — Pitchers are in the Hot / Cold panel. It read the batting logs and nothing else.',
    'Not earned run average, on purpose. Over a week a reliever throws three innings.',
    'Fixed — The Plan button works on exports shaped differently from mine.',
  ].join('\n\n');

  it('names the version it followed', () => {
    expect(parseChangelog('0.36.0', text).since).toBe('0.35.1');
  });

  it('drops the title line, which only repeats the version', () => {
    const note = parseChangelog('0.36.0', text);
    expect(JSON.stringify(note.items)).not.toContain('OOTP Front Office');
  });

  it('files each entry under its label, with the label taken off the text', () => {
    const { items } = parseChangelog('0.36.0', text);
    expect(items.map((i) => i.label)).toEqual(['New', 'Fixed']);
    expect(items[0].paragraphs[0].startsWith('Pitchers are in')).toBe(true);
  });

  /*
   * An unlabelled paragraph continues the entry above it. Treating it as its
   * own entry would put a second bullet against a sentence that only makes
   * sense as the rest of the one before it.
   */
  it('keeps a follow-on paragraph with the entry it belongs to', () => {
    const { items } = parseChangelog('0.36.0', text);
    expect(items[0].paragraphs).toHaveLength(2);
    expect(items[0].paragraphs[1].startsWith('Not earned run average')).toBe(true);
  });

  it('takes a label it has never seen, rather than only the four in use', () => {
    const { items } = parseChangelog('9.9.9', 'Title\n\nRemoved — The storylines page is gone.');
    expect(items[0].label).toBe('Removed');
  });

  it('does not mistake a sentence with a dash in it for a label', () => {
    const { items } = parseChangelog('9.9.9', 'Title\n\nthe app — which is offline — now reads.');
    expect(items[0].label).toBeNull();
  });

  it('survives notes it cannot make sense of rather than throwing', () => {
    expect(parseChangelog('9.9.9', '').items).toEqual([]);
    expect(parseChangelog('9.9.9', 'Just a title and nothing else').items).toEqual([]);
  });
});

/**
 * Over the real files, because these are now shipped rather than filed.
 */
describe('every set of notes in the repo', () => {
  it('has fifty of them to show', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(50);
  });

  it('renders as at least one entry, with text in it', () => {
    for (const file of FILES) {
      const version = versionOf(file)!;
      const note = parseChangelog(version, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      expect(note.items.length, `${file} produced no entries`).toBeGreaterThan(0);
      for (const item of note.items) {
        expect(item.paragraphs.length, `${file} has an empty entry`).toBeGreaterThan(0);
        for (const paragraph of item.paragraphs) {
          expect(paragraph.trim().length, `${file} has an empty paragraph`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('says which version it follows, so the list reads as a chain', () => {
    for (const file of FILES) {
      const note = parseChangelog(versionOf(file)!, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      expect(note.since, `${file} does not name what it followed`).not.toBeNull();
    }
  });

  it('opens every set under a label rather than as bare prose', () => {
    for (const file of FILES) {
      const note = parseChangelog(versionOf(file)!, fs.readFileSync(path.join(ROOT, file), 'utf8'));
      expect(note.items[0].label, `${file} opens without a label`).not.toBeNull();
    }
  });
});
