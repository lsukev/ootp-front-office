import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';

interface Leader { player_id: number; name: string; team: string; value: string | number; isOrg: boolean }
interface LeaderData {
  seasonYear: number;
  minPA: number;
  minIP: number;
  batting: Record<string, Leader[]>;
  pitching: Record<string, Leader[]>;
}

export function Leaderboards({ orgId }: { orgId: number }) {
  const [data, setData] = useState<LeaderData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<LeaderData>(`/api/leaderboards/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Tallying the league leaders…</p>;

  return (
    <div>
      <p className="muted hint-line">
        {data.seasonYear} MLB leaders. Rate stats need {data.minPA}+ PA / {data.minIP}+ IP. Your players are
        highlighted gold.
      </p>
      <h2>Batting</h2>
      <div className="leader-grid">
        {Object.entries(data.batting).map(([cat, rows]) => (
          <LeaderBoard key={cat} category={cat} rows={rows} />
        ))}
      </div>
      <h2>Pitching</h2>
      <div className="leader-grid">
        {Object.entries(data.pitching).map(([cat, rows]) => (
          <LeaderBoard key={cat} category={cat} rows={rows} />
        ))}
      </div>
    </div>
  );
}

function LeaderBoard({ category, rows }: { category: string; rows: Leader[] }) {
  return (
    <div className="leader-card">
      <h3>{category}</h3>
      <table className="mini">
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.player_id} className={r.isOrg ? 'row-us' : ''}>
              <td className="num muted">{i + 1}</td>
              <td><PlayerLink id={r.player_id}>{r.name}</PlayerLink></td>
              <td className="muted">{r.team}</td>
              <td className="num">{r.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
