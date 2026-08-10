import { useEffect, useState } from 'react';
import { apiGet, getLineup, type LineupResponse } from './api';
import { PlayerLink, Tip } from './playerModal';

/**
 * Preparation for one game, opened from the schedule.
 *
 * The card the manager would want the night before: who is starting against
 * us, the order to send up against that hand, how our hitters have actually
 * fared against that man and that club, and which of their bats to be careful
 * with. Every history line carries its sample size, because a .667 average in
 * three at-bats is noise wearing a suit and should be read as one.
 */

interface MatchupLine {
  player_id: number;
  name: string;
  positionName: string;
  bats: string;
  ab: number;
  h: number;
  hr: number;
  avg: number | null;
}

interface Dangerous {
  player_id: number;
  name: string;
  positionName: string;
  bats: string;
  barrelPct?: number | null;
  hardHitPct?: number | null;
  avgExitVelo?: number | null;
}

interface Plan {
  game: { game_id: number; date: string | null; isHome: boolean; played: boolean; opponent: { team_id: number; label: string } };
  starter: { player_id: number; name: string; throws: string; age: number; confirmed: boolean } | null;
  lineupVs: 'r' | 'l';
  matchups: { vsPitcher: MatchupLine[]; vsTeam: MatchupLine[] };
  opponent: { dangerous: Dangerous[] };
}

const avg3 = (v: number | null): string => (v === null ? '—' : v.toFixed(3).replace(/^0\./, '.'));

export function GamePlan({ teamId, gameId, onClose }: { teamId: number; gameId: number; onClose: () => void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [lineup, setLineup] = useState<LineupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPlan(null);
    setLineup(null);
    setError(null);
    let cancelled = false;
    apiGet<Plan>(`/api/game-plan/${teamId}/${gameId}`)
      .then((p) => {
        if (cancelled) return;
        setPlan(p);
        // The lineup builder already ranks hitters by platoon split, so the
        // card for this game is just its answer for the starter's hand
        return getLineup(teamId, p.lineupVs, 'saber', 'auto').then((l) => {
          if (!cancelled) setLineup(l);
        });
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => { cancelled = true; };
  }, [teamId, gameId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!plan) return <p className="muted game-plan-loading">Working up a plan…</p>;

  return (
    <div className="game-plan">
      <div className="game-plan-head">
        <strong>
          {plan.game.date} · {plan.game.isHome ? 'vs' : 'at'} {plan.game.opponent.label}
        </strong>
        <button className="link-button" onClick={onClose}>Close</button>
      </div>

      <p className="game-plan-starter">
        {plan.starter ? (
          <>
            Their starter: <PlayerLink id={plan.starter.player_id}>{plan.starter.name}</PlayerLink>{' '}
            <span className="muted">
              ({plan.starter.throws}HP, {plan.starter.age})
              {plan.starter.confirmed ? '' : ' — projected, and liable to change'}
            </span>
          </>
        ) : (
          <span className="muted">No starter named or projected for this game yet.</span>
        )}
      </p>

      <div className="game-plan-cols">
        <section>
          <h4>
            <Tip
              label={`Our card vs ${plan.lineupVs === 'l' ? 'LHP' : 'RHP'}`}
              tip="The lineup builder's order for this starter's hand, with injured players already excluded. It is the same card the Lineup page would give you for this matchup."
            />
          </h4>
          {!lineup ? (
            <p className="muted">Building…</p>
          ) : (
            <ol className="game-plan-lineup">
              {lineup.lineup.map((l) => (
                <li key={l.slot}>
                  <PlayerLink id={l.player_id}>{l.name}</PlayerLink>
                  <span className="muted"> {l.positionName}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section>
          <h4>Our hitters against him</h4>
          {plan.matchups.vsPitcher.length === 0 ? (
            <p className="muted">Nobody on this roster has faced him.</p>
          ) : (
            <table className="mini">
              <tbody>
                {plan.matchups.vsPitcher.slice(0, 8).map((m) => (
                  <tr key={m.player_id}>
                    <td><PlayerLink id={m.player_id}>{m.name}</PlayerLink></td>
                    <td className="num muted">{m.h}-for-{m.ab}</td>
                    <td className="num">{avg3(m.avg)}</td>
                    <td className="num muted">{m.hr ? `${m.hr} HR` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h4>Our hitters against {plan.game.opponent.label}</h4>
          {plan.matchups.vsTeam.length === 0 ? (
            <p className="muted">No history against this club yet.</p>
          ) : (
            <table className="mini">
              <tbody>
                {plan.matchups.vsTeam.slice(0, 8).map((m) => (
                  <tr key={m.player_id}>
                    <td><PlayerLink id={m.player_id}>{m.name}</PlayerLink></td>
                    <td className="num muted">{m.h}-for-{m.ab}</td>
                    <td className="num">{avg3(m.avg)}</td>
                    <td className="num muted">{m.hr ? `${m.hr} HR` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section>
          <h4>
            <Tip
              label="Be careful with"
              tip="Their hitters ranked by barrel rate — how often they hit a ball hard enough, at a good enough angle, to do damage. Measured from every batted ball rather than taken from their stat line, so it reflects how well they are actually striking the ball."
            />
          </h4>
          {plan.opponent.dangerous.length === 0 ? (
            <p className="muted">Not enough batted-ball data on this club yet.</p>
          ) : (
            <table className="mini">
              <tbody>
                {plan.opponent.dangerous.map((h) => (
                  <tr key={h.player_id}>
                    <td><PlayerLink id={h.player_id}>{h.name}</PlayerLink></td>
                    <td className="muted">{h.positionName}</td>
                    <td className="num">{h.barrelPct ?? '—'}%</td>
                    <td className="num muted">{h.avgExitVelo ?? '—'} mph</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </div>
  );
}
