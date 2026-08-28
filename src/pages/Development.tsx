import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { Th } from '../Th';

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

function DevTable({ changes }: { changes: DevChange[] }) {
  return (
    <table>
      <thead>
        <tr>
          <Th>Player</Th><Th>Age</Th><Th>Pos</Th><Th>Level</Th><Th>Cur Δ</Th><Th>Pot Δ</Th><Th>What changed</Th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
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
