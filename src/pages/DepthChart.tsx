import { useEffect, useMemo, useState } from 'react';
import { getDepthChart, type DepthPlayer, type DepthTeam } from '../api';
import { PlayerLink } from '../playerModal';

const ROWS: Array<{ label: string; match: (p: DepthPlayer) => boolean }> = [
  { label: 'SP', match: (p) => p.position === 1 && p.role === 11 },
  { label: 'RP', match: (p) => p.position === 1 && p.role !== 11 },
  { label: 'C', match: (p) => p.position === 2 },
  { label: '1B', match: (p) => p.position === 3 },
  { label: '2B', match: (p) => p.position === 4 },
  { label: '3B', match: (p) => p.position === 5 },
  { label: 'SS', match: (p) => p.position === 6 },
  { label: 'LF', match: (p) => p.position === 7 },
  { label: 'CF', match: (p) => p.position === 8 },
  { label: 'RF', match: (p) => p.position === 9 },
  { label: 'DH', match: (p) => p.position === 10 },
];

export function DepthChart({ orgId }: { orgId: number }) {
  const [data, setData] = useState<{ teams: DepthTeam[]; players: DepthPlayer[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    getDepthChart(orgId).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  const grid = useMemo(() => {
    if (!data) return null;
    return ROWS.map((row) => ({
      label: row.label,
      cells: data.teams.map((t) =>
        data.players
          .filter((p) => p.team_id === t.team_id && row.match(p))
          .sort((a, b) => (b.cur ?? 0) - (a.cur ?? 0))
      ),
    }));
  }, [data]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data || !grid) return <p className="muted">Loading depth chart…</p>;

  return (
    <div className="depth-scroll">
      <table className="depth">
        <thead>
          <tr>
            <th>Pos</th>
            {data.teams.map((t) => (
              <th key={t.team_id}>
                <span className="level-tag">{t.levelName}</span> {t.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row) => (
            <tr key={row.label}>
              <td className="pos-label">{row.label}</td>
              {row.cells.map((cell, i) => (
                <td key={i} className="depth-cell">
                  {cell.map((p) => (
                    <div key={p.player_id} className="depth-player" title={`age ${p.age}`}>
                      <span className="depth-name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></span>
                      <span className="depth-meta">
                        {p.age} · {p.cur ?? '?'}
                        {p.pot !== null && p.pot !== p.cur ? `→${p.pot}` : ''}
                      </span>
                    </div>
                  ))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
