import { useEffect, useMemo, useState } from 'react';
import { getDepthChart, type DepthPlayer, type DepthTeam } from '../api';
import { formatOverallPair } from '../ratingScale';
import { PlayerLink } from '../playerModal';
import { Th } from '../Th';

/**
 * A man covers a position when OOTP rates him there, not only when it is the
 * one on his card: "I have only one player with a primary position of RF, but
 * two others list it as a secondary position. The app always says I only have
 * one." The server now sends every position he is rated at, primary first.
 */
const covers = (p: DepthPlayer, pos: number): boolean =>
  (p.positions ?? [p.position]).includes(pos);

const ROWS: Array<{ label: string; match: (p: DepthPlayer) => boolean }> = [
  // A pitcher's role is his position here; nobody is a secondary starter
  { label: 'SP', match: (p) => p.position === 1 && p.role === 11 },
  { label: 'RP', match: (p) => p.position === 1 && p.role !== 11 },
  { label: 'C', match: (p) => covers(p, 2) },
  { label: '1B', match: (p) => covers(p, 3) },
  { label: '2B', match: (p) => covers(p, 4) },
  { label: '3B', match: (p) => covers(p, 5) },
  { label: 'SS', match: (p) => covers(p, 6) },
  { label: 'LF', match: (p) => covers(p, 7) },
  { label: 'CF', match: (p) => covers(p, 8) },
  { label: 'RF', match: (p) => covers(p, 9) },
  { label: 'DH', match: (p) => p.position === 10 },
];

/** The position each row is about, for telling a primary from a fill-in. */
const ROW_POS: Record<string, number> = {
  SP: 1, RP: 1, C: 2, '1B': 3, '2B': 4, '3B': 5, SS: 6, LF: 7, CF: 8, RF: 9, DH: 10,
};

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
          /*
           * Primaries first, then the men who can cover it, each group by
           * ability. A secondary standing above the man whose position it is
           * would answer a question nobody asked.
           */
          .sort((a, b) => {
            const own = (p: DepthPlayer) => (ROW_POS[row.label] === p.position ? 0 : 1);
            return own(a) - own(b) || (b.cur ?? 0) - (a.cur ?? 0);
          })
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
            <Th>Pos</Th>
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
                  {/*
                    A name is capped at 130px and ellipsised, because the grid
                    needs one line per man — and this save has men called
                    Christian Encarnacion-Strand. The title carries the whole of
                    it, so a cut name can still be read.
                  */}
                  {cell.map((p) => (
                    <div
                      key={p.player_id}
                      className={ROW_POS[row.label] === p.position ? 'depth-player' : 'depth-player secondary'}
                      title={
                        ROW_POS[row.label] === p.position
                          ? `${p.name} · age ${p.age}`
                          : `${p.name} · age ${p.age} · rated here, not his primary position`
                      }
                    >
                      <span className="depth-name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></span>
                      <span className="depth-meta">
                        {p.age} · {formatOverallPair(p.cur, p.pot)}
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
