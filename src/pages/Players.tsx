import { useEffect, useRef, useState } from 'react';
import { apiGet, type Org } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { ColumnPicker } from '../ColumnPicker';
import {
  DEFAULT_BATTING, DEFAULT_PITCHING, findStat, formatStat, loadColumns, plusColor, saveColumns,
  type StatGroup,
} from '../stats';

interface LeaguePlayer {
  player_id: number;
  name: string;
  age: number;
  positionName: string;
  bats: string;
  throws: string;
  team: string | null;
  abbr: string | null;
  levelName: string | null;
  stats: Record<string, number | null> | null;
}
interface PlayersResponse {
  total: number;
  offset: number;
  limit: number;
  players: LeaguePlayer[];
}

const LEVELS: Array<[string, string]> = [
  ['1', 'MLB'], ['2', 'AAA'], ['3', 'AA'], ['4', 'A'], ['6', 'Rookie'], ['all', 'All levels'],
];
const PAGE = 100;

export function Players({ orgs, orgId }: { orgs: Org[]; orgId: number }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState('1');
  const [scope, setScope] = useState<'league' | 'org' | 'fa'>('league');
  const [group, setGroup] = useState<StatGroup>('batting');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<PlayersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [battingCols, setBattingCols] = useState(() => loadColumns('batting'));
  const [pitchingCols, setPitchingCols] = useState(() => loadColumns('pitching'));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce so typing a name doesn't fire a query per keystroke
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setDebounced(query);
      setOffset(0);
    }, 300);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  useEffect(() => {
    setData(null);
    const params = new URLSearchParams({ group, limit: String(PAGE), offset: String(offset) });
    if (debounced.trim().length >= 2) params.set('q', debounced.trim());
    if (scope === 'fa') params.set('freeAgents', '1');
    else {
      params.set('level', level);
      if (scope === 'org') params.set('orgId', String(orgId));
    }
    apiGet<PlayersResponse>(`/api/players?${params}`).then(setData).catch((e) => setError(e.message));
  }, [debounced, level, scope, group, offset, orgId]);

  const columns = group === 'batting' ? battingCols : pitchingCols;
  const setColumns = (keys: string[]) => {
    if (group === 'batting') setBattingCols(keys);
    else setPitchingCols(keys);
    saveColumns(group, keys);
  };

  const orgLabel = orgs.find((o) => o.team_id === orgId)?.label ?? 'my org';

  return (
    <div>
      {error && <div className="banner error">{error}</div>}

      <div className="toolbar players-toolbar">
        <input
          className="trade-search player-search"
          placeholder="Search players by name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="tabs">
          <button className={group === 'batting' ? 'active' : ''} onClick={() => { setGroup('batting'); setOffset(0); }}>
            Batters
          </button>
          <button className={group === 'pitching' ? 'active' : ''} onClick={() => { setGroup('pitching'); setOffset(0); }}>
            Pitchers
          </button>
        </div>
        <select value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setOffset(0); }}>
          <option value="league">Whole league</option>
          <option value="org">{orgLabel} only</option>
          <option value="fa">Free agents</option>
        </select>
        {scope !== 'fa' && (
          <select value={level} onChange={(e) => { setLevel(e.target.value); setOffset(0); }}>
            {LEVELS.map(([v, label]) => (
              <option key={v} value={v}>{label}</option>
            ))}
          </select>
        )}
        <div className="col-picker-wrap">
          <button onClick={() => setPickerOpen((v) => !v)}>⚙ Columns</button>
          {pickerOpen && (
            <ColumnPicker
              group={group}
              selected={columns}
              onChange={setColumns}
              onClose={() => setPickerOpen(false)}
              onReset={() => setColumns(group === 'batting' ? DEFAULT_BATTING : DEFAULT_PITCHING)}
            />
          )}
        </div>
      </div>

      {!data && <p className="muted">Searching…</p>}

      {data && (
        <>
          <p className="muted hint-line">
            {data.total.toLocaleString()} player{data.total === 1 ? '' : 's'} match
            {data.total > PAGE && ` — showing ${offset + 1}–${Math.min(offset + PAGE, data.total)}`}
          </p>
          <table>
            <thead>
              <tr>
                <th>Player</th><th>Age</th><th>Pos</th><th>B/T</th><th>Team</th>
                {columns.map((key) => {
                  const def = findStat(group, key);
                  return def ? <th key={key}><Tip label={def.label} tip={def.desc} /></th> : null;
                })}
              </tr>
            </thead>
            <tbody>
              {data.players.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td>{p.age}</td>
                  <td>{p.positionName}</td>
                  <td>{p.bats}/{p.throws}</td>
                  <td>
                    {p.levelName && <span className="level-tag">{p.levelName}</span>} {p.team ?? '—'}
                  </td>
                  {columns.map((key) => {
                    const def = findStat(group, key);
                    if (!def) return null;
                    const value = p.stats?.[key] ?? null;
                    return (
                      <td key={key} className="num" style={{ color: plusColor(def, value) }}>
                        {p.stats ? formatStat(def, value, p.stats) : ''}
                      </td>
                    );
                  })}
                </tr>
              ))}
              {data.players.length === 0 && (
                <tr><td colSpan={5 + columns.length} className="muted">No players match those filters.</td></tr>
              )}
            </tbody>
          </table>

          {data.total > PAGE && (
            <div className="pager">
              <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
                ← Previous
              </button>
              <span className="muted">
                Page {Math.floor(offset / PAGE) + 1} of {Math.ceil(data.total / PAGE)}
              </span>
              <button disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
