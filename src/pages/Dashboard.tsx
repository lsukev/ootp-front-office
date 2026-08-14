import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { useJob, type JobStatus } from '../useJob';
import { FallbackNotice, type FallbackNoticeData } from '../FallbackNotice';
import { PlayerLink } from '../playerModal';
import { TeamLogo } from '../TeamLogo';
import { Th } from '../Th';
import { PlayerNames } from '../PlayerNames';

/** Where the club stands for a place, which the division table does not say. */
interface Playoffs {
  spots: number;
  route: 'division' | 'wildcard' | 'out';
  divisionGb: number;
  wildcardGb: number | null;
  wildcardRank: number | null;
  magicNumber: number | null;
  summary: string;
}

/** Buy, hold or sell — see server/posture.ts for how it is worked out. */
interface DeadlineRead {
  posture: 'buy' | 'lean-buy' | 'hold' | 'lean-sell' | 'sell';
  odds: number;
  headline: string;
  reasons: string[];
  gamesLeft: number;
  runDiff: number;
  daysToDeadline: number | null;
  deadlinePassed: boolean;
}

interface DashboardData {
  streaks?: Array<{
    player_id: number; name: string; positionName: string; games: number; kind: string;
    since: string;
    /** His other live streak, when he has one — "6-game hitting streak". */
    also?: string | null;
  }>;
  standings: Array<{ team_id: number; team: string; w: number; l: number; gb: number; streak: number }>;
  /** Absent on a save imported before this existed. */
  playoffs?: Playoffs | null;
  deadline?: DeadlineRead | null;
  recent: Array<{ date: string; opponent: string; isHome: boolean; score: string; won: boolean; innings: number }>;
  upcoming: Array<{
    date: string; isHome: boolean; opponent: string;
    ourStarter: { player_id: number; name: string; throws: string } | null;
    theirStarter: { player_id: number; name: string; throws: string } | null;
  }>;
  hot: Array<{ player_id: number; name: string; positionName: string; pa: number; avg: number; ops: number; hr: number }>;
  cold: Array<{ player_id: number; name: string; positionName: string; pa: number; avg: number; ops: number }>;
  injuries: Array<{ player_id: number; name: string; positionName: string; levelName: string; status: string; daysLeft: number | null }>;
  pending: {
    expiring: number; extensionCandidates: number; promoteSignals: number;
    injuredCount: number; crunchIssues: number;
    /** Optional: a save imported before this existed has no count to show. */
    tradeTalk?: number;
  };
}

interface Briefing {
  generatedAt?: string;
  gameDate?: string | null;
  markdown: string | null;
  /** Set when the chosen model could not be used and another answered. */
  notice?: FallbackNoticeData | null;
  job?: JobStatus;
}

