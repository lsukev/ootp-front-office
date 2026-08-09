import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink } from '../playerModal';
import { Th } from '../Th';

interface Season {
  year: number;
  w: number; l: number; pct: number; finish: number; gb: number;
  name: string | null;
  madePlayoffs: boolean;
  wonTitle: boolean;
  bestHitter: { player_id: number; name: string | null } | null;
  bestPitcher: { player_id: number; name: string | null } | null;
  payroll: number | null;
  attendance: number | null;
}
interface Summary {
  seasons: number; firstYear: number; lastYear: number;
  wins: number; losses: number; pct: number;
  titles: number; playoffs: number;
  bestSeason: { year: number; w: number; l: number } | null;
  worstSeason: { year: number; w: number; l: number } | null;
}
interface FranchiseData {
  seasons: Season[];
  summary: Summary | null;
}

const pct3 = (v: number): string => v.toFixed(3).replace(/^0\./, '.');
const money = (v: number | null): string => {
  if (!v) return '';
  return Math.abs(v) >= 1_000_000 ? `$${(v / 1_000_000).toFixed(0)}M` : `$${Math.round(v / 1000)}K`;
};

export function Franchise({ orgId }: { orgId: number }) {
  const [data, setData] = useState<FranchiseData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(40);

  useEffect(() => {
    setData(null);
    setError(null);
    setLimit(40);
    apiGet<FranchiseData>(`/api/franchise/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  // Columns that are empty in this save are not worth a heading. OOTP does not
  // fill in a season's best player for every league, and a division finish is
  // missing from the most recent years.
  const shows = useMemo(() => {
    const s = data?.seasons ?? [];
    return {
      best: s.some((x) => x.bestHitter?.name || x.bestPitcher?.name),
      finish: s.some((x) => x.finish > 0),
      payroll: s.some((x) => x.payroll),
      attendance: s.some((x) => x.attendance),
    };
  }, [data]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the record books…</p>;
  if (!data.summary || data.seasons.length === 0) {
    return (
      <div className="hint">
        <h3>No franchise history</h3>
        <p>This export carries no completed seasons for the club.</p>
      </div>
    );
  }

  const s = data.summary;
  const peak = Math.max(...data.seasons.map((x) => x.w), 1);
  const shown = data.seasons.slice(0, limit);

  return (
    <div>
      <div className="finance-grid">
        <div className="finance-card">
          <span className="muted">Seasons</span>
          <strong>{s.seasons}</strong>
          <span className="muted">{s.firstYear}–{s.lastYear}</span>
        </div>
        <div className="finance-card">
          <span className="muted">All-time</span>
          <strong>{s.wins.toLocaleString()}–{s.losses.toLocaleString()}</strong>
          <span className="muted">{pct3(s.pct)}</span>
        </div>
        <div className="finance-card">
          <span className="muted">Titles</span>
          <strong>{s.titles}</strong>
          <span className="muted">{s.playoffs} playoff trips</span>
        </div>
        {s.bestSeason && (
          <div className="finance-card">
            <span className="muted">Best season</span>
            <strong>{s.bestSeason.year}</strong>
            <span className="good-text">{s.bestSeason.w}–{s.bestSeason.l}</span>
          </div>
        )}
        {s.worstSeason && (
          <div className="finance-card">
            <span className="muted">Worst season</span>
            <strong>{s.worstSeason.year}</strong>
            <span className="bad-text">{s.worstSeason.w}–{s.worstSeason.l}</span>
          </div>
        )}
      </div>

      <section>
        <h2>Wins by season</h2>
        {/* Oldest on the left, so the eye reads the franchise forwards in time */}
        <div className="win-curve" role="img" aria-label="Wins in each season">
          {[...data.seasons].reverse().map((x) => (
            <div
              key={x.year}
              className={`win-bar ${x.wonTitle ? 'win-title' : x.madePlayoffs ? 'win-playoff' : ''}`}
              style={{ height: `${Math.max((x.w / peak) * 100, 2)}%` }}
              title={`${x.year}: ${x.w}-${x.l}${x.wonTitle ? ' — won it all' : x.madePlayoffs ? ' — made the playoffs' : ''}`}
            />
          ))}
        </div>
        <p className="muted hint-line">
          Green is a title, gold a playoff appearance. Hover any bar for the season.
        </p>
      </section>

      <section>
        <h2>Season by season</h2>
        <table>
          <thead>
            <tr>
              <Th>Year</Th>
              <Th>Team</Th>
              <Th className="num">W</Th>
              <Th className="num">L</Th>
              <Th className="num">PCT</Th>
              {shows.finish && <Th className="num">Finish</Th>}
              <Th className="num">GB</Th>
              <Th>Result</Th>
              {shows.best && <Th>Best players</Th>}
              {shows.payroll && <Th className="num">Payroll</Th>}
              {shows.attendance && <Th className="num">Attendance</Th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((x) => (
              <tr key={x.year}>
                <td className="num">{x.year}</td>
                <td className="muted">{x.name ?? ''}</td>
                <td className="num">{x.w}</td>
                <td className="num">{x.l}</td>
                <td className="num">{pct3(x.pct)}</td>
                {shows.finish && <td className="num">{x.finish > 0 ? x.finish : ''}</td>}
                <td className="num">{x.gb > 0 ? x.gb : '—'}</td>
                <td>
                  {x.wonTitle ? (
                    <span className="flag flag-locked">Won it all</span>
                  ) : x.madePlayoffs ? (
                    <span className="flag">Playoffs</span>
                  ) : (
                    ''
                  )}
                </td>
                {shows.best && (
                  <td className="muted">
                    {x.bestHitter?.name && (
                      <PlayerLink id={x.bestHitter.player_id}>{x.bestHitter.name}</PlayerLink>
                    )}
                    {x.bestHitter?.name && x.bestPitcher?.name ? ' · ' : ''}
                    {x.bestPitcher?.name && (
                      <PlayerLink id={x.bestPitcher.player_id}>{x.bestPitcher.name}</PlayerLink>
                    )}
                  </td>
                )}
                {shows.payroll && <td className="num">{money(x.payroll)}</td>}
                {shows.attendance && (
                  <td className="num">{x.attendance ? x.attendance.toLocaleString() : ''}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
        {data.seasons.length > shown.length && (
          <p>
            <button onClick={() => setLimit((n) => n + 60)}>
              Show {Math.min(60, data.seasons.length - shown.length)} earlier seasons
            </button>
          </p>
        )}
      </section>
    </div>
  );
}
