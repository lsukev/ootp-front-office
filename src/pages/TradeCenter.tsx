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
interface ProposalSide {
  players: Array<{ player_id: number; name: string; age: number; positionName: string; team: string | null }>;
  totalValue: number;
  totalSalary: number;
}
interface Proposal {
  message_id: number;
  trade_id: number;
  subject: string;
  date: string | null;
  from: { team_id: number; label: string };
  theySend: ProposalSide;
  weSend: ProposalSide;
  valueDiff: number;
  salaryDiff: number;
}

interface TalkItem {
  message_id: number;
  subject: string;
  date: string;
  otherTeam: { orgId: number; label: string };
  player: {
    player_id: number; name: string; age: number; positionName: string; levelName: string;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
  };
}

const money = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);

export function TradeCenter({ orgId, orgLabel }: { orgId: number; orgLabel: string }) {
  const [fits, setFits] = useState<Fits | null>(null);
  const [sideA, setSideA] = useState<SearchResult[]>([]);
  const [sideB, setSideB] = useState<SearchResult[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [aiVerdict, setAiVerdict] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [talk, setTalk] = useState<TalkItem[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const builderRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setFits(null);
    apiGet<Fits>(`/api/trade/fits/${orgId}`).then(setFits).catch((e) => setError(e.message));
  }, [orgId]);

  useEffect(() => {
    setProposals([]);
    apiGet<{ proposals: Proposal[] }>(`/api/trade-proposals/${orgId}`)
      .then((r) => setProposals(r.proposals))
      .catch(() => setProposals([]));
  }, [orgId]);

  useEffect(() => {
    setTalk([]);
    apiGet<{ items: TalkItem[] }>(`/api/trade-talk/${orgId}`)
      .then((r) => setTalk(r.items))
      // The inbox is a bonus on top of the analyser, so a save without it
      // should cost the page nothing
      .catch(() => setTalk([]));
  }, [orgId]);

  /** Loads a real offer into the builder, both sides as they were proposed. */
  const reviewProposal = (p: Proposal) => {
    setAnalysis(null);
    setAiVerdict(null);
    const toRow = (x: ProposalSide['players'][number], team: string | null) => ({
      player_id: x.player_id,
      name: x.name,
      age: x.age,
      positionName: x.positionName,
      team: x.team ?? team ?? '',
      value: 0,
    });
    setSideA(p.weSend.players.map((x) => toRow(x, orgLabel)));
    setSideB(p.theySend.players.map((x) => toRow(x, p.from.label)));
    requestAnimationFrame(() =>
      builderRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    );
  };

  /**
   * Load a suggested target into the builder and take the user to it.
   *
   * A staff note only names the man you would receive — what he costs is the
   * open question, so the other side is left empty for you to fill in. An
   * actual offer is different and goes through reviewProposal above, which
   * carries both sides.
   */
  const review = (item: TalkItem) => {
    setAnalysis(null);
    setAiVerdict(null);
    setSideB([{
      player_id: item.player.player_id,
      name: item.player.name,
      age: item.player.age,
      positionName: item.player.positionName,
      team: item.otherTeam.label,
      value: 0,
    }]);
    // After the paint, not before it: loading the player re-renders the builder,
    // and a scroll begun in the same tick is cancelled by the layout change.
    // Instant rather than smooth — smooth silently does nothing in some
    // embedded browsers, and a jump that sometimes fails to happen is worse
    // than one that always does.
    requestAnimationFrame(() =>
      builderRef.current?.scrollIntoView({ behavior: 'auto', block: 'start' })
    );
  };

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
        // The club matters now: the verdict weighs the incoming men against
        // whoever already holds their jobs here
        orgId,
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

      {proposals.length > 0 && (
        <>
          <h2>Offers on the Table</h2>
          <p className="muted hint-line">
            Proposals sitting in your OOTP inbox. Which players go which way is not stored in the
            message — it is worked out from who each man currently plays for — so check it against
            the mail before acting on anything. Value is the same figure the analyser below reports.
          </p>
          <div className="talk-grid">
            {proposals.map((p) => (
              <div key={p.message_id} className="talk-card proposal-card">
                <span className="talk-date">{p.date} · {p.from.label}</span>
                <p className="talk-subject">{p.subject}</p>
                <p className="proposal-side">
                  <span className="proposal-label">They send</span>{' '}
                  {p.theySend.players.map((x, i) => (
                    <span key={x.player_id}>
                      {i > 0 && ', '}
                      <PlayerLink id={x.player_id}>{x.name}</PlayerLink>
                      <span className="muted"> {x.positionName} {x.age}</span>
                    </span>
                  ))}
                </p>
                <p className="proposal-side">
                  <span className="proposal-label">You send</span>{' '}
                  {p.weSend.players.map((x, i) => (
                    <span key={x.player_id}>
                      {i > 0 && ', '}
                      <PlayerLink id={x.player_id}>{x.name}</PlayerLink>
                      <span className="muted"> {x.positionName} {x.age}</span>
                    </span>
                  ))}
                </p>
                <p className="muted talk-line">
                  Value {p.valueDiff > 0 ? 'against you' : 'your way'} by{' '}
                  {Math.abs(Math.round(p.valueDiff))} · salary{' '}
                  {p.salaryDiff > 0 ? 'off' : 'onto'} your books {money(Math.abs(p.salaryDiff))}
                </p>
                <button onClick={() => reviewProposal(p)}>Review this offer</button>
              </div>
            ))}
          </div>
        </>
      )}

      {talk.length > 0 && (
        <>
          <h2>Trade Talk in Your Inbox</h2>
          <p className="muted hint-line">
            Targets your staff has raised, newest first. OOTP's messages name the player and the
            club but never the price, so "Review" loads him as the man you would receive and leaves
            what you give up to you.
          </p>
          <div className="talk-grid">
            {talk.map((t) => (
              <div key={t.message_id} className="talk-card">
                <span className="talk-date">{t.date}</span>
                <p className="talk-subject">{t.subject}</p>
                <p className="talk-player">
                  <PlayerLink id={t.player.player_id}>{t.player.name}</PlayerLink>{' '}
                  <span className="muted">
                    {t.player.positionName} · {t.player.age} · {t.otherTeam.label}
                  </span>
                </p>
                <p className="muted talk-line">
                  Value {t.player.overallPct ?? '—'} · Talent {t.player.talentPct ?? '—'} ·{' '}
                  {money(t.player.salaryNow)}
                  {t.player.yearsAfterThis > 0 ? ` · ${t.player.yearsAfterThis}y after this` : ' · expiring'}
                </p>
                <button onClick={() => review(t)}>Review this target</button>
              </div>
            ))}
          </div>
        </>
      )}

      <h2>Trade Analyzer</h2>
      <div className="trade-builder" ref={builderRef}>
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
      {aiVerdict && (
        <div className="ai-verdict">
          {aiVerdict
            .split('\n')
            .filter((l) => l.trim())
            .map((line, i) => {
              // The model writes markdown. Only the bold and heading markers
              // ever show up here, and "## Verdict: Accept" was being printed
              // with its hashes on the page.
              const heading = /^#{1,6}\s+/.test(line);
              const text = line.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '');
              return heading ? <h4 key={i}>{text}</h4> : <p key={i}>{text}</p>;
            })}
        </div>
      )}

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
