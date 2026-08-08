import { useId, useMemo, useState } from 'react';

/**
 * Small inline SVG charts. Deliberately hand-rolled rather than pulling in a
 * charting library: the desktop build has a strict offline requirement and a
 * chart package would be the single largest dependency in the app.
 */

export interface Series {
  label: string;
  color: string;
  points: Array<number | null>;
}

interface LineChartProps {
  series: Series[];
  /** One label per x position; only a few are drawn. */
  labels: string[];
  height?: number;
  /** Draws a horizontal rule, e.g. zero for a differential chart. */
  baseline?: number;
  formatValue?: (v: number) => string;
  yLabel?: string;
}

const niceTicks = (min: number, max: number, count = 4): number[] => {
  if (min === max) return [min];
  const raw = (max - min) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? mag * 10;
  const start = Math.ceil(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 0.001; v += step) ticks.push(Number(v.toFixed(6)));
  return ticks;
};

export function LineChart({
  series, labels, height = 200, baseline, formatValue = (v) => String(Math.round(v)), yLabel,
}: LineChartProps) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);

  const W = 800;
  const H = height;
  const PAD = { top: 12, right: 14, bottom: 24, left: 46 };
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;

  const { min, max, n } = useMemo(() => {
    const all = series.flatMap((s) => s.points).filter((v): v is number => v !== null);
    const lo = all.length ? Math.min(...all) : 0;
    const hi = all.length ? Math.max(...all) : 1;
    const pad = (hi - lo) * 0.1 || 1;
    let low = lo - pad;
    let high = hi + pad;
    if (baseline !== undefined) {
      low = Math.min(low, baseline);
      high = Math.max(high, baseline);
    }
    return { min: low, max: high, n: Math.max(...series.map((s) => s.points.length), 1) };
  }, [series, baseline]);

  const x = (i: number) => PAD.left + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min || 1)) * plotH;

  const path = (points: Array<number | null>): string => {
    let d = '';
    let pen = false;
    points.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      pen = true;
    });
    return d.trim();
  };

  const ticks = niceTicks(min, max);
  const labelEvery = Math.max(1, Math.ceil(n / 8));

  return (
    <div className="chart-wrap">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        role="img"
        aria-label={yLabel ? `${yLabel} over time` : 'chart'}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          const i = Math.round(((px - PAD.left) / plotW) * (n - 1));
          setHover(i >= 0 && i < n ? i : null);
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className="chart-grid" />
            <text x={PAD.left - 6} y={y(t) + 4} className="chart-axis" textAnchor="end">
              {formatValue(t)}
            </text>
          </g>
        ))}

        {baseline !== undefined && (
          <line x1={PAD.left} x2={W - PAD.right} y1={y(baseline)} y2={y(baseline)} className="chart-baseline" />
        )}

        {labels.map((l, i) =>
          i % labelEvery === 0 ? (
            <text key={`${l}-${i}`} x={x(i)} y={H - 6} className="chart-axis" textAnchor="middle">
              {l}
            </text>
          ) : null
        )}

        {series.map((s) => (
          <path key={`${id}-${s.label}`} d={path(s.points)} fill="none" stroke={s.color} strokeWidth={2} />
        ))}

        {hover !== null && (
          <>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + plotH} className="chart-cursor" />
            {series.map((s) => {
              const v = s.points[hover];
              return v === null || v === undefined ? null : (
                <circle key={`dot-${s.label}`} cx={x(hover)} cy={y(v)} r={3.5} fill={s.color} />
              );
            })}
          </>
        )}
      </svg>

      <div className="chart-legend">
        {series.map((s) => (
          <span key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
            {hover !== null && s.points[hover] !== null && s.points[hover] !== undefined && (
              <strong> {formatValue(s.points[hover] as number)}</strong>
            )}
          </span>
        ))}
        {hover !== null && labels[hover] && <span className="muted">{labels[hover]}</span>}
      </div>
    </div>
  );
}

/** A bare inline trend line, sized to sit inside a table cell. */
export function Sparkline({
  points, color = 'currentColor', width = 90, height = 22,
}: {
  points: Array<number | null>;
  color?: string;
  width?: number;
  height?: number;
}) {
  const real = points.filter((v): v is number => v !== null);
  if (real.length < 2) return <span className="muted">—</span>;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min || 1;
  const d = points
    .map((v, i) => {
      if (v === null) return null;
      const px = (i / (points.length - 1)) * (width - 2) + 1;
      const py = height - 1 - ((v - min) / span) * (height - 2);
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .filter(Boolean)
    .join(' L');
  const last = real[real.length - 1];
  const first = real[0];
  return (
    <svg width={width} height={height} className="sparkline" aria-hidden="true">
      <path d={`M${d}`} fill="none" stroke={color} strokeWidth={1.5} opacity={0.85} />
      <circle
        cx={width - 1}
        cy={height - 1 - ((last - min) / span) * (height - 2)}
        r={2}
        fill={last >= first ? '#6fcf90' : '#e07b7b'}
      />
    </svg>
  );
}
