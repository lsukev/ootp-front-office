import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { daysCell } from '../injury';
import { Th } from '../Th';

interface Injury {
  player_id: number; name: string; age: number; positionName: string; levelName: string;
  team: string; status: string; daysLeft: number | null; durationUnknown: boolean;
  dlDaysThisYear: number | null;
}

export function Injuries({ orgId }: { orgId: number }) {
  const [data, setData] = useState<Injury[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<Injury[]>(`/api/injuries/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading the trainer's report…</p>;
  if (data.length === 0) return <p className="muted">Everyone is healthy across the organization. Enjoy it while it lasts.</p>;

  return (
    <div>
      <p className="muted hint-line">
        Every injured player in the organization, majors to rookie ball. Click a name for their injury history.
      </p>
      <table>
        <thead>
          <tr><Th>Player</Th><Th>Age</Th><Th>Pos</Th><Th>Team</Th><Th>Status</Th><Th>Est. return</Th><Th>IL days this yr</Th></tr>
        </thead>
        <tbody>
          {data.map((p) => (
            <tr key={p.player_id}>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.age}</td>
              <td>{p.positionName}</td>
              <td><span className="level-tag">{p.levelName}</span> {p.team}</td>
              <td>
                <span className={`flag ${p.status !== 'Day-to-day' ? 'flag-hot' : ''}`}>{p.status}</span>
              </td>
              <td className="num">{daysCell(p)}</td>
              <td className="num">{p.dlDaysThisYear ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
