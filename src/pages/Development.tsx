import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { Th } from '../Th';

interface DevChange {
  player_id: number; name: string; age: number; position: number; level: number;
  cur: number | null; pot: number | null; curDelta: number; potDelta: number;
  details: Array<{ rating: string; from: number; to: number }>;
}
interface DevData { snapshots: number; dates: string[]; from?: string; to?: string; changes: DevChange[] | null }

const LEVEL_NAMES: Record<number, string> = { 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R' };

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
          ({data.dates[0] ?? 'no date'}). After your next sim + CSV export, this page will show every scout-rating
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
          Rating changes from
        </span>
        <select value={from ?? data.from} onChange={(e) => setFrom(e.target.value)}>
          {data.dates.slice(0, -1).map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <span className="muted">to {data.to} ({data.snapshots} snapshots kept)</span>
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
          <Th>Player</Th><Th>Age</Th><Th>Level</Th><Th>Cur Δ</Th><Th>Pot Δ</Th><Th>What changed</Th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => (
          <tr key={c.player_id}>
            <td className="name"><PlayerLink id={c.player_id}>{c.name}</PlayerLink></td>
            <td>{c.age}</td>
            <td><span className="level-tag">{LEVEL_NAMES[c.level] ?? 'R'}</span></td>
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
