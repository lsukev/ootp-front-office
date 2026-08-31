/// <reference types="vite/client" />
import { useEffect, useState } from 'react';
import { compareVersions, parseChangelog, versionOf, type ReleaseNote } from './changelog';

/**
 * Every version's notes, read in the app rather than on GitHub.
 *
 * The changelog files are bundled at build time, one lazy chunk each, so the
 * list costs nothing until a version is opened and the whole history works
 * with the network off. That matters more here than it looks: this is a
 * desktop app people run beside a game, and being sent to a browser to find
 * out what changed was the complaint that started this.
 */

/*
 * The bbcode copies are excluded in the pattern rather than filtered after the
 * fact: a filtered-out match is still a chunk the bundler emits, so globbing
 * both put fifty files nobody can open into the build.
 */
const SOURCES = import.meta.glob(['/CHANGELOG-*.txt', '!/CHANGELOG-*-bbcode.txt'], {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>;

const VERSIONS = Object.entries(SOURCES)
  .map(([path, load]) => ({ version: versionOf(path), load }))
  .filter((v): v is { version: string; load: () => Promise<string> } => v.version !== null)
  .sort((a, b) => compareVersions(a.version, b.version));

/** How many rows before the list needs asking for. */
const FIRST_PAGE = 8;

export function ReleaseNotes() {
  const [open, setOpen] = useState<string | null>(VERSIONS[0]?.version ?? null);
  const [notes, setNotes] = useState<Record<string, ReleaseNote>>({});
  const [failed, setFailed] = useState<string | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    if (!open || notes[open]) return;
    const entry = VERSIONS.find((v) => v.version === open);
    if (!entry) return;
    let live = true;
    void entry
      .load()
      .then((text) => {
        if (live) setNotes((prev) => ({ ...prev, [open]: parseChangelog(open, text) }));
      })
      .catch(() => {
        if (live) setFailed(open);
      });
    return () => {
      live = false;
    };
  }, [open, notes]);

  if (VERSIONS.length === 0) return null;

  const shown = all ? VERSIONS : VERSIONS.slice(0, FIRST_PAGE);

  return (
    <section className="settings-block">
      <h2>What&rsquo;s new</h2>
      <p className="muted settings-lede">
        The notes for every version, including the one you are running. They ship with the app, so
        this works with the network off.
      </p>

      <ol className="release-list">
        {shown.map((entry, i) => {
          const note = notes[entry.version];
          const isOpen = open === entry.version;
          return (
            <li key={entry.version} className={isOpen ? 'release-entry open' : 'release-entry'}>
              <button
                className="release-head"
                aria-expanded={isOpen}
                onClick={() => setOpen(isOpen ? null : entry.version)}
              >
                <span className="release-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="release-version">{entry.version}</span>
                {/*
                  The newest notes bundled are the running version's by
                  construction — the changelog and the version bump are written
                  in the same commit, and both are baked into the build.
                */}
                {i === 0 && !all && <span className="release-current">This version</span>}
              </button>

              {isOpen && (
                <div className="release-body">
                  {failed === entry.version && (
                    <p className="muted">These notes could not be read from the app bundle.</p>
                  )}
                  {!note && failed !== entry.version && <p className="muted">Reading…</p>}
                  {/*
                    In the body rather than on the row: the row only knows what
                    a version followed once its notes have been read, so half
                    the collapsed list said "since" and the other half did not.
                  */}
                  {note?.since && (
                    <p className="muted release-since">Everything since {note.since}</p>
                  )}
                  {note?.items.map((item, j) => (
                    <div key={j} className="release-item">
                      {item.label && (
                        <span className={`release-label ${item.label.toLowerCase()}`}>
                          {item.label}
                        </span>
                      )}
                      {item.paragraphs.map((paragraph, k) => (
                        <p key={k}>{paragraph}</p>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {!all && VERSIONS.length > FIRST_PAGE && (
        <button className="link-button" onClick={() => setAll(true)}>
          Show all {VERSIONS.length} versions
        </button>
      )}
    </section>
  );
}
