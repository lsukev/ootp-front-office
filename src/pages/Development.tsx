import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { Th, SortableTh } from '../Th';

interface DevChange {
  player_id: number; name: string; age: number; position: number; positionName: string; level: number;
  cur: number | null; pot: number | null; curDelta: number; potDelta: number;
  details: Array<{ rating: string; from: number; to: number }>;
}
interface DevData { snapshots: number; dates: string[]; from?: string; to?: string; changes: DevChange[] | null }

/**
 * Zero is a man on no club at all — an international signing nobody has
 * assigned yet, who sits on the parent club's team_id in the export and was
 * therefore being called a major leaguer at sixteen.
 */
const LEVEL_NAMES: Record<number, string> = {
  0: 'ORG', 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R',
};

/*
 * An unknown level says so rather than quietly becoming Rookie ball. The old
 * fallback did exactly that, which would have hidden this very fault behind a
 * plausible-looking answer if the level had come through as anything but one.
 */
const levelName = (level: number): string => LEVEL_NAMES[level] ?? `L${level}`;

/**
 * A snapshot date, padded for reading.
 *
 * OOTP writes them unpadded, so a menu of them reads as a jumble even in the
 * right order — "2006-6-2" above "2006-6-16" looks like a mistake until the
 * eye works out why it is not. The stored string is untouched; this is only
 * what the reader sees.
 */
const readable = (raw: string): string => {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : raw;
};

export function Development({ orgId }: { orgId: number }) {
  const [data, setData] = useState<DevData | null>(null);
  const [from, setFrom] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    const q = from ? `?from=${encodeURIComponent(from)}` : '';
    apiGet<DevData>(`/api/development/${orgId}${q}`).then(setData).catch((e) => setError(e.message));
  }, [orgId, from]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading development report…</p>;

  if (data.changes === null) {
    return (
      <div className="hint">
        <h3>Development tracking is armed</h3>
        <p>
          A ratings snapshot of every player was captured as of your current export
          ({data.dates[0] ? readable(data.dates[0]) : 'no date'}). After your next sim + CSV export, this page will show every scout-rating
          change in your organization — who's developing, who's declining, whose ceiling moved.
        </p>
      </div>
    );
  }

  const risers = data.changes.filter((c) => c.curDelta + c.potDelta > 0);
  const fallers = data.changes.filter((c) => c.curDelta + c.potDelta < 0);

  return (
    <div>
      <div className="toolbar">
        <span className="muted">
          Rating changes since
        </span>
        {/*
          Newest first, because the snapshot before this one is the comparison
          almost everybody wants and it should not be at the bottom of a list.
          The last entry is left out: it is the export you are looking at, and
          comparing it with itself would show nothing.
        */}
        <select value={from ?? data.from} onChange={(e) => setFrom(e.target.value)}>
          {data.dates.slice(0, -1).reverse().map((d) => (
            <option key={d} value={d}>{readable(d)}</option>
          ))}
        </select>
        <span className="muted">
          — measured against your current export of {readable(data.to ?? '')} ({data.snapshots} snapshots kept)
        </span>
      </div>

      {data.changes.length === 0 && (
        <p className="muted">No scout-rating changes between these snapshots.</p>
      )}

      {risers.length > 0 && (
        <>
          <h2>📈 Stock Up</h2>
          <DevTable changes={risers} />
        </>
      )}
      {fallers.length > 0 && (
        <>
          <h2>📉 Stock Down</h2>
          <DevTable changes={fallers} />
        </>
      )}
    </div>
  );
}

/**
 * The columns worth ordering by. "What changed" is prose and sorts to nothing
 * useful, so it is left out rather than offered and disappointing.
 */
const SORTS: Array<{ key: string; label: string; of: (c: DevChange) => number | string }> = [
  { key: 'name', label: 'Player', of: (c) => c.name },
  { key: 'age', label: 'Age', of: (c) => c.age },
  { key: 'pos', label: 'Pos', of: (c) => c.positionName },
  { key: 'level', label: 'Level', of: (c) => c.level },
  { key: 'cur', label: 'Cur Δ', of: (c) => c.curDelta },
  { key: 'pot', label: 'Pot Δ', of: (c) => c.potDelta },
];

function DevTable({ changes }: { changes: DevChange[] }) {
  /*
   * Each table sorts on its own. Stock Up and Stock Down are two questions, and
   * ordering one by potential should not reorder the other under the reader.
   */
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [dir, setDir] = useState<1 | -1>(-1);

  const sortBy = (key: string) => {
    if (key === sortKey) setDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      // A name or a position reads best alphabetically; a number reads best
      // biggest-first, which is what somebody sorting by it came for
      setDir(key === 'name' || key === 'pos' ? 1 : -1);
    }
  };

  const rows = useMemo(() => {
    if (!sortKey) return changes;
    const of = SORTS.find((s) => s.key === sortKey)!.of;
    return [...changes].sort((a, b) => {
      const x = of(a);
      const y = of(b);
      return typeof x === 'string' || typeof y === 'string'
        ? dir * String(x).localeCompare(String(y))
        : dir * (x - y);
    });
  }, [changes, sortKey, dir]);

  return (
    <table>
      <thead>
        <tr>
          {SORTS.map((s) => (
            <SortableTh
              key={s.key}
              active={sortKey === s.key}
              dir={dir}
              onSort={() => sortBy(s.key)}
            >
              {s.label}
            </SortableTh>
          ))}
          <Th>What changed</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((c) => (
          <tr key={c.player_id}>
            <td className="name"><PlayerLink id={c.player_id}>{c.name}</PlayerLink></td>
            <td>{c.age}</td>
            <td>{c.positionName}</td>
            <td><span className="level-tag">{levelName(c.level)}</span></td>
            <td className={`num ${c.curDelta > 0 ? 'good-text' : c.curDelta < 0 ? 'bad-text' : ''}`}>
              {c.curDelta > 0 ? '+' : ''}{c.curDelta || '—'}
            </td>
            <td className={`num ${c.potDelta > 0 ? 'good-text' : c.potDelta < 0 ? 'bad-text' : ''}`}>
              {c.potDelta > 0 ? '+' : ''}{c.potDelta || '—'}
            </td>
            <td className="reasons">
              {c.details.map((d) => `${d.rating} ${d.from}→${d.to}`).join('; ')}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
