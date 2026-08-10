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

/**
 * What happens to this man at the end of the season, in the order a GM worries
 * about it. The flags already say this per player, but a page of thirty rows
 * does not answer "who am I about to lose" at a glance — which is the question
 * the offseason is actually about.
 */
type Status = 'freeAgency' | 'arbitration' | 'preArb' | 'reserve' | 'signed';

const STATUS_LABEL: Record<Status, string> = {
  freeAgency: 'Hitting free agency',
  arbitration: 'Arbitration',
  preArb: 'Pre-arbitration',
  reserve: 'Reserve clause',
  signed: 'Under contract',
};

/** Same precedence the flags use, so the two can never disagree. */
function statusOf(p: ContractsResponse['players'][number]): Status {
  if (p.flags.some((f: string) => f.startsWith('extended thru'))) return 'signed';
  if (p.flags.includes('reserve clause')) return 'reserve';
  if (p.flags.includes('expiring')) return 'freeAgency';
  if (p.flags.some((f: string) => f.startsWith('arbitration'))) return 'arbitration';
  if (p.flags.includes('pre-arbitration')) return 'preArb';
  return 'signed';
}

export function Contracts({ orgId }: { orgId: number }) {
  const [data, setData] = useState<ContractsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [only, setOnly] = useState<Status | null>(null);

  useEffect(() => {
    setData(null);
    setOnly(null);
    getContracts(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading contracts…</p>;

  // Groups in the order they matter, skipping any the club does not have
  const groups = (['freeAgency', 'arbitration', 'preArb', 'reserve', 'signed'] as Status[])
    .map((key) => {
      const players = data.players.filter((p) => statusOf(p) === key);
      return { key, players, money: players.reduce((sum, p) => sum + (p.salaryNow ?? 0), 0) };
    })
    .filter((g) => g.players.length > 0);

  const shown = only ? data.players.filter((p) => statusOf(p) === only) : data.players;

  return (
    <div>
      <FinanceCards finances={data.finances} />

      <section>
        <h2>After {data.seasonYear}</h2>
        <div className="status-chips">
          {groups.map((g) => (
            <button
              key={g.key}
              className={`status-chip ${only === g.key ? 'active' : ''}`}
              onClick={() => setOnly(only === g.key ? null : g.key)}
            >
              <strong>{g.players.length}</strong>
              <span>{STATUS_LABEL[g.key]}</span>
              <span className="muted">{money(g.money)}</span>
            </button>
          ))}
          {only && (
            <button className="link-button" onClick={() => setOnly(null)}>
              Show everyone
            </button>
          )}
        </div>
        <p className="muted hint-line">
          Free agency means he can leave; arbitration and pre-arbitration mean the club keeps him
          whether he likes it or not, at a price the process sets. Money shown is this season&rsquo;s
          salary, not what re-signing him would cost.
        </p>
      </section>

      <p className="muted hint-line">
        Sorted by urgency: expiring deals first, largest salary first. Value/Talent are percentiles against
        MLB-rostered players in the same role — position players, starters and relievers ranked separately —
        where value is current worth and talent is scouted ceiling.
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
          {shown.map((p) => (
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
                  <span
                    key={f}
                    className={`flag ${f === 'expiring' ? 'flag-hot' : ''}${
                      f.startsWith('extended thru') ? 'flag-locked' : ''
                    }`}
                  >
                    {f}
                  </span>
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
