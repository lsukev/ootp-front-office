import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';
import { Th } from '../Th';

interface DraftProspect {
  player_id: number; name: string; age: number; positionName: string; bats: string; throws: string;
  school: string; isPitcher: boolean; cur: number | null; pot: number | null; speed: number | null;
}
interface DraftData {
  leagueName: string;
  hasDraft: boolean;
  poolVisible: boolean;
  gameDate: string | null;
  draftDate: string | null;
  poolDate: string | null;
  combineDate: string | null;
  rounds: number;
  total: number;
  batters: DraftProspect[];
  pitchers: DraftProspect[];
}

/** Builds a local Date from YYYY-MM-DD, which Date.parse would read as UTC. */
const asDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const pretty = (iso: string | null): string =>
  iso ? asDate(iso).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';

/** Month and day only — for a date in a season the save has not reached. */
const monthDay = (iso: string | null): string =>
  iso ? asDate(iso).toLocaleDateString([], { month: 'long', day: 'numeric' }) : '';

const daysUntil = (from: string, to: string): number =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);

function Calendar({ data }: { data: DraftData }) {
  const stops: Array<[string, string | null]> = [
    ['Class published', data.poolDate],
    ['Combine', data.combineDate],
    ['Draft day', data.draftDate],
  ];
  const known = stops.filter(([, d]) => d);
  if (known.length === 0) return null;
  return (
    <table className="mini">
      <tbody>
        {known.map(([label, d]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="num">{pretty(d)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Draft({ orgId }: { orgId: number }) {
  const [data, setData] = useState<DraftData | null>(null);
  const [tab, setTab] = useState<'batters' | 'pitchers'>('batters');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<DraftData>(`/api/draft/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the scouting reports…</p>;

  // A reserve-era or custom league may simply have no amateur draft
  if (!data.hasDraft) {
    return (
      <div className="hint">
        <h3>No amateur draft</h3>
        <p>{data.leagueName} does not run one, so there is no class to scout.</p>
      </div>
    );
  }

  // OOTP has not published the class yet. Its players are in the export, but
  // they appear on no screen inside the game, so they are not shown here either.
  if (!data.poolVisible) {
    const before = !!(data.gameDate && data.poolDate && data.poolDate > data.gameDate);
    return (
      <div className="hint">
        <h3>The class has not been published yet</h3>
        <p>
          {before ? (
            <>
              {data.leagueName} publishes the draft class on <strong>{pretty(data.poolDate)}</strong>
              {data.gameDate && <> — {daysUntil(data.gameDate, data.poolDate!)} days from now</>}. The
              board fills in on its own that morning.
            </>
          ) : (
            <>
              This year&rsquo;s draft is behind you. The next class is published around{' '}
              <strong>{monthDay(data.poolDate) || 'the same date next season'}</strong>.
            </>
          )}
        </p>
        <p className="muted">
          Amateurs exist in your export before then, but OOTP keeps them off every screen until the
          class is announced — they are on no team, in no league, and in no draft pool. Ranking them
          early would be scouting information the game has not given you.
        </p>
        <Calendar data={data} />
      </div>
    );
  }

  const rows = tab === 'batters' ? data.batters : data.pitchers;

  return (
    <div>
      <div className="toolbar">
        <span className="muted">
          {data.total} draft-eligible players, ranked by scouted ceiling.
          {data.draftDate && data.gameDate && (
            <> Draft day is {pretty(data.draftDate)}, {daysUntil(data.gameDate, data.draftDate)} days out
              {data.rounds > 0 && <> — {data.rounds} rounds</>}.
            </>
          )}
        </span>
        <div className="tabs">
          <button className={tab === 'batters' ? 'active' : ''} onClick={() => setTab('batters')}>Batters</button>
          <button className={tab === 'pitchers' ? 'active' : ''} onClick={() => setTab('pitchers')}>Pitchers</button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <Th>Rk</Th><Th>Player</Th><Th>Age</Th><Th>Pos</Th><Th>B/T</Th><Th>From</Th>
            <th><Tip label="Cur→Pot" tip={TIP_CURPOT} /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p, i) => (
            <tr key={p.player_id}>
              <td className="num muted">{i + 1}</td>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.age}</td>
              <td>{p.positionName}</td>
              <td>{p.bats}/{p.throws}</td>
              <td>{p.school}</td>
              <td className="num">{p.cur ?? '?'}{p.pot !== null && p.pot !== p.cur ? `→${p.pot}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
