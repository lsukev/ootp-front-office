import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { LineChart } from '../Chart';

interface TrendsData {
  games: number;
  window: number;
  labels: string[];
  series: {
    cumulativeDiff: number[];
    runsScoredRolling: Array<number | null>;
    runsAllowedRolling: Array<number | null>;
    winPct: Array<number | null>;
  };
  totals: { scored: number; allowed: number; perGameScored: number; perGameAllowed: number };
}

const ACCENT = 'var(--accent)';
const GOOD = '#6fcf90';
const BAD = '#e07b7b';

export function Trends({ teamId }: { teamId: number }) {
  const [data, setData] = useState<TrendsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<TrendsData>(`/api/trends/${teamId}`).then(setData).catch((e) => setError(e.message));
  }, [teamId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Plotting the season…</p>;
  if (data.games === 0) return <p className="muted">No games played yet in this save.</p>;

  const diff = data.series.cumulativeDiff;
  const finalDiff = diff[diff.length - 1] ?? 0;

  return (
    <div>
      <p className="muted hint-line">
        {data.games} games played · {data.totals.perGameScored.toFixed(2)} runs scored per game,{' '}
        {data.totals.perGameAllowed.toFixed(2)} allowed. Smoothed lines use a rolling{' '}
        {data.window}-game window, so single blowouts do not swing them.
      </p>

      <section>
        <h2>
          Run differential{' '}
          <span className={`subtle-count ${finalDiff >= 0 ? 'good-text' : 'bad-text'}`}>
            {finalDiff >= 0 ? '+' : ''}{finalDiff} on the season
          </span>
        </h2>
        <LineChart
          series={[{ label: 'Cumulative run differential', color: ACCENT, points: diff }]}
          labels={data.labels}
          baseline={0}
          height={220}
          formatValue={(v) => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)))}
          yLabel="Run differential"
        />
        <p className="muted hint-line">
          Every game moves the line by that game&rsquo;s margin. A line drifting down while the
          record looks fine is the classic sign of a team winning close games it will not keep
          winning.
        </p>
      </section>

      <section>
        <h2>Scoring and run prevention</h2>
        <LineChart
          series={[
            { label: `Runs scored (${data.window}-game avg)`, color: GOOD, points: data.series.runsScoredRolling },
            { label: `Runs allowed (${data.window}-game avg)`, color: BAD, points: data.series.runsAllowedRolling },
          ]}
          labels={data.labels}
          height={200}
          formatValue={(v) => v.toFixed(1)}
          yLabel="Runs per game"
        />
        <p className="muted hint-line">
          The lines start once {data.window} games are in the books — a rolling average has nothing
          to say before then.
        </p>
      </section>

      <section>
        <h2>Winning percentage</h2>
        <LineChart
          series={[{ label: 'Win %', color: ACCENT, points: data.series.winPct }]}
          labels={data.labels}
          baseline={50}
          height={180}
          formatValue={(v) => `${Math.round(v)}%`}
          yLabel="Win percentage"
        />
        <p className="muted hint-line">Season-to-date, not a rolling window. The rule marks .500.</p>
      </section>
    </div>
  );
}
