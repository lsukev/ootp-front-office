import { useEffect, useState } from 'react';
import { getProspects, type Prospect, type ProspectsResponse } from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';
import { Th } from '../Th';
import { formatRatingPair } from '../ratingScale';

export function Prospects({ orgId }: { orgId: number }) {
  const [data, setData] = useState<ProspectsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    getProspects(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading prospects…</p>;

  return (
    <div>
      <p className="muted hint-line">
        Minor leaguers ranked by promotion signal: production vs level average, age vs level average, and
        current-vs-potential ratings. Sample minimums: 60 PA / 15 IP this season.
      </p>
      <h2>Batters</h2>
      <ProspectTable prospects={data.batters} kind="batter" />
      <h2>Pitchers</h2>
      <ProspectTable prospects={data.pitchers} kind="pitcher" />
    </div>
  );
}

function ProspectTable({ prospects, kind }: { prospects: Prospect[]; kind: 'batter' | 'pitcher' }) {
  if (prospects.length === 0) {
    return <p className="muted">No qualified {kind}s yet — small samples this early in the season.</p>;
  }
  return (
    <table>
      <thead>
        <tr>
          <Th>Signal</Th>
          <Th>Player</Th>
          <Th>Age</Th>
          <Th>Team</Th>
          {kind === 'batter' ? (
            <>
              <Th>PA</Th>
              <Th>OPS</Th>
              <Th>HR</Th>
              <Th>SB</Th>
            </>
          ) : (
            <>
              <Th>IP</Th>
              <Th>ERA</Th>
              <Th>K%</Th>
            </>
          )}
          <Th>WAR</Th>
          <th><Tip label="Cur→Pot" tip={TIP_CURPOT} /></th>
          <Th>Why</Th>
        </tr>
      </thead>
      <tbody>
        {prospects.map((p) => (
          <tr key={p.player_id}>
            <td>{p.signal && <span className={`badge ${p.signal}`}>{p.signal}</span>}</td>
            <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
            <td>{p.age}</td>
            <td>
              <span className="level-tag">{p.levelName}</span> {p.team}
            </td>
            {kind === 'batter' ? (
              <>
                <td className="num">{p.pa}</td>
                <td className="num">{p.opsVal?.toFixed(3)}</td>
                <td className="num">{p.hr}</td>
                <td className="num">{p.sb}</td>
              </>
            ) : (
              <>
                <td className="num">{p.ip}</td>
                <td className="num">{p.era?.toFixed(2)}</td>
                <td className="num">{p.kpct?.toFixed(1)}</td>
              </>
            )}
            <td className="num">{p.war?.toFixed(1)}</td>
            <td className="num">
              {formatRatingPair(p.cur, p.pot)}
            </td>
            <td className="reasons">{p.reasons.join('; ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
