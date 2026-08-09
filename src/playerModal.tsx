import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiDelete, apiGet, apiPost, getPlayer, type PlayerDossier } from './api';
import { PlayerHover } from './playerHover';

// Tiny pub/sub so any table cell can open the player card without prop drilling
type Listener = (id: number | null) => void;
let listener: Listener | null = null;
export function openPlayer(id: number): void {
  listener?.(id);
}

/** Clickable player name — use anywhere a player appears. */
export function PlayerLink({ id, children }: { id: number; children: ReactNode }) {
  return (
    <PlayerHover id={id}>
      <button className="player-link" onClick={() => openPlayer(id)} title="Open player card">
        {children}
      </button>
    </PlayerHover>
  );
}

/** Hoverable explainer — dotted underline with a styled popup. */
export function Tip({ label, tip }: { label: ReactNode; tip: string }) {
  return (
    <span className="tip">
      {label}
      <span className="tip-pop">{tip}</span>
    </span>
  );
}

export const TIP_VALUE =
  "OOTP's evaluation of the player's current worth to a club, shown as a percentile against others " +
  'in his own role — position players, starters and relievers are ranked separately. 86 means better ' +
  'right now than 86% of MLB-rostered players doing his job.\n\n' +
  'The split matters because the underlying number includes playing time: a closer throws around 65 ' +
  'innings, so ranking him against starters and everyday players would bury even an excellent one.';
export const TIP_TALENT =
  'The scouted ceiling (potential), as a percentile against MLB-rostered players in the same role. ' +
  'Talent well below Value suggests decline risk; well above suggests untapped upside still to develop. ' +
  'A settled veteran often sits lower here than on Value simply because most of the league still has ' +
  'projection left and he does not.';
export const TIP_CURPOT =
  'Current → potential scout ratings (20-80 scale), averaged across the main rating categories. 45→60 means an average-ish player today with above-average upside.';