export function Dashboard({ orgId, onNavigate }: { orgId: number; onNavigate: (page: string) => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The briefing runs on the server, so this watches it rather than waits for
  // it — start one and go somewhere else
  const {
    data: briefing, error: briefingError, running: briefingBusy, start: generateBriefing,
  } = useJob<Briefing>(`/api/briefing/${orgId}`);

  useEffect(() => {
    setData(null);
    apiGet<DashboardData>(`/api/dashboard/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading the morning report…</p>;

  const fmt3 = (n: number) => n.toFixed(3).replace(/^0\./, '.');

  return (
    <div className="dash">
      {/* What the season says to do about it, above the things to do */}
      {data.deadline && (
        <section className={`posture posture-${data.deadline.posture}`}>
          <div className="posture-head">
            <span className="posture-verdict">{data.deadline.posture.replace('-', ' ')}</span>
            <span className="posture-odds">{Math.round(data.deadline.odds * 100)}%</span>
            <span className="muted">to reach the postseason</span>
          </div>
          <ul className="posture-why">
            {data.deadline.reasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </section>
      )}
      <div className="dash-decisions">
        <DecisionChip label="Expiring contracts" count={data.pending.expiring} onClick={() => onNavigate('contracts')} />
        <DecisionChip label="Extension candidates" count={data.pending.extensionCandidates} onClick={() => onNavigate('contracts')} />
        <DecisionChip label="Promotion signals" count={data.pending.promoteSignals} onClick={() => onNavigate('prospects')} />
        <DecisionChip label="Trade talk" count={data.pending.tradeTalk ?? 0} onClick={() => onNavigate('trades')} />
        <DecisionChip label="Roster issues" count={data.pending.crunchIssues} onClick={() => onNavigate('crunch')} />
        <DecisionChip label="Injured org-wide" count={data.pending.injuredCount} onClick={() => onNavigate('injuries')} />
      </div>

      <div className="dash-grid">
        <section className="dash-panel">
          <h3>Division</h3>
          <table className="mini">
            <thead>
              <tr><th></th><Th>W</Th><Th>L</Th><Th>GB</Th></tr>
            </thead>
            <tbody>
              {data.standings.map((s) => (
                <tr key={s.team_id} className={s.team_id === orgId ? 'row-us' : ''}>
                  <td className="standings-team">
                    <TeamLogo teamId={s.team_id} size={40} className="logo-sm" />
                    {s.team}
                  </td>
                  <td className="num">{s.w}</td>
                  <td className="num">{s.l}</td>
                  <td className="num">{s.gb > 0 ? s.gb : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {/* Eleven of fifteen clubs in a division are not going to win it,
              and the race they are in is the one this line describes */}
          {data.playoffs && (
            <p className={`playoff-line ${data.playoffs.route}`}>
              {data.playoffs.route === 'division' && '◆ '}
              {data.playoffs.route === 'wildcard' && '● '}
              {data.playoffs.summary}
            </p>
          )}
        </section>

        <section className="dash-panel">
          <h3>Last 5</h3>
          <table className="mini">
            <tbody>
              {data.recent.map((g, i) => (
                <tr key={i}>
                  <td>{g.date.slice(5)}</td>
                  <td>{g.isHome ? 'vs' : '@'} {g.opponent}</td>
                  <td className={`num ${g.won ? 'good-text' : 'bad-text'}`}>
                    {g.won ? 'W' : 'L'} {g.score}
                    {g.innings > 9 ? ` (${g.innings})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="dash-panel">
          <h3>Up Next</h3>
          <table className="mini">
            <tbody>
              {data.upcoming.map((g, i) => (
                <tr key={i}>
                  <td>{g.date.slice(5)}</td>
                  <td>{g.isHome ? 'vs' : '@'} {g.opponent}</td>
                  <td className="muted">
                    {g.ourStarter && <PlayerLink id={g.ourStarter.player_id}>{g.ourStarter.name}</PlayerLink>}
                    {g.theirStarter && (
                      <>
                        {' '}v <PlayerLink id={g.theirStarter.player_id}>{g.theirStarter.name}</PlayerLink> ({g.theirStarter.throws}HP)
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="dash-panel">
          <h3>🔥 Hot / 🧊 Cold (last 7 games)</h3>
          <table className="mini">
            <tbody>
              {data.hot.map((p) => (
                <tr key={p.player_id}>
                  <td>🔥 <PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td className="muted">{p.positionName}</td>
                  <td className="num">{fmt3(p.avg)} avg · {fmt3(p.ops)} OPS{p.hr > 0 ? ` · ${p.hr} HR` : ''}</td>
                </tr>
              ))}
              {data.cold.map((p) => (
                <tr key={p.player_id}>
                  <td>🧊 <PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td className="muted">{p.positionName}</td>
                  <td className="num">{fmt3(p.avg)} avg · {fmt3(p.ops)} OPS</td>
                </tr>
              ))}
              {data.hot.length + data.cold.length === 0 && (
                <tr><td className="muted">Not enough recent games yet.</td></tr>
              )}
            </tbody>
          </table>
          {/* OOTP's own tracked streaks, which run longer than a 7-game window */}
          {(data.streaks?.length ?? 0) > 0 && (
            <div className="streak-strip">
              {(data.streaks ?? []).map((s) => (
                <span key={s.player_id} className="streak-chip">
                  <PlayerLink id={s.player_id}>{s.name}</PlayerLink>
                  <strong>{s.games}</strong>
                  <span className="muted">
                    game {s.kind}
                    {/* A man on a run is usually on both at once; saying so
                        beats giving him two of the six places */}
                    {s.also && <> · {s.also}</>}
                  </span>
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="dash-panel">
          <h3>Injuries</h3>
          <table className="mini">
            <tbody>
              {data.injuries.map((p) => (
                <tr key={p.player_id}>
                  <td><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td><span className="level-tag">{p.levelName}</span> {p.positionName}</td>
                  <td className="num">{p.status}{p.daysLeft ? ` · ~${p.daysLeft}d` : ''}</td>
                </tr>
              ))}
              {data.injuries.length === 0 && <tr><td className="muted">Fully healthy. Knock on wood.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="dash-panel dash-briefing">
          <div className="briefing-head">
            <h3>GM Briefing</h3>
            <button onClick={() => void generateBriefing()} disabled={briefingBusy}>
              {briefingBusy ? 'Writing…' : briefing?.markdown ? '↻ New briefing' : '✍ Generate'}
            </button>
          </div>
          {briefingError && <div className="banner error">{briefingError}</div>}
          {briefing?.notice && <FallbackNotice notice={briefing.notice} />}
          {/* It keeps writing whether or not you stay on this page, so the
              previous briefing stays readable while the new one is made */}
          {briefingBusy && (
            <p className="muted">
              Writing in the background — leave this page if you like, it will be here when you
              come back.
            </p>
          )}
          {briefing?.markdown ? (
            <>
              <div className="briefing-body">
                <PlayerNames orgId={orgId}>{renderMarkdown(briefing.markdown)}</PlayerNames>
              </div>
              <span className="muted">
                As of {briefing.gameDate}
                {briefing.generatedAt && ` · ${new Date(briefing.generatedAt).toLocaleString()}`}
              </span>
            </>
          ) : (
            !briefingBusy && (
              <p className="muted">
                An AI assistant-GM digest of standings, injuries, prospects, and looming decisions. Regenerate after
                each sim session.
              </p>
            )
          )}
        </section>
      </div>
    </div>
  );
}

function DecisionChip({ label, count, onClick }: { label: string; count: number; onClick: () => void }) {
  return (
    <button className={`decision-chip ${count > 0 ? 'has-items' : ''}`} onClick={onClick}>
      <span className="decision-count">{count}</span>
      <span>{label}</span>
    </button>
  );
}

/** Tiny renderer for the briefing's simple markdown (## headers, **bold**, lists). */
function renderMarkdown(md: string) {
  return md.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <h4 key={i}>{line.slice(3)}</h4>;
    if (line.startsWith('# ')) return <h4 key={i}>{line.slice(2)}</h4>;
    if (line.trim() === '') return null;
    const parts = line.split(/\*\*(.+?)\*\*/g).map((seg, j) => (j % 2 === 1 ? <strong key={j}>{seg}</strong> : seg));
    if (line.startsWith('- ') || line.startsWith('* ')) {
      return <li key={i}>{line.slice(2).split(/\*\*(.+?)\*\*/g).map((seg, j) => (j % 2 === 1 ? <strong key={j}>{seg}</strong> : seg))}</li>;
    }
    return <p key={i}>{parts}</p>;
  });
}
