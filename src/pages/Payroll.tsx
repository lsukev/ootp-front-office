import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { Sparkline } from '../Chart';
import { Th } from '../Th';

interface Commitment { year: number; total: number; players: number; headroom: number | null }
interface PayrollPlayer {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  salaryNow: number;
  byYear: Array<number | null>;
  yearsAfterThis: number;
  endYear: number;
  expiring: boolean;
  options: string[];
  deadMoney: boolean;
}
interface PayrollData {
  seasonYear: number;
  years: number[];
  finances: {
    budget: number; payroll: number; payrollNextSeason: number; cash: number;
    cashTradesAvailable: number; revenue: number; expenses: number;
    budgetBalance: number; market: number; ownerExpectation: number;
  } | null;
  deadMoney: { total: number; players: Array<{ player_id: number; name: string; salary: number }> };
  commitments: Commitment[];
  comingOff: {
    count: number; money: number;
    players: Array<{ player_id: number; name: string; age: number; salary: number }>;
  };
  players: PayrollPlayer[];
}

const money = (v: number | null | undefined): string => {
  if (v === null || v === undefined) return '';
  if (v === 0) return '—';
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  return `$${Math.round(v / 1000)}K`;
};

const TIP_COMMITTED =
  'Guaranteed salary already on the books for that season, summed from every contract — ' +
  'including money still owed to players who were traded or released. It is NOT a payroll ' +
  'projection: arbitration raises and yet-to-be-signed players are not in it, which is why ' +
  'future seasons look so light.';
const TIP_HEADROOM =
  'Budget minus committed salary. Future seasons assume the budget stays where it is today, ' +
  'since the save does not publish future budgets — treat the later years as a shape, not a forecast.';

export function Payroll({ orgId }: { orgId: number }) {
  const [data, setData] = useState<PayrollData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<PayrollData>(`/api/payroll/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Adding up the books…</p>;

  const f = data.finances;
  // Leave headroom past the largest value so the budget marker never lands on
  // the track's edge, where a zero-width dashed border is invisible
  const peak = Math.max(...data.commitments.map((c) => c.total), f?.budget ?? 0, 1) * 1.08;

  return (
    <div>
      {f && (
        <div className="finance-grid">
          <div className="finance-card">
            <span className="muted">Budget</span>
            <strong>{money(f.budget)}</strong>
          </div>
          <div className="finance-card">
            <span className="muted">Payroll now</span>
            <strong>{money(f.payroll)}</strong>
            <span className={f.budget - f.payroll >= 0 ? 'good-text' : 'bad-text'}>
              {f.budget - f.payroll >= 0 ? '+' : ''}{money(f.budget - f.payroll)} room
            </span>
          </div>
          <div className="finance-card">
            <span className="muted">Payroll next season</span>
            <strong>{money(f.payrollNextSeason)}</strong>
            <span className="muted">OOTP estimate</span>
          </div>
          <div className="finance-card">
            <span className="muted">Revenue / expenses</span>
            <strong>{money(f.revenue)}</strong>
            <span className="muted">less {money(f.expenses)}</span>
          </div>
          <div className="finance-card">
            <span className="muted">Cash for trades</span>
            <strong>{money(f.cashTradesAvailable)}</strong>
          </div>
        </div>
      )}

      <section>
        <h2><Tip label="Committed salary by season" tip={TIP_COMMITTED} /></h2>
        <div className="commit-chart">
          {data.commitments.map((c) => (
            <div key={c.year} className="commit-row">
              <span className="commit-year">{c.year}</span>
              <div className="commit-track">
                <div className="commit-bar" style={{ width: `${(c.total / peak) * 100}%` }} />
                {f && (
                  <div className="commit-budget" style={{ left: `${(f.budget / peak) * 100}%` }} title={`Budget ${money(f.budget)}`} />
                )}
              </div>
              <span className="commit-value">{money(c.total)}</span>
              <span className="muted commit-players">{c.players} player{c.players === 1 ? '' : 's'}</span>
              <span className={`commit-room ${(c.headroom ?? 0) >= 0 ? 'good-text' : 'bad-text'}`}>
                {c.headroom === null ? '' : `${money(c.headroom)} free`}
              </span>
            </div>
          ))}
        </div>
        <p className="muted hint-line">
          The dashed line is today&rsquo;s budget. <Tip label="Headroom" tip={TIP_HEADROOM} /> in later
          seasons is wide because only guaranteed deals are counted — arbitration and replacements
          will fill much of it.
        </p>
      </section>

      <div className="two-col">
        <section>
          <h2>
            Coming off after {data.seasonYear}{' '}
            <span className="muted subtle-count">
              — {data.comingOff.count} players, {money(data.comingOff.money)}
            </span>
          </h2>
          <table className="mini">
            <tbody>
              {data.comingOff.players.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td className="num">{p.age}</td>
                  <td className="num">{money(p.salary)}</td>
                </tr>
              ))}
              {data.comingOff.players.length === 0 && (
                <tr><td className="muted">Nothing expiring.</td></tr>
              )}
            </tbody>
          </table>
        </section>

        {data.deadMoney.players.length > 0 && (
          <section>
            <h2>
              Dead money{' '}
              <span className="muted subtle-count">— still owed to players who left</span>
            </h2>
            <table className="mini">
              <tbody>
                {data.deadMoney.players.map((p) => (
                  <tr key={p.player_id}>
                    <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                    <td className="num">{money(p.salary)}</td>
                  </tr>
                ))}
                <tr>
                  <td><strong>Total</strong></td>
                  <td className="num"><strong>{money(data.deadMoney.total)}</strong></td>
                </tr>
              </tbody>
            </table>
          </section>
        )}
      </div>

      <section>
        <h2>Every contract</h2>
        <table>
          <thead>
            <tr>
              <Th>Player</Th>
              <Th>Pos</Th>
              <Th>Age</Th>
              {data.years.map((y) => (
                <Th
                  key={y}
                  className="num"
                  tip={
                    y === data.seasonYear
                      ? `Guaranteed salary owed in ${y}, the current season.`
                      : `Guaranteed salary already committed for ${y}. Blank means the contract has ended by then — it does not mean the player is gone, only that he is no longer under contract.`
                  }
                >
                  {String(y)}
                </Th>
              ))}
              <Th>Through</Th>
              <Th>Shape</Th>
              <Th>Notes</Th>
            </tr>
          </thead>
          <tbody>
            {data.players.map((p) => (
              <tr key={p.player_id} className={p.deadMoney ? 'row-dead' : ''}>
                <td className="name">
                  <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
                  {p.deadMoney && <span className="role-tag">DEAD</span>}
                </td>
                <td>{p.positionName}</td>
                <td className="num">{p.age}</td>
                {p.byYear.map((v, i) => (
                  <td key={data.years[i]} className="num">{v ? money(v) : ''}</td>
                ))}
                <td className="num">{p.endYear}</td>
                <td>
                  {/* Backloaded vs frontloaded deals are obvious as a shape and
                      invisible as six columns of numbers */}
                  <Sparkline points={p.byYear.filter((v) => v !== null && v > 0)} />
                </td>
                <td className="reasons">{p.options.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
