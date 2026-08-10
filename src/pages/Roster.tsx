import { useEffect, useMemo, useState } from 'react';
import { getRoster, getTeams, type RosterPlayer, type RosterResponse, type Team } from '../api';
import { PlayerLink, Tip, TIP_OA } from '../playerModal';
import { ColumnPicker } from '../ColumnPicker';
import {
  DEFAULT_BATTING, DEFAULT_PITCHING, findStat, formatStat, isContactStat, isFieldingStat, loadColumns,
  plusColor, saveColumns, type StatGroup,
} from '../stats';
import { Th } from '../Th';

const BATTER_RATINGS = ['contact', 'gap', 'power', 'eye', 'avoidK', 'speed'] as const;
const PITCHER_RATINGS = ['stuff', 'movement', 'control'] as const;

export function RosterPage({ orgId }: { orgId: number }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [tab, setTab] = useState<StatGroup>('batting');
  const [error, setError] = useState<string | null>(null);

  const [battingCols, setBattingCols] = useState<string[]>(() => loadColumns('batting'));
  const [pitchingCols, setPitchingCols] = useState<string[]>(() => loadColumns('pitching'));
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    getTeams().then(setTeams).catch((e) => setError(e.message));
  }, []);

  // Scope to the selected organization: the MLB club plus its affiliates
  const orgTeams = useMemo(
    () =>
      teams
        .filter((t) => t.team_id === orgId || t.parent_team_id === orgId)
        .sort((a, b) => (a.level ?? 99) - (b.level ?? 99)),
    [teams, orgId]
  );

  useEffect(() => {
    setTeamId(orgId);
  }, [orgId]);

  useEffect(() => {
    if (teamId === null) return;
    setRoster(null);
    getRoster(teamId).then(setRoster).catch((e) => setError(e.message));
  }, [teamId]);

  const columns = tab === 'batting' ? battingCols : pitchingCols;
  const setColumns = (keys: string[]) => {
    if (tab === 'batting') setBattingCols(keys);
    else setPitchingCols(keys);
    saveColumns(tab, keys);
  };

  return (
    <div>
      {error && <div className="banner error">{error}</div>}
      <div className="toolbar">
        <select value={teamId ?? ''} onChange={(e) => setTeamId(e.target.value ? Number(e.target.value) : null)}>
          {orgTeams.map((t) => (
            <option key={t.team_id} value={t.team_id}>
              {teamLabel(t)}
            </option>
          ))}
        </select>
        {roster && (
          <>
            <div className="tabs">
              <button className={tab === 'batting' ? 'active' : ''} onClick={() => setTab('batting')}>
                Batting
              </button>
              <button className={tab === 'pitching' ? 'active' : ''} onClick={() => setTab('pitching')}>
                Pitching
              </button>
            </div>
            <div className="col-picker-wrap">
              <button onClick={() => setPickerOpen((v) => !v)}>⚙ Columns</button>
              {pickerOpen && (
                <ColumnPicker
                  group={tab}
                  selected={columns}
                  onChange={setColumns}
                  onClose={() => setPickerOpen(false)}
                  onReset={() => setColumns(tab === 'batting' ? DEFAULT_BATTING : DEFAULT_PITCHING)}
                />
              )}
            </div>
          </>
        )}
      </div>
      {teamId !== null && !roster && <p className="muted">Loading roster…</p>}
      {roster && <RosterTable roster={roster} group={tab} columns={columns} />}
    </div>
  );
}

