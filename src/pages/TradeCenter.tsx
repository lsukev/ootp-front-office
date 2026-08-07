import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost } from '../api';
import { PlayerLink } from '../playerModal';

interface FitPlayer { player_id: number; name: string; value: number }
interface Fits {
  myWeakest: Array<{ positionName: string; bestValue: number }>;
  mySurplus: Array<{ positionName: string; players: FitPlayer[] }>;
  fits: Array<{
    orgId: number; label: string; score: number;
    theyNeed: Array<{ positionName: string; myCandidates: FitPlayer[] }>;
    theyOffer: Array<{ positionName: string; players: FitPlayer[] }>;
  }>;
}
interface SearchResult { player_id: number; name: string; age: number; positionName: string; team: string; value: number }
interface SideSummary {
  players: Array<{
    player_id: number; name: string; age: number; positionName: string; team: string | null;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
  }>;
  totalValue: number; totalTalent: number; totalSalary: number;
}
interface Analysis { sideA: SideSummary; sideB: SideSummary; valueDiff: number; talentDiff: number; salaryDiff: number }

const money = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);

export function TradeCenter({ orgId, orgLabel }: { orgId: number; orgLabel: string }) {
  const [fits, setFits] = useState<Fits | null>(null);
  const [sideA, setSideA] = useState<SearchResult[]>([]);
  const [sideB, setSideB] = useState<SearchResult[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [aiVerdict, setAiVerdict] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFits(null);
    apiGet<Fits>(`/api/trade/fits/${orgId}`).then(setFits).catch((e) => setError(e.message));
  }, [orgId]);

  const analyze = async () => {
    setError(null);
    setAiVerdict(null);
    try {
      setAnalysis(
        await apiPost<Analysis>('/api/trade/analyze', {
          sideA: sideA.map((p) => p.player_id),
          sideB: sideB.map((p) => p.player_id),
        })
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const askAI = async () => {
    setAiBusy(true);
    setError(null);
    try {
      const r = await apiPost<{ verdict: string }>('/api/trade/ai-eval', {
        sideA: sideA.map((p) => p.player_id),
        sideB: sideB.map((p) => p.player_id),
        orgLabel,
      });
      setAiVerdict(r.verdict);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAiBusy(false);
    }
  };

  return (
    <div>
      {error && <div className="banner error">{error}</div>}

      <h2>Trade Analyzer</h2>
      <div className="trade-builder">
        <TradeSide title={`${orgLabel} send`} players={sideA} setPlayers={setSideA} />
        <div className="trade-middle">
          <button className="btn-feature" onClick={analyze} disabled={!sideA.length || !sideB.length}>
            ⇄ Compare
          </button>
          <button onClick={askAI} disabled={aiBusy || !sideA.length || !sideB.length}>
            {aiBusy ? 'Thinking…' : '🤖 Ask the AI'}
          </button>
        </div>
        <TradeSide title={`${orgLabel} receive`} players={sideB} setPlayers={setSideB} />
      </div>

      {analysis && (
        <div className="cards trade-verdict">
          <SummaryCard label="Value sent" value={String(Math.round(analysis.sideA.totalValue))} />
          <SummaryCard label="Value received" value={String(Math.round(analysis.sideB.totalValue))} />
          <SummaryCard
            label="Value swing"
            value={`${analysis.valueDiff > 0 ? '−' : '+'}${Math.abs(Math.round(analysis.valueDiff))}`}
            tone={analysis.valueDiff > 0 ? 'bad' : 'good'}
          />
          <SummaryCard
            label="Salary swing"
            value={`${analysis.salaryDiff > 0 ? '−' : '+'}${money(Math.abs(analysis.salaryDiff))}`}
            tone={analysis.salaryDiff > 0 ? 'good' : 'bad'}
          />
        </div>
      )}
      {aiVerdict && <div className="ai-verdict">{aiVerdict.split('\n').map((l, i) => <p key={i}>{l.replace(/\*\*/g, '')}</p>)}</div>}

      <h2>Trade Fits Around the League</h2>
      {!fits ? (
        <p className="muted">Scanning 29 front offices…</p>
      ) : (
        <>
          <p className="muted hint-line">
            Your weakest spots: {fits.myWeakest.map((w) => w.positionName).join(', ')}
            {fits.mySurplus.length > 0 &&
              ` · your tradable surplus: ${fits.mySurplus.map((s) => s.positionName).join(', ')}`}
            . Matches below need what you have, or have what you need.
          </p>
          {fits.fits.length === 0 && <p className="muted">No obvious complementary partners right now.</p>}
          <div className="fit-grid">
            {fits.fits.map((f) => (
              <div key={f.orgId} className="fit-card">
                <h3>{f.label}</h3>
                {f.theyNeed.map((n, i) => (
                  <p key={`n${i}`}>
                    They need <strong>{n.positionName}</strong> — you could offer{' '}
                    {n.myCandidates.map((c, j) => (
                      <span key={c.player_id}>
                        {j > 0 && ', '}
                        <PlayerLink id={c.player_id}>{c.name}</PlayerLink>
                      </span>
                    ))}
                  </p>
                ))}
                {f.theyOffer.map((o, i) => (
                  <p key={`o${i}`}>
                    They have spare <strong>{o.positionName}</strong>:{' '}
                    {o.players.map((c, j) => (
                      <span key={c.player_id}>
                        {j > 0 && ', '}
                        <PlayerLink id={c.player_id}>{c.name}</PlayerLink>
                      </span>
                    ))}
                  </p>
                ))}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TradeSide({
  title, players, setPlayers,
}: { title: string; players: SearchResult[]; setPlayers: (p: SearchResult[]) => void }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = (q: string) => {
    setQuery(q);
    if (timer.current) clearTimeout(timer.current);
    if (q.length < 2) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      apiGet<SearchResult[]>(`/api/search-players?q=${encodeURIComponent(q)}`).then(setResults).catch(() => {});
    }, 250);
  };

  return (
    <div className="trade-side">
      <h3>{title}</h3>
      <input
        className="trade-search"
        placeholder="Search a player…"
        value={query}
        onChange={(e) => search(e.target.value)}
      />
      {results.length > 0 && (
        <div className="trade-results">
          {results.map((r) => (
            <button
              key={r.player_id}
              onClick={() => {
                if (!players.some((p) => p.player_id === r.player_id)) setPlayers([...players, r]);
                setQuery('');
                setResults([]);
              }}
            >
              {r.name} · {r.positionName} · {r.age} · {r.team}
            </button>
          ))}
        </div>
      )}
      {players.map((p) => (
        <div key={p.player_id} className="trade-chip">
          <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
          <span className="muted"> {p.positionName} · {p.age}</span>
          <button className="chip-x" onClick={() => setPlayers(players.filter((x) => x.player_id !== p.player_id))}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="card">
      <span className="card-label">{label}</span>
      <span className={`card-value ${tone ?? ''}`}>{value}</span>
    </div>
  );
}
