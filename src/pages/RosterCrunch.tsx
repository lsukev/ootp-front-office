import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { Th } from '../Th';

interface CrunchPlayer {
  player_id: number; name: string; age: number; positionName: string; levelName: string;
  on26: boolean; on40: boolean; optionsUsed: number; rule5Protected: number; issues: string[];
}
interface CrunchData {
  counts: { active: number; fortyMan: number; issues: number };
  issues: CrunchPlayer[];
  fortyMan: CrunchPlayer[];
}

export function RosterCrunch({ orgId }: { orgId: number }) {
  const [data, setData] = useState<CrunchData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<CrunchData>(`/api/roster-crunch/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading roster status…</p>;

  return (
    <div>
      <div className="cards">
        <div className="card">
          <span className="card-label">Active roster</span>
          <span className="card-value">{data.counts.active}/26</span>
        </div>
        <div className="card">
          <span className="card-label">40-man</span>
          <span className={`card-value ${data.counts.fortyMan >= 40 ? 'bad' : ''}`}>{data.counts.fortyMan}/40</span>
        </div>
        <div className="card">
          <span className="card-label">Needs attention</span>
          <span className={`card-value ${data.counts.issues > 0 ? 'bad' : 'good'}`}>{data.counts.issues}</span>
        </div>
      </div>

      {data.issues.length > 0 && (
        <>
          <h2>⚠ Needs Attention</h2>
          <table>
            <thead>
              <tr><Th>Player</Th><Th>Pos</Th><Th>Age</Th><Th>Level</Th><Th>Issues</Th></tr>
            </thead>
            <tbody>
              {data.issues.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td>{p.positionName}</td>
                  <td>{p.age}</td>
                  <td><span className="level-tag">{p.levelName}</span></td>
                  <td>{p.issues.map((i) => <span key={i} className="flag flag-hot">{i}</span>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>40-Man Roster</h2>
      <table>
        <thead>
          <tr><Th>Player</Th><Th>Pos</Th><Th>Age</Th><Th>Level</Th><Th>Status</Th><Th>Options used</Th></tr>
        </thead>
        <tbody>
          {data.fortyMan.map((p) => (
            <tr key={p.player_id}>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.positionName}</td>
              <td>{p.age}</td>
              <td><span className="level-tag">{p.levelName}</span></td>
              <td>{p.on26 ? <span className="badge promote">Active</span> : <span className="flag">40-man</span>}</td>
              <td className="num">{p.optionsUsed}/3</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
