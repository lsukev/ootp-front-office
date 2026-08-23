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
        current-vs-potential ratings. Sample minimums: 60 PA / 15 IP this season.{' '}
        <strong>Demote</strong> marks a man clearly below his level who is not young for it — it asks a
        bigger gap and a longer look than promote does, because sending somebody down is the easier call
        to get wrong, and it is never shown for the lowest club in the organisation.{' '}
        Those sit at the bottom of each table, since the order runs on the same signal.
      </p>
      <p className="muted hint-line">
        <strong>The move</strong> is the other half of a call-up: who comes off the big club to make
        room, and whether the swap is an improvement. It compares OOTP's Overall grade rather than the
        season lines, because a .900 OPS in Double-A and a .900 OPS in the majors are not the same
        achievement — the grade is scouted current ability and means the same thing at every level. A
        man graded below everyone at his listed position is marked <strong>blocked</strong> instead of
        promote: he has earned it where he is, but the club is better as it stands. The comparison runs
        on his listed position only, so a shortstop blocked by a shortstop may still have a home at
        second or third.
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
          <Th>The move</Th>
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
            <td className="reasons">
              {p.signal === 'promote' || p.signal === 'blocked' ? p.move?.note ?? '—' : ''}
            </td>
            <td className="reasons">{p.reasons.join('; ')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
