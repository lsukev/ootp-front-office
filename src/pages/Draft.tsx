import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';

interface DraftProspect {
  player_id: number; name: string; age: number; positionName: string; bats: string; throws: string;
  school: string; isPitcher: boolean; cur: number | null; pot: number | null; speed: number | null;
}
interface DraftData { total: number; batters: DraftProspect[]; pitchers: DraftProspect[] }

export function Draft() {
  const [data, setData] = useState<DraftData | null>(null);
  const [tab, setTab] = useState<'batters' | 'pitchers'>('batters');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<DraftData>('/api/draft').then(setData).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the scouting reports…</p>;
  if (data.total === 0) {
    return (
      <div className="hint">
        <h3>No draft class yet</h3>
        <p>OOTP hasn't generated (or your scouts haven't seen) the incoming draft class. Check back later in the season.</p>
      </div>
    );
  }

  const rows = tab === 'batters' ? data.batters : data.pitchers;

  return (
    <div>
      <div className="toolbar">
        <span className="muted">{data.total} scouted draft-eligible players, ranked by scouted ceiling.</span>
        <div className="tabs">
          <button className={tab === 'batters' ? 'active' : ''} onClick={() => setTab('batters')}>Batters</button>
          <button className={tab === 'pitchers' ? 'active' : ''} onClick={() => setTab('pitchers')}>Pitchers</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Rk</th><th>Player</th><th>Age</th><th>Pos</th><th>B/T</th>
            <th><Tip label="Cur→Pot" tip={TIP_CURPOT} /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.player_id}>
              <td className="num muted">{i + 1}</td>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.age}</td>
              <td>{p.positionName}</td>
              <td>{p.bats}/{p.throws}</td>
              <td className="num">{p.cur ?? '?'}{p.pot !== null && p.pot !== p.cur ? `→${p.pot}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
