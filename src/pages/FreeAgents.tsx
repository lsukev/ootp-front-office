import { useEffect, useState } from 'react';
import { getFreeAgents, type FreeAgentRow, type FreeAgentsResponse } from '../api';
import { FinanceCards, money, Pct } from './Contracts';
import { PlayerLink, Tip, TIP_TALENT, TIP_VALUE } from '../playerModal';
import { Th } from '../Th';

export function FreeAgents({ orgId }: { orgId: number }) {
  const [data, setData] = useState<FreeAgentsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [posFilter, setPosFilter] = useState<string>('');

  useEffect(() => {
    setData(null);
    getFreeAgents(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading free agents…</p>;

  const positions = [...new Set(data.upcomingFAs.concat(data.currentFAs).map((p) => p.positionName))].sort();
  const filter = (rows: FreeAgentRow[]) => (posFilter ? rows.filter((p) => p.positionName === posFilter) : rows);

  return (
    <div>
      <FinanceCards finances={data.finances} />
      <div className="toolbar">
        <span className="muted">
          Weakest positions by best available player:{' '}
          {data.holes.slice(0, 3).map((h) => h.positionName).join(', ')}
        </span>
        <select value={posFilter} onChange={(e) => setPosFilter(e.target.value)}>
          <option value="">All positions</option>
          {positions.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
      </div>

      <h2>Available now</h2>
      {filter(data.currentFAs).length === 0 ? (
        <p className="muted">Nobody worth a look on the open market right now.</p>
      ) : (
        <FATable rows={filter(data.currentFAs)} holes={data.holes} />
      )}

      <h2>Hitting the market after this season</h2>
      <p className="muted hint-line">
        Players around the league on expiring deals with enough service time to reach free agency — your
        offseason shopping list. Team-controlled players (pre-arb/arb) are excluded.
      </p>
      <FATable rows={filter(data.upcomingFAs)} holes={data.holes} />
    </div>
  );
}

function FATable({
  rows, holes,
}: { rows: FreeAgentRow[]; holes: FreeAgentsResponse['holes'] }) {
  const holeSet = new Set(holes.slice(0, 3).map((h) => h.positionName));
  return (
    <table>
      <thead>
        <tr>
          <Th>Pos</Th>
          <Th>Player</Th>
          <Th>Age</Th>
          <th><Tip label="Value" tip={TIP_VALUE} /></th>
          <th><Tip label="Talent" tip={TIP_TALENT} /></th>
          <Th>Current salary</Th>
          <Th>Team</Th>
          <Th>Fit</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((p) => (
          <tr key={p.player_id}>
            <td>{p.positionName}</td>
            <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
            <td>{p.age}</td>
            <td className="num"><Pct value={p.overallPct} /></td>
            <td className="num"><Pct value={p.talentPct} /></td>
            <td className="num">{money(p.lastSalary)}</td>
            <td>{p.team ?? '—'}</td>
            <td>{holeSet.has(p.positionName) && <span className="badge promote">fills hole</span>}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
