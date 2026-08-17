import { useEffect, useRef, useState, type ReactNode } from 'react';
import { apiGet, type Org } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { ColumnPicker } from '../ColumnPicker';
import { define } from '../glossary';
import {
  DEFAULT_BATTING, DEFAULT_PITCHING, findStat, formatStat, loadColumns, plusColor, saveColumns,
  type StatGroup,
} from '../stats';
import { Th } from '../Th';

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
const POSITIONS: Array<[string, string]> = [
  ['2', 'C'], ['3', '1B'], ['4', '2B'], ['5', '3B'], ['6', 'SS'],
  ['7', 'LF'], ['8', 'CF'], ['9', 'RF'], ['10', 'DH'],
];
const ROLES: Array<[string, string]> = [['11', 'Starter'], ['12', 'Reliever'], ['13', 'Closer']];
const HANDS: Array<[string, string]> = [['1', 'Right'], ['2', 'Left']];
const PAGE = 100;

/** Everything narrowing the list, so it can be cleared and counted as a set. */
interface Filters {
  position: string;
  role: string;
  bats: string;
  throws: string;
  minAge: string;
  maxAge: string;
  minPt: string;
}
const NO_FILTERS: Filters = {
  position: '', role: '', bats: '', throws: '', minAge: '', maxAge: '', minPt: '',
};

export function Players({ orgs, orgId }: { orgs: Org[]; orgId: number }) {
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [level, setLevel] = useState('1');
  const [scope, setScope] = useState<'league' | 'org' | 'fa'>('league');
  const [group, setGroup] = useState<StatGroup>('batting');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [offset, setOffset] = useState(0);

  /*
   * Which column the table is ordered by, and which way.
   *
   * Held here and sent to the server rather than sorting what arrived: a
   * typical search matches a few hundred players and a hundred come back, so
   * sorting in the browser would order the page instead of the league and the
   * leader in a category could sit on page three.
   */
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null);
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
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    if (sort) {
      params.set('sort', sort.key);
      params.set('dir', sort.dir);
    }
    apiGet<PlayersResponse>(`/api/players?${params}`).then(setData).catch((e) => setError(e.message));
  }, [debounced, level, scope, group, offset, orgId, filters, sort]);

  /**
   * A header you can click to order by.
   *
   * First click takes the useful direction — highest first for a statistic,
   * A to Z for a name — because asking for the home-run column and being shown
   * the men with none of them is not what anybody meant. Clicking again turns
   * it around, and a third time returns the table to its own order.
   */
  function SortTh({ sortKey, children, tip }: {
    sortKey: string; children: ReactNode; tip?: string;
  }) {
    const active = sort?.key === sortKey;
    const textual = sortKey === 'name' || sortKey === 'team' || sortKey === 'pos';
    const cycle = () => {
      const first: 'asc' | 'desc' = textual ? 'asc' : 'desc';
      if (!active) return setSort({ key: sortKey, dir: first });
      if (sort!.dir === first) return setSort({ key: sortKey, dir: first === 'asc' ? 'desc' : 'asc' });
      return setSort(null);
    };
    /*
     * The hover explanation stays, and it is the same one Th renders.
     *
     * The first version of this replaced it with the browser's title
     * attribute, which meant every stat column silently lost the definition it
     * had — the sort arrived and the explanations left. Tip is a plain span
     * with a CSS hover, so it sits inside the button perfectly happily; the
     * glossary is consulted exactly as Th does it, so a column documented
     * there is documented here without being told twice.
     */
    const label = typeof children === 'string' ? children : null;
    const definition = tip ?? (label ? define(label) : undefined);
    const inner = (
      <>
        {definition ? <Tip label={children} tip={definition} /> : children}
        {active && <span className="sort-arrow">{sort!.dir === 'asc' ? '▲' : '▼'}</span>}
      </>
    );
    return (
      <th className={active ? 'sortable sorted' : 'sortable'}>
        <button type="button" onClick={() => { setOffset(0); cycle(); }}>{inner}</button>
      </th>
    );
  }

  // Changing what you are looking for should not leave you on page four of it
  const setFilter = (key: keyof Filters, value: string) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setOffset(0);
  };
  const active = Object.values(filters).filter(Boolean).length;

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
        {/* Position for a hitter, role for a pitcher — the same question of
            what job he does, asked the way each side of the game asks it */}
        <select
          value={group === 'pitching' ? filters.role : filters.position}
          onChange={(e) => setFilter(group === 'pitching' ? 'role' : 'position', e.target.value)}
        >
          <option value="">Any position</option>
          {(group === 'pitching' ? ROLES : POSITIONS).map(([v, label]) => (
            <option key={v} value={v}>{label}</option>
          ))}
        </select>
        <select value={filters.bats} onChange={(e) => setFilter('bats', e.target.value)}>
          <option value="">Bats any</option>
          {HANDS.map(([v, label]) => <option key={v} value={v}>Bats {label.toLowerCase()}</option>)}
        </select>
        <select value={filters.throws} onChange={(e) => setFilter('throws', e.target.value)}>
          <option value="">Throws any</option>
          {HANDS.map(([v, label]) => <option key={v} value={v}>Throws {label.toLowerCase()}</option>)}
        </select>
        <input
          className="filter-num" type="number" min={16} max={50} placeholder="Age from"
          value={filters.minAge} onChange={(e) => setFilter('minAge', e.target.value)}
        />
        <input
          className="filter-num" type="number" min={16} max={50} placeholder="to"
          value={filters.maxAge} onChange={(e) => setFilter('maxAge', e.target.value)}
        />
        {/* Without a floor the list is mostly men with four plate appearances */}
        <input
          className="filter-num filter-pt" type="number" min={0} step={10}
          placeholder={group === 'pitching' ? 'Min outs' : 'Min PA'}
          value={filters.minPt} onChange={(e) => setFilter('minPt', e.target.value)}
        />
        {active > 0 && (
          <button onClick={() => { setFilters(NO_FILTERS); setOffset(0); }}>
            Clear {active} filter{active === 1 ? '' : 's'}
          </button>
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
                <SortTh sortKey="name">Player</SortTh>
                <SortTh sortKey="age">Age</SortTh>
                <SortTh sortKey="pos">Pos</SortTh>
                <Th>B/T</Th>
                <SortTh sortKey="team">Team</SortTh>
                {columns.map((key) => {
                  const def = findStat(group, key);
                  return def ? (
                    <SortTh key={key} sortKey={key} tip={def.desc}>{def.label}</SortTh>
                  ) : null;
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
                <tr>
                  <td colSpan={5 + columns.length} className="muted">
                    No {group === 'batting' ? 'batters' : 'pitchers'} match those filters.
                    {debounced.trim().length >= 2 && (
                      <>
                        {' '}Batters and pitchers are searched separately — try the{' '}
                        <button className="link-button" onClick={() => { setGroup(group === 'batting' ? 'pitching' : 'batting'); setOffset(0); }}>
                          {group === 'batting' ? 'Pitchers' : 'Batters'}
                        </button>{' '}
                        tab.
                      </>
                    )}
                  </td>
                </tr>
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
