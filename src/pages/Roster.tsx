import { useEffect, useMemo, useState } from 'react';
import { getRoster, getTeams, type RosterPlayer, type RosterResponse, type Team } from '../api';
import { PlayerLink } from '../playerModal';

const BATTER_RATINGS = ['contact', 'gap', 'power', 'eye', 'avoidK', 'speed'] as const;
const PITCHER_RATINGS = ['stuff', 'movement', 'control'] as const;

export function RosterPage({ orgId }: { orgId: number }) {
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [roster, setRoster] = useState<RosterResponse | null>(null);
  const [tab, setTab] = useState<'batting' | 'pitching'>('batting');
  const [error, setError] = useState<string | null>(null);

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
          <div className="tabs">
            <button className={tab === 'batting' ? 'active' : ''} onClick={() => setTab('batting')}>
              Batting
            </button>
            <button className={tab === 'pitching' ? 'active' : ''} onClick={() => setTab('pitching')}>
              Pitching
            </button>
          </div>
        )}
      </div>
      {teamId !== null && !roster && <p className="muted">Loading roster…</p>}
      {roster && <RosterTable roster={roster} tab={tab} />}
    </div>
  );
}

function RosterTable({ roster, tab }: { roster: RosterResponse; tab: 'batting' | 'pitching' }) {
  const [sortKey, setSortKey] = useState<string>('position');
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const isPitcherTab = tab === 'pitching';
  const players = useMemo(() => {
    const filtered = roster.players.filter((p) => (p.position === 1) === isPitcherTab);
    return [...filtered].sort((a, b) => sortDir * compareBy(a, b, sortKey));
  }, [roster, isPitcherTab, sortKey, sortDir]);

  const ratingCols = (isPitcherTab ? PITCHER_RATINGS : BATTER_RATINGS).filter((k) =>
    roster.ratingKeys.includes(k)
  );
  const statCols = isPitcherTab
    ? (['g', 'gs', 'w', 'l', 's', 'ip', 'era', 'whip', 'k', 'bb'] as const)
    : (['pa', 'ab', 'h', 'hr', 'rbi', 'sb', 'avg', 'obp', 'slg', 'ops'] as const);

  const setSort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(-1);
    }
  };

  return (
    <table>
      <thead>
        <tr>
          <th onClick={() => setSort('name')}>Player</th>
          <th onClick={() => setSort('age')}>Age</th>
          <th onClick={() => setSort('position')}>Pos</th>
          <th>B/T</th>
          {ratingCols.map((k) => (
            <th key={k} onClick={() => setSort(`r:${k}`)} title="Scout rating">
              {labelFor(k)}
            </th>
          ))}
          {statCols.map((k) => (
            <th key={k} onClick={() => setSort(`s:${k}`)}>
              {k.toUpperCase()}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {players.map((p) => (
          <tr key={p.player_id}>
            <td className="name">
              <PlayerLink id={p.player_id}>
                {p.first_name} {p.last_name}
              </PlayerLink>
            </td>
            <td>{p.age ?? ''}</td>
            <td>{p.positionName}</td>
            <td>
              {p.batsName}/{p.throwsName}
            </td>
            {ratingCols.map((k) => (
              <td key={k}>
                <RatingCell value={p.ratings[k]} max={roster.ratingMax} />
              </td>
            ))}
            {statCols.map((k) => (
              <td key={k} className="num">
                {formatStat(p, k, isPitcherTab)}
              </td>
            ))}
          </tr>
        ))}
        {players.length === 0 && (
          <tr>
            <td colSpan={4 + ratingCols.length + statCols.length} className="muted">
              No {isPitcherTab ? 'pitchers' : 'position players'} on this roster.
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

function ip(p: RosterPlayer): number {
  const s = p.pitching;
  if (!s) return 0;
  // OOTP stores innings as whole innings + fractional outs (ipf)
  if (s.outs !== undefined) return s.outs / 3;
  return (s.ip ?? 0) + (s.ipf ?? 0) / 3;
}

function formatStat(p: RosterPlayer, key: string, pitcher: boolean): string {
  if (pitcher) {
    const s = p.pitching;
    if (!s) return '';
    const innings = ip(p);
    switch (key) {
      case 'ip':
        return innings ? innings.toFixed(1) : '';
      case 'era':
        return innings ? (((s.er ?? 0) / innings) * 9).toFixed(2) : '';
      case 'whip':
        return innings ? (((s.bb ?? 0) + (s.ha ?? 0)) / innings).toFixed(2) : '';
      default:
        return s[key] !== undefined ? String(s[key]) : '';
    }
  }
  const s = p.batting;
  if (!s) return '';
  const ab = s.ab ?? 0;
  const h = s.h ?? 0;
  const singles = h - (s.d ?? 0) - (s.t ?? 0) - (s.hr ?? 0);
  const obpDen = ab + (s.bb ?? 0) + (s.hp ?? 0) + (s.sf ?? 0);
  const avg = ab ? h / ab : null;
  const obp = obpDen ? (h + (s.bb ?? 0) + (s.hp ?? 0)) / obpDen : null;
  const slg = ab ? (singles + 2 * (s.d ?? 0) + 3 * (s.t ?? 0) + 4 * (s.hr ?? 0)) / ab : null;
  switch (key) {
    case 'avg':
      return avg !== null ? fmt3(avg) : '';
    case 'obp':
      return obp !== null ? fmt3(obp) : '';
    case 'slg':
      return slg !== null ? fmt3(slg) : '';
    case 'ops':
      return obp !== null && slg !== null ? fmt3(obp + slg) : '';
    default:
      return s[key] !== undefined ? String(s[key]) : '';
  }
}

const fmt3 = (n: number) => n.toFixed(3).replace(/^0/, '');

function compareBy(a: RosterPlayer, b: RosterPlayer, key: string): number {
  const val = (p: RosterPlayer): string | number => {
    if (key === 'name') return `${p.last_name} ${p.first_name}`;
    if (key === 'age') return p.age ?? 0;
    if (key === 'position') return p.position ?? 99;
    if (key.startsWith('r:')) return p.ratings[key.slice(2)] ?? -1;
    if (key.startsWith('s:')) {
      const k = key.slice(2);
      const pitcher = p.position === 1;
      const raw = formatStat(p, k, pitcher);
      return raw === '' ? -Infinity : Number(raw) || 0;
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
