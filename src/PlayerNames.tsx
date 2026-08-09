import { useEffect, useState, type ReactNode } from 'react';
import { apiGet } from './api';
import { PlayerLink } from './playerModal';

/**
 * Turns the player names inside a run of prose into hoverable links.
 *
 * The AI features write plain sentences, so the names in a briefing or a
 * storyline are just text — the one place in the app where a name was not
 * clickable. Rather than asking the model to emit markup (which it would get
 * wrong sooner or later, and which would put formatting in its hands), the
 * names are matched against the league's own index after the fact.
 */

type Entry = [id: number, name: string];

let indexPromise: Promise<Entry[]> | null = null;
let indexOrg: number | null = null;

function nameIndex(orgId: number): Promise<Entry[]> {
  if (indexPromise && indexOrg === orgId) return indexPromise;
  indexOrg = orgId;
  indexPromise = apiGet<{ names: Entry[] }>(`/api/name-index/${orgId}`)
    .then((r) => r.names)
    .catch(() => []);
  return indexPromise;
}

/** Regex-safe, since a name can legitimately contain a period or apostrophe. */
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

interface Matcher {
  pattern: RegExp;
  byName: Map<string, number>;
}

function buildMatcher(entries: Entry[]): Matcher | null {
  const byName = new Map<string, number>();
  for (const [id, name] of entries) {
    // Only full names are matched. A surname alone would light up ordinary
    // words — there are players called Young, Price and Story.
    if (name.trim().split(/\s+/).length < 2) continue;
    if (!byName.has(name)) byName.set(name, id);
  }
  if (byName.size === 0) return null;
  // Longest first so "Vladimir Guerrero Jr." wins over "Vladimir Guerrero"
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  return {
    pattern: new RegExp(`\\b(${names.map(escape).join('|')})\\b`, 'g'),
    byName,
  };
}

/** Splits one string into text and linked names. */
function linkify(text: string, matcher: Matcher | null, keyBase: string): ReactNode[] {
  if (!matcher) return [text];
  const out: ReactNode[] = [];
  let last = 0;
  matcher.pattern.lastIndex = 0;
  for (let m = matcher.pattern.exec(text); m !== null; m = matcher.pattern.exec(text)) {
    const id = matcher.byName.get(m[1]);
    if (id === undefined) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <PlayerLink key={`${keyBase}-${m.index}`} id={id}>
        {m[1]}
      </PlayerLink>
    );
    last = m.index + m[1].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [text];
}

/**
 * Renders children, linking any player name found in the plain-text parts.
 * Elements already rendered (a <strong>, an existing link) are passed through
 * untouched, so this can wrap markdown output safely.
 */
export function PlayerNames({ orgId, children }: { orgId: number; children: ReactNode }) {
  const [matcher, setMatcher] = useState<Matcher | null>(null);

  useEffect(() => {
    let cancelled = false;
    void nameIndex(orgId).then((entries) => {
      if (!cancelled) setMatcher(buildMatcher(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const walk = (node: ReactNode, key: string): ReactNode => {
    if (typeof node === 'string') return linkify(node, matcher, key);
    if (Array.isArray(node)) return node.map((n, i) => walk(n, `${key}-${i}`));
    if (node && typeof node === 'object' && 'props' in node) {
      const el = node as React.ReactElement<{ children?: ReactNode }>;
      if (el.props?.children === undefined) return node;
      // Never rewrite inside something that is already a player link
      if (el.type === PlayerLink) return node;
      return { ...el, props: { ...el.props, children: walk(el.props.children, `${key}-c`) } };
    }
    return node;
  };

  return <>{walk(children, 'n')}</>;
}