function RosterTable({
  roster, group, columns,
}: { roster: RosterResponse; group: StatGroup; columns: string[] }) {
  const [sortKey, setSortKey] = useState<string>('position');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const isPitching = group === 'pitching';
  const players = useMemo(() => {
    const filtered = roster.players.filter((p) => (p.position === 1) === isPitching);
    return [...filtered].sort((a, b) => sortDir * compareBy(a, b, sortKey, group));
  }, [roster, isPitching, sortKey, sortDir, group]);

  const ratingCols = (isPitching ? PITCHER_RATINGS : BATTER_RATINGS).filter((k) =>
    roster.ratingKeys.includes(k)
  );

  const setSort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };
  const arrow = (key: string) => (key === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '');

  return (
    <table>
      <thead>
        <tr>
          <th onClick={() => setSort('name')}>Player{arrow('name')}</th>
          <th onClick={() => setSort('age')}>Age{arrow('age')}</th>
          <th onClick={() => setSort('position')}>Pos{arrow('position')}</th>
          <Th>B/T</Th>
          <th onClick={() => setSort('oa')}>
            <Tip label={`OA→POT${arrow('oa')}`} tip={TIP_OA} />
          </th>
          {ratingCols.map((k) => (
            <th key={k} onClick={() => setSort(`r:${k}`)} title="Scout rating">
              {labelFor(k)}{arrow(`r:${k}`)}
            </th>
          ))}
          {columns.map((key) => {
            const def = findStat(group, key);
            if (!def) return null;
            return (
              <th key={key} onClick={() => setSort(`s:${key}`)}>
                <Tip label={`${def.label}${arrow(`s:${key}`)}`} tip={def.desc} />
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {players.map((p) => {
          const stats = isPitching ? p.pitching : p.batting;
          return (
            <tr key={p.player_id}>
              <td className="name">
                <PlayerLink id={p.player_id}>
                  {p.first_name} {p.last_name}
                </PlayerLink>
                {/* Anything other than plain availability is worth seeing on the
                    row: a designated man is still on OOTP's roster list. */}
                {p.standing && p.standing.label !== 'Active' && (
                  <span
                    className={`roster-standing ${p.standing.available ? '' : 'out'}`}
                    title={
                      p.standing.daysLeft
                        ? `${p.standing.label} — ${p.standing.daysLeft} days left`
                        : p.standing.label
                    }
                  >
                    {p.standing.label}
                    {p.standing.daysLeft ? ` ${p.standing.daysLeft}d` : ''}
                  </span>
                )}
              </td>
              <td>{p.age ?? ''}</td>
              <td>{p.positionName}</td>
              <td>
                {p.batsName}/{p.throwsName}
              </td>
              <td className="num muted">
                {p.oaRating !== null
                  ? `${p.oaRating}${p.potRating !== null && p.potRating !== p.oaRating ? `→${p.potRating}` : ''}`
                  : ''}
              </td>
              {ratingCols.map((k) => (
                <td key={k}>
                  <RatingCell value={p.ratings[k]} max={roster.ratingMax} />
                </td>
              ))}
              {columns.map((key) => {
                const def = findStat(group, key);
                if (!def) return null;
                const value =
                  (isFieldingStat(key)
                    ? p.fielding?.[key]
                    : isContactStat(key)
                      ? p.contact?.[key]
                      : stats?.[key]) ?? null;
                return (
                  <td key={key} className="num" style={{ color: plusColor(def, value) }}>
                    {isContactStat(key) || stats ? formatStat(def, value, stats ?? {}) : ''}
                  </td>
                );
              })}
            </tr>
          );
        })}
        {players.length === 0 && (
          <tr>
            <td colSpan={4 + ratingCols.length + columns.length} className="muted">
              No {isPitching ? 'pitchers' : 'position players'} on this roster.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

function RatingCell({ value, max }: { value: number | undefined; max: number }) {
  if (value === undefined || max === 0) return <span className="muted">—</span>;
  const pct = Math.min(100, (value / max) * 100);
  const hue = (pct / 100) * 120; // red → green
  return (
    <div className="rating">
      <div className="rating-bar" style={{ width: `${pct}%`, background: `hsl(${hue}, 70%, 45%)` }} />
      <span>{value}</span>
    </div>
  );
}

function compareBy(a: RosterPlayer, b: RosterPlayer, key: string, group: StatGroup): number {
  const val = (p: RosterPlayer): string | number => {
    if (key === 'name') return `${p.last_name} ${p.first_name}`;
    if (key === 'age') return p.age ?? 0;
    if (key === 'position') return p.position ?? 99;
    // Ties on the coarse grade are broken by ceiling, so a 60 with room to grow
    // sorts above a finished 60
    if (key === 'oa') return (p.oaRating ?? -1) * 100 + (p.potRating ?? 0);
    if (key.startsWith('r:')) return p.ratings[key.slice(2)] ?? -1;
    if (key.startsWith('s:')) {
      const statKey = key.slice(2);
      const stats = isFieldingStat(statKey)
        ? p.fielding
        : isContactStat(statKey)
          ? p.contact
          : group === 'pitching'
            ? p.pitching
            : p.batting;
      const v = stats?.[statKey];
      // Missing stats sort last regardless of direction
      return v === null || v === undefined ? -Infinity : v;
    }
    return 0;
  };
  const av = val(a);
  const bv = val(b);
  if (typeof av === 'string' || typeof bv === 'string') return String(av).localeCompare(String(bv));
  return av - bv;
}

function labelFor(key: string): string {
  const labels: Record<string, string> = {
    contact: 'Con', gap: 'Gap', power: 'Pow', eye: 'Eye', avoidK: 'AvK', speed: 'Spd',
    stuff: 'Stu', movement: 'Mov', control: 'Ctl',
  };
  return labels[key] ?? key;
}

function teamLabel(t: Team): string {
  return t.nickname && t.name !== t.nickname ? `${t.name} ${t.nickname}` : t.name;
}
