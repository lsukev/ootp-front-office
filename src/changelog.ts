/**
 * The release notes, in the app.
 *
 * "Users are complaining about having to go to GitHub to read the notes."
 *
 * They were right to. Every version has had notes written for it since 0.9.6,
 * and the only place to read them was a web page — in a desktop app whose whole
 * point is that it works with no network at all.
 *
 * So the notes ship inside the build. The changelog files in the repo are the
 * source, bundled at build time rather than fetched, which also means the notes
 * you are reading are exactly the ones written for the version you are running:
 * they cannot be a version ahead, and they cannot fail to load.
 *
 * This module is the parsing only, with no bundler in it, so it can be tested
 * against the real files.
 */

export interface NoteItem {
  /** "New", "Fixed", "Changed" — whatever the entry was filed under. */
  label: string | null;
  paragraphs: string[];
}

export interface ReleaseNote {
  version: string;
  /** The version this one followed, which the title line names. */
  since: string | null;
  items: NoteItem[];
}

/**
 * The version a changelog file is for, or null if it is not one.
 *
 * The bbcode copies are the same notes marked up for the forum, and rendering
 * both would list every version twice.
 */
export function versionOf(path: string): string | null {
  const match = /CHANGELOG-(\d+\.\d+\.\d+)\.txt$/.exec(path);
  return match ? match[1] : null;
}

/**
 * Newest first.
 *
 * Compared as numbers per segment, not as text: 0.9.6 is older than 0.11.0 and
 * a string sort puts it in the middle of the list, which is exactly the kind of
 * ordering fault this app has had to fix three times elsewhere.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/*
 * A label is a short word at the head of a paragraph followed by an em dash —
 * "New", "Fixed", "Changed", "Better" so far. Matched by shape rather than
 * against a list of the four, so filing something under a new word next year
 * does not silently render it as body text.
 */
const LABEL = /^([A-Z][A-Za-z]{2,11}) — /;

export function parseChangelog(version: string, text: string): ReleaseNote {
  const paragraphs = text.split(/\n\s*\n/).map((p) => p.trim()).filter((p) => p.length > 0);
  const title = paragraphs[0] ?? '';
  const since = /everything since ([\d.]+)/.exec(title)?.[1] ?? null;

  const items: NoteItem[] = [];
  // The title line is dropped: it repeats the version, which the row already
  // says, and "everything since x" is shown as its own line
  for (const paragraph of paragraphs.slice(1)) {
    const label = LABEL.exec(paragraph);
    if (label) {
      items.push({ label: label[1], paragraphs: [paragraph.slice(label[0].length)] });
    } else if (items.length > 0) {
      // An unlabelled paragraph continues the entry above it rather than
      // starting one — that is how these have been written from the beginning
      items[items.length - 1].paragraphs.push(paragraph);
    } else {
      items.push({ label: null, paragraphs: [paragraph] });
    }
  }
  return { version, since, items };
}
