import { useEffect, useState } from 'react';
import { getContracts, type ContractsResponse, type TeamFinances } from '../api';
import { PlayerLink, Tip, TIP_TALENT, TIP_VALUE } from '../playerModal';
import { Th } from '../Th';

export const money = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
};

export function FinanceCards({ finances }: { finances: TeamFinances | null }) {
  if (!finances) return null;
  const room = finances.budget - finances.payroll;
  const roomNext = finances.budget - finances.payrollNextSeason;
  const cards: Array<[string, string, string?]> = [
    ['Budget', money(finances.budget)],
    ['Payroll', money(finances.payroll)],
    ['Room now', money(room), room < 0 ? 'bad' : 'good'],
    ['Committed next yr', money(finances.payrollNextSeason)],
    ['Room next yr', money(roomNext), roomNext < 0 ? 'bad' : 'good'],
    ['Cash', money(finances.cash)],
  ];
  return (
    <div className="cards">
      {cards.map(([label, value, tone]) => (
        <div key={label} className="card">
          <span className="card-label">{label}</span>
          <span className={`card-value ${tone ?? ''}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

export function Pct({ value }: { value: number | null }) {
  if (value === null) return <span className="muted">—</span>;
  const hue = (value / 100) * 120;
  return <span style={{ color: `hsl(${hue}, 65%, 55%)` }}>{value}</span>;
}

export function Contracts({ orgId }: { orgId: number }) {
  const [data, setData] = useState<ContractsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    getContracts(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading contracts…</p>;

  return (
    <div>
      <FinanceCards finances={data.finances} />
      <p className="muted hint-line">
        Sorted by urgency: expiring deals first, largest salary first. Value/Talent are percentiles among all
        players on MLB rosters — value is current production, talent is scouted ceiling.
      </p>
      <table>
        <thead>
          <tr>
            <Th>Player</Th>
            <Th>Pos</Th>
            <Th>Age</Th>
            <Th>Salary</Th>
            <Th>Thru</Th>
            <Th>Yrs left</Th>
            <Th>Svc</Th>
            <th><Tip label="Value" tip={TIP_VALUE} /></th>
            <th><Tip label="Talent" tip={TIP_TALENT} /></th>
            <Th>Flags</Th>
            <Th>Recommendation</Th>
          </tr>
        </thead>
        <tbody>
          {data.players.map((p) => (
            <tr key={p.player_id}>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.positionName}</td>
              <td>{p.age}</td>
              <td className="num">{money(p.salaryNow)}</td>
              <td className="num">{p.endYear}</td>
              <td className="num">{p.yearsAfterThis}</td>
              <td className="num">{p.serviceYears ?? '—'}</td>
              <td className="num"><Pct value={p.overallPct} /></td>
              <td className="num"><Pct value={p.talentPct} /></td>
              <td>
                {p.flags.map((f) => (
                  <span key={f} className={`flag ${f === 'expiring' ? 'flag-hot' : ''}`}>{f}</span>
                ))}
              </td>
              <td className="reasons">
                {p.recommendation && (
                  <>
                    <strong className="rec-action">{p.recommendation.action}</strong>
                    {p.recommendation.reasons.length > 0 && <> — {p.recommendation.reasons.join('; ')}</>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
