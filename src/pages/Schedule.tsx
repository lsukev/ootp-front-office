import { useEffect, useRef, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { TeamLogo } from '../TeamLogo';

interface Probable { player_id: number; name: string; throws: string }
interface Game {
  game_id: number;
  date: string;
  isHome: boolean;
  oppId: number;
  opponent: string;
  played: boolean;
  us: number | null;
  them: number | null;
  won: boolean | null;
  extraInnings: boolean;
  ourStarter: Probable | null;
  theirStarter: Probable | null;
}
interface Series {
  opponent: string;
  oppId: number;
  isHome: boolean;
  opponentRecord: { w: number; l: number; pct: number } | null;
  startDate: string;
  endDate: string;
  games: Game[];
  played: boolean;
  inProgress: boolean;
  wins: number;
  losses: number;
}
interface ScheduleData {
  record: { w: number; l: number; home: string; away: string; runsFor: number; runsAgainst: number } | null;
  nextSeriesIndex: number;
  series: Series[];
}

/** OOTP writes dates unpadded (2026-4-9), which Date cannot parse reliably. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[(m ?? 1) - 1]} ${d}`;
}
const dateRange = (a: string, b: string) => (a === b ? shortDate(a) : `${shortDate(a)} – ${shortDate(b)}`);

export function Schedule({ teamId }: { teamId: number }) {
  const [data, setData] = useState<ScheduleData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'upcoming' | 'played'>('all');
  const nextRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<ScheduleData>(`/api/schedule/${teamId}`).then(setData).catch((e) => setError(e.message));
  }, [teamId]);

  // Land on the current series rather than opening in March
  useEffect(() => {
    if (data && filter === 'all') nextRef.current?.scrollIntoView({ block: 'center' });
  }, [data, filter]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading the schedule…</p>;

  const shown = data.series.filter((s) =>
    filter === 'all' ? true : filter === 'played' ? s.played || s.inProgress : !s.played
  );

  return (
    <div>
      {data.record && (
        <div className="record-strip">
          <span>
            <strong>{data.record.w}-{data.record.l}</strong> overall
          </span>
          <span className="muted">{data.record.home} home · {data.record.away} away</span>
          <span className="muted">
            {data.record.runsFor} RS · {data.record.runsAgainst} RA{' '}
            <span className={data.record.runsFor - data.record.runsAgainst >= 0 ? 'good-text' : 'bad-text'}>
              ({data.record.runsFor - data.record.runsAgainst >= 0 ? '+' : ''}
              {data.record.runsFor - data.record.runsAgainst})
            </span>
          </span>
        </div>
      )}

      <div className="toolbar">
        <div className="tabs">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Full season</button>
          <button className={filter === 'upcoming' ? 'active' : ''} onClick={() => setFilter('upcoming')}>Upcoming</button>
          <button className={filter === 'played' ? 'active' : ''} onClick={() => setFilter('played')}>Played</button>
        </div>
      </div>

      <div className="series-list">
        {shown.map((s, i) => {
          const isNext = data.series.indexOf(s) === data.nextSeriesIndex;
          return (
            <div
              key={`${s.oppId}-${s.startDate}-${i}`}
              className={`series-card ${isNext ? 'series-next' : ''} ${s.played ? 'series-done' : ''}`}
              ref={isNext ? nextRef : undefined}
            >
              <div className="series-head">
                <TeamLogo teamId={s.oppId} size={50} className="logo-sm" />
                <div className="series-title">
                  <strong>
                    {s.isHome ? 'vs' : '@'} {s.opponent}
                  </strong>
                  {s.opponentRecord && (
                    <span className="muted"> ({s.opponentRecord.w}-{s.opponentRecord.l})</span>
                  )}
                  <div className="muted series-dates">
                    {dateRange(s.startDate, s.endDate)} · {s.games.length} game{s.games.length === 1 ? '' : 's'}
                  </div>
                </div>
                <div className="series-result">
                  {isNext && !s.inProgress && <span className="next-tag">Next up</span>}
                  {(s.played || s.inProgress) && (
                    <span className={s.wins > s.losses ? 'good-text' : s.wins < s.losses ? 'bad-text' : 'muted'}>
                      {s.wins}-{s.losses}
                      {s.inProgress && <span className="muted"> so far</span>}
                    </span>
                  )}
                </div>
              </div>

              <table className="mini series-games">
                <tbody>
                  {s.games.map((g) => (
                    <tr key={g.game_id}>
                      <td className="series-date">{shortDate(g.date)}</td>
                      <td className="series-score">
                        {g.played ? (
                          <span className={g.won ? 'good-text' : 'bad-text'}>
                            {g.won ? 'W' : 'L'} {g.us}-{g.them}
                            {g.extraInnings && <span className="muted"> (x)</span>}
                          </span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td>
                        {g.ourStarter ? (
                          <>
                            <PlayerLink id={g.ourStarter.player_id}>{g.ourStarter.name}</PlayerLink>
                            <span className="muted"> ({g.ourStarter.throws})</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                      <td className="muted series-vs">vs</td>
                      <td>
                        {g.theirStarter ? (
                          <>
                            <PlayerLink id={g.theirStarter.player_id}>{g.theirStarter.name}</PlayerLink>
                            <span className="muted"> ({g.theirStarter.throws})</span>
                          </>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </div>

      <p className="muted hint-line">
        Series are grouped from consecutive games against the same opponent at the same venue.
        Starters for games already played are the actual ones; for upcoming games they come from
        each club&rsquo;s projected rotation and will shift as the season is simmed.
      </p>
    </div>
  );
}
