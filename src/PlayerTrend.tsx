import { useEffect, useMemo, useState } from 'react';
import { apiGet } from './api';
import { LineChart } from './Chart';

interface TrendPoint { game: number; date: string | null; toDate: number | null; rolling: number | null }
interface SeasonRow { year: number; [k: string]: number | null }
interface TrendData {
  name: string;
  year: number;
  window: number;
  level: number | null;
  batting: Record<string, TrendPoint[]>;
  pitching: Record<string, TrendPoint[]>;
  seasons: SeasonRow[];
  armSeasons: SeasonRow[];
}

const ACCENT = 'var(--accent)';
const MUTED = 'var(--muted)';

const BAT_METRICS = [
  { key: 'avg', label: 'AVG', places: 3 },
  { key: 'obp', label: 'OBP', places: 3 },
  { key: 'slg', label: 'SLG', places: 3 },
  { key: 'ops', label: 'OPS', places: 3 },
];
const ARM_METRICS = [
  { key: 'era', label: 'ERA', places: 2 },
  { key: 'whip', label: 'WHIP', places: 2 },
  { key: 'k9', label: 'K/9', places: 1 },
];

const fmt = (places: number) => (v: number) =>
  places === 3 ? v.toFixed(3).replace(/^0\./, '.') : v.toFixed(places);

/**
 * A season as it happened.
 *
 * A season line is one number standing for six months. This is the same number
 * drawn as it moved: the man's card as it read that night, and his form over
 * the last fortnight beside it, which answer different questions and mislead in
 * different ways.
 */
export function PlayerTrend({ playerId }: { playerId: number }) {
  const [data, setData] = useState<TrendData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<string>('ops');
  const [reading, setReading] = useState<'toDate' | 'rolling'>('toDate');

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<TrendData>(`/api/player-trend/${playerId}`).then(setData).catch((e) => setError(e.message));
  }, [playerId]);

  const arm = (data?.pitching && Object.keys(data.pitching).length > 0) ?? false;
  const metrics = arm ? ARM_METRICS : BAT_METRICS;
  const series = arm ? data?.pitching : data?.batting;

  // Fall back to a measure this player actually has
  const chosen = useMemo(() => {
    if (!series) return null;
    return series[metric] ? metric : Object.keys(series)[0] ?? null;
  }, [series, metric]);

  const seasons = arm ? data?.armSeasons ?? [] : data?.seasons ?? [];
  const spec = metrics.find((m) => m.key === chosen) ?? metrics[0];

  if (error) return <p className="muted">Could not read his season: {error}</p>;
  if (!data) return <p className="muted">Reading the game logs…</p>;

  const points = chosen ? series?.[chosen] ?? [] : [];
  const enough = points.length >= 5;
  const bySeason = seasons.filter((s) => s[spec.key] !== null && s[spec.key] !== undefined);

  if (!enough && bySeason.length < 2) {
    return (
      <p className="muted">
        No season to draw yet — this needs a handful of games in the log, and OOTP writes those only
        for seasons the save has actually played.
      </p>
    );
  }

  return (
    <div className="trend-block">
      <div className="toolbar">
        <span className="level-picker">
          {metrics.map((m) => (
            <button
              key={m.key}
              className={m.key === chosen ? 'active' : ''}
              onClick={() => setMetric(m.key)}
            >
              {m.label}
            </button>
          ))}
        </span>
        {enough && (
          <span className="level-picker">
            <button
              className={reading === 'toDate' ? 'active' : ''}
              onClick={() => setReading('toDate')}
            >
              Season to date
            </button>
            <button
              className={reading === 'rolling' ? 'active' : ''}
              onClick={() => setReading('rolling')}
            >
              Last {data.window}
            </button>
          </span>
        )}
      </div>

      {enough && (
        <>
          <LineChart
            series={[
              {
                label: `${spec.label} — ${reading === 'toDate' ? 'season to date' : `last ${data.window} games`}`,
                color: ACCENT,
                points: points.map((p) => p[reading]),
              },
            ]}
            labels={points.map((p) => p.date ?? String(p.game))}
            height={200}
            formatValue={fmt(spec.places)}
            yLabel={spec.label}
          />
          <p className="muted hint-line">
            {reading === 'toDate' ? (
              <>
                His {spec.label} as it stood after each game of {data.year} — the number on his card
                that night. It settles as the season goes on, which is honest: one game in a hundred
                and forty does not move a season.
              </>
            ) : (
              <>
                His {spec.label} over the last {data.window} games he appeared in, which is form
                rather than record. It never settles, and on a fortnight of baseball it will swing on
                very little — read the shape, not the day.
              </>
            )}
          </p>
        </>
      )}

      {bySeason.length >= 2 && (
        <>
          <h4 className="trend-heading">Year over year</h4>
          <LineChart
            series={[{ label: spec.label, color: MUTED, points: bySeason.map((s) => s[spec.key] as number) }]}
            labels={bySeason.map((s) => String(s.year))}
            height={160}
            formatValue={fmt(spec.places)}
            yLabel={spec.label}
          />
          <p className="muted hint-line">
            Major-league seasons only, so a year spent in the minors is a gap rather than a collapse.
          </p>
        </>
      )}
    </div>
  );
}