const money = (n: number) =>
  Math.abs(n) >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`;
const fmt3 = (n: number | null) => (n === null ? '' : n.toFixed(3).replace(/^0/, ''));

const RATING_LABELS: Record<string, string> = {
  contact: 'Contact', gap: 'Gap', power: 'Power', eye: 'Eye', avoidK: 'Avoid K',
  speed: 'Speed', stealing: 'Stealing', baserunning: 'Baserunning',
  stuff: 'Stuff', movement: 'Movement', control: 'Control', stamina: 'Stamina',
  infieldRange: 'IF Range', infieldArm: 'IF Arm', turnDP: 'Turn DP',
  outfieldRange: 'OF Range', outfieldArm: 'OF Arm', catcherArm: 'C Arm', catcherAbility: 'C Ability',
};
const PITCH_LABELS: Record<string, string> = {
  fastball: 'Fastball', sinker: 'Sinker', cutter: 'Cutter', slider: 'Slider', curveball: 'Curveball',
  changeup: 'Changeup', splitter: 'Splitter', forkball: 'Forkball', screwball: 'Screwball',
  circlechange: 'Circle Change', knucklecurve: 'Knuckle Curve', knuckleball: 'Knuckleball',
};

export function PlayerModal() {
  const [playerId, setPlayerId] = useState<number | null>(null);
  const [dossier, setDossier] = useState<PlayerDossier | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listener = setPlayerId;
    return () => {
      listener = null;
    };
  }, []);

  useEffect(() => {
    if (playerId === null) return;
    setDossier(null);
    setError(null);
    getPlayer(playerId).then(setDossier).catch((e) => setError(e.message));
  }, [playerId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlayerId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (playerId === null) return null;

  return (
    <div className="modal-backdrop" onClick={() => setPlayerId(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={() => setPlayerId(null)}>✕</button>
        {error && <div className="banner error">{error}</div>}
        {!dossier && !error && <p className="muted">Loading player…</p>}
        {dossier && <Dossier d={dossier} />}
      </div>
    </div>
  );
}

function WatchControls({ playerId, name }: { playerId: number; name: string }) {
  const [watched, setWatched] = useState(false);
  const [note, setNote] = useState('');
  const [loaded, setLoaded] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    apiGet<{ watched: boolean; note: string }>(`/api/watchlist/${playerId}`)
      .then((w) => {
        setWatched(w.watched);
        setNote(w.note);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [playerId]);

  const toggle = async () => {
    if (watched) {
      await apiDelete(`/api/watchlist/${playerId}`);
      setWatched(false);
    } else {
      await apiPost('/api/watchlist', { player_id: playerId, name, note });
      setWatched(true);
    }
  };

  const onNote = (value: string) => {
    setNote(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void apiPost('/api/watchlist', { player_id: playerId, name, note: value });
      setWatched(true);
    }, 600);
  };

  if (!loaded) return null;
  return (
    <div className="watch-controls">
      <button className={`watch-star ${watched ? 'on' : ''}`} onClick={toggle} title="Watchlist">
        {watched ? '★ Watching' : '☆ Watch'}
      </button>
      {watched && (
        <textarea
          className="watch-note"
          placeholder="Your notes on this player…"
          value={note}
          onChange={(e) => onNote(e.target.value)}
          rows={2}
        />
      )}
    </div>
  );
}

function Dossier({ d }: { d: PlayerDossier }) {
  const showBatting = !d.isPitcher || d.battingYears.length > 0;
  return (
    <div>
      <div className="dossier-head">
        <div>
          <h2 className="dossier-name">
            {d.uniform !== null && <span className="dossier-number">#{d.uniform}</span>} {d.name}
          </h2>
          {d.nickname && <div className="dossier-nick">“{d.nickname}”</div>}
          <div className="muted">
            {d.roleName ?? d.positionName} · B/T {d.bats}/{d.throws} · Age {d.age}
            {d.heightWeight ? ` · ${d.heightWeight}` : ''}
          </div>
          <div className="muted">{d.team ?? 'No club'}{d.serviceYears !== null ? ` · ${d.serviceYears} yrs MLB service` : ''}</div>
          {d.currentInjury && (
            <div className="injury-note">
              🩹 {d.currentInjury.status}
              {d.currentInjury.daysLeft ? ` — ~${d.currentInjury.daysLeft} days remaining` : ''}
            </div>
          )}
          <WatchControls playerId={d.player_id} name={d.name} />
        </div>
        <div className="dossier-pcts">
          <div className="card">
            <span className="card-label"><Tip label="Value" tip={TIP_VALUE} /></span>
            <span className="card-value"><Pct v={d.overallPct} /></span>
          </div>
          <div className="card">
            <span className="card-label"><Tip label="Talent" tip={TIP_TALENT} /></span>
            <span className="card-value"><Pct v={d.talentPct} /></span>
          </div>
        </div>
      </div>

      <div className="dossier-columns">
        {d.isPitcher && d.pitchingRatings && (
          <section>
            <h3>Pitching</h3>
            {d.velocity && <p className="muted velo">Velocity: <strong>{d.velocity}</strong></p>}
            <RatingRows ratings={d.pitchingRatings} />
            {d.pitches.length > 0 && (
              <>
                <h3>Arsenal</h3>
                <RatingRows
                  ratings={Object.fromEntries(d.pitches.map((p) => [p.name, [p.rating, p.talent] as [number, number]]))}
                  labels={PITCH_LABELS}
                />
              </>
            )}
          </section>
        )}
        {!d.isPitcher && d.battingRatings && (
          <section>
            <h3>Batting</h3>
            <RatingRows ratings={d.battingRatings} />
          </section>
        )}
        <section>
          {!d.isPitcher && d.fieldingRatings && (
            <>
              <h3>Fielding</h3>
              <RatingRows
                ratings={Object.fromEntries(
                  Object.entries(d.fieldingRatings)
                    .filter(([, v]) => v > 0)
                    .map(([k, v]) => [k, [v, v] as [number, number]])
                )}
              />
            </>
          )}
          {d.contract && d.contract.salarySchedule.length > 0 && (
            <>
              <h3>Contract{d.contract.noTrade ? ' · no-trade' : ''}</h3>
              <table className="mini">
                <tbody>
                  {d.contract.salarySchedule.map((s) => (
                    <tr key={s.year}>
                      <td>{s.year}</td>
                      <td className="num">{money(s.salary)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>

      {showBatting && d.battingYears.length > 0 && (
        <section>
          <h3>Batting History</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr>
                  <th>Year</th><th>Team</th><th>Lvl</th><th>PA</th><th>HR</th><th>RBI</th><th>SB</th>
                  <th>AVG</th><th>OBP</th><th>SLG</th><th>WAR</th>
                </tr>
              </thead>
              <tbody>
                {d.battingYears.map((y, i) => (
                  <tr key={i}>
                    <td>{y.year}</td>
                    <td>{y.team ?? '—'}</td>
                    <td><span className="level-tag">{y.levelName}</span></td>
                    <td className="num">{y.pa}</td>
                    <td className="num">{y.hr}</td>
                    <td className="num">{y.rbi}</td>
                    <td className="num">{y.sb}</td>
                    <td className="num">{fmt3(y.avg as number | null)}</td>
                    <td className="num">{fmt3(y.obp as number | null)}</td>
                    <td className="num">{fmt3(y.slg as number | null)}</td>
                    <td className="num">{y.war}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.gameLogs.length > 0 && !d.isPitcher && (
        <section>
          <h3>Last {d.gameLogs.length} Games</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Date</th><th>Opp</th><th>AB</th><th>H</th><th>HR</th><th>RBI</th><th>BB</th><th>K</th><th>SB</th></tr>
              </thead>
              <tbody>
                {d.gameLogs.map((g, i) => (
                  <tr key={i}>
                    <td>{g.date}</td><td>{g.opp}</td>
                    <td className="num">{g.ab}</td>
                    <td className="num">{g.h}</td>
                    <td className="num">{g.hr}</td>
                    <td className="num">{g.rbi}</td>
                    <td className="num">{g.bb}</td>
                    <td className="num">{g.k}</td>
                    <td className="num">{g.sb}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.pitchingGameLogs.length > 0 && (
        <section>
          <h3>Recent Outings</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Date</th><th>Opp</th><th>GS</th><th>IP</th><th>ER</th><th>H</th><th>BB</th><th>K</th></tr>
              </thead>
              <tbody>
                {d.pitchingGameLogs.map((g, i) => (
                  <tr key={i}>
                    <td>{g.date}</td><td>{g.opp}</td>
                    <td className="num">{g.gs}</td>
                    <td className="num">{g.ip}</td>
                    <td className="num">{g.er}</td>
                    <td className="num">{g.ha}</td>
                    <td className="num">{g.bb}</td>
                    <td className="num">{g.k}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {(d.fieldingYears?.length ?? 0) > 0 && (
        <section>
          <h3>Fielding</h3>
          <table>
            <thead>
              <tr>
                <th>Year</th><th>Lvl</th><th>Pos</th>
                <th className="num">G</th><th className="num">Inn</th>
                <th className="num">PO</th><th className="num">A</th><th className="num">E</th>
                <th className="num">DP</th><th className="num">FPCT</th><th className="num">RF/9</th>
              </tr>
            </thead>
            <tbody>
              {(d.fieldingYears ?? []).slice(0, 14).map((f, i) => (
                <tr key={i}>
                  <td className="num">{f.year}</td>
                  <td><span className="lvl-badge">{f.levelName}</span></td>
                  <td>{f.positionName}</td>
                  <td className="num">{f.g}</td>
                  <td className="num">{Math.round(f.innings)}</td>
                  <td className="num">{f.po}</td>
                  <td className="num">{f.a}</td>
                  <td className="num">{f.e}</td>
                  <td className="num">{f.dp}</td>
                  <td className="num">{f.fpct !== null ? f.fpct.toFixed(3).replace(/^0\./, '.') : ''}</td>
                  <td className="num">{f.rf9 !== null ? f.rf9.toFixed(2) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Honours first: what a player WAS is the headline of a career page */}
      {(d.awards?.length ?? 0) > 0 && (
        <section>
          <h3>Honours</h3>
          <div className="award-list">
            {Object.entries(
              (d.awards ?? []).reduce<Record<string, number[]>>((acc, a) => {
                const label = a.positionName ? `${a.award} (${a.positionName})` : a.award;
                (acc[label] ??= []).push(a.year);
                return acc;
              }, {})
            )
              // Keep the server's ordering: MVP before an All-Star nod
              .sort(
                (a, b) =>
                  ((d.awards ?? []).find((x) =>
                    (x.positionName ? `${x.award} (${x.positionName})` : x.award) === a[0]
                  )?.rank ?? 99) -
                  ((d.awards ?? []).find((x) =>
                    (x.positionName ? `${x.award} (${x.positionName})` : x.award) === b[0]
                  )?.rank ?? 99)
              )
              .map(([label, years]) => (
                <div key={label} className="award-row">
                  <span className="award-name">
                    {years.length > 1 && <strong>{years.length}× </strong>}
                    {label}
                  </span>
                  <span className="muted">{years.sort((a, b) => b - a).join(', ')}</span>
                </div>
              ))}
          </div>
        </section>
      )}

      {(d.leagueLeader?.length ?? 0) > 0 && (
        <section>
          <h3>Led the League</h3>
          <table className="mini">
            <tbody>
              {(d.leagueLeader ?? []).slice(0, 12).map((l, i) => (
                <tr key={i}>
                  <td className="num muted">{l.year}</td>
                  <td className="num">{l.place === 1 ? '1st' : l.place === 2 ? '2nd' : '3rd'}</td>
                  <td>{l.category}</td>
                  <td className="num">{l.amount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {d.injuryHistory.length > 0 && (
        <section>
          <h3>Injury History</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr><th>Date</th><th>Missed</th><th>Type</th></tr>
              </thead>
              <tbody>
                {d.injuryHistory.map((h, i) => (
                  <tr key={i}>
                    <td>{h.date}</td>
                    <td className="num">{h.length ? `${h.length} days` : '—'}</td>
                    <td>{h.day_to_day === 1 ? 'Day-to-day' : 'IL stint'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {d.pitchingYears.length > 0 && (
        <section>
          <h3>Pitching History</h3>
          <div className="history-scroll">
            <table className="mini">
              <thead>
                <tr>
                  <th>Year</th><th>Team</th><th>Lvl</th><th>G</th><th>GS</th><th>W-L</th><th>SV</th>
                  <th>IP</th><th>ERA</th><th>WHIP</th><th>K</th><th>BB</th><th>WAR</th>
                </tr>
              </thead>
              <tbody>
                {d.pitchingYears.map((y, i) => (
                  <tr key={i}>
                    <td>{y.year}</td>
                    <td>{y.team ?? '—'}</td>
                    <td><span className="level-tag">{y.levelName}</span></td>
                    <td className="num">{y.g}</td>
                    <td className="num">{y.gs}</td>
                    <td className="num">{y.w}-{y.l}</td>
                    <td className="num">{y.sv}</td>
                    <td className="num">{y.ip}</td>
                    <td className="num">{y.era}</td>
                    <td className="num">{y.whip}</td>
                    <td className="num">{y.k}</td>
                    <td className="num">{y.bb}</td>
                    <td className="num">{y.war}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function RatingRows({
  ratings, labels = RATING_LABELS,
}: { ratings: Record<string, [number, number]>; labels?: Record<string, string> }) {
  return (
    <div className="rating-rows">
      {Object.entries(ratings).map(([key, [cur, pot]]) => (
        <div key={key} className="rating-row">
          <span className="rating-row-label">{labels[key] ?? key}</span>
          <div className="rating wide">
            <div
              className="rating-bar"
              style={{ width: `${Math.min(100, (cur / 80) * 100)}%`, background: `hsl(${(cur / 80) * 120}, 65%, 45%)` }}
            />
            {pot > cur && (
              <div className="rating-pot" style={{ left: `${Math.min(100, (pot / 80) * 100)}%` }} />
            )}
            <span>{cur}{pot > cur ? ` / ${pot}` : ''}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function Pct({ v }: { v: number | null }) {
  if (v === null) return <span className="muted">—</span>;
  return <span style={{ color: `hsl(${(v / 100) * 120}, 65%, 55%)` }}>{v}</span>;
}
