import { useEffect, useState } from 'react';
import { apiDelete, apiGet } from '../api';
import { PlayerLink } from '../playerModal';

interface WatchEntry {
  player_id: number; name: string; note: string; added_at: string;
  age: number | null; position: number | null; team: string | null; level: number | null;
}

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const LEVEL_NAMES: Record<number, string> = { 1: 'MLB', 2: 'AAA', 3: 'AA', 4: 'A', 5: 'A', 6: 'R' };

export function Watchlist() {
  const [entries, setEntries] = useState<WatchEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    apiGet<WatchEntry[]>('/api/watchlist').then(setEntries).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const remove = async (id: number) => {
    await apiDelete(`/api/watchlist/${id}`);
    load();
  };

  if (error) return <div className="banner error">{error}</div>;
  if (!entries) return <p className="muted">Opening your scouting notebook…</p>;
  if (entries.length === 0) {
    return (
      <div className="hint">
        <h3>Your scouting notebook is empty</h3>
        <p>
          Open any player card and hit <strong>☆ Watch</strong> to track trade targets, free agents, or prospects —
          with your own notes. They'll all be collected here.
        </p>
      </div>
    );
  }

  return (
    <div>
      <table>
        <thead>
          <tr><th>Player</th><th>Age</th><th>Pos</th><th>Team</th><th>Your notes</th><th></th></tr>
        </thead>
        <tbody>
          {entries.map((w) => (
            <tr key={w.player_id}>
              <td className="name"><PlayerLink id={w.player_id}>{w.name}</PlayerLink></td>
              <td>{w.age ?? '—'}</td>
              <td>{w.position !== null ? POSITION_NAMES[w.position] ?? '?' : '—'}</td>
              <td>
                {w.level !== null && <span className="level-tag">{LEVEL_NAMES[w.level] ?? 'R'}</span>} {w.team ?? '—'}
              </td>
              <td className="reasons">{w.note || <span className="muted">no notes yet — add them on the player card</span>}</td>
              <td><button className="chip-x" onClick={() => remove(w.player_id)} title="Remove">✕</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
