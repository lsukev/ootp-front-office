import { useEffect, useMemo, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink, Tip, TIP_CURPOT } from '../playerModal';
import { Th } from '../Th';
import { formatRating, formatRatingPair } from '../ratingScale';

interface DraftProspect {
  player_id: number; name: string; age: number; positionName: string; bats: string; throws: string;
  school: string; isPitcher: boolean; cur: number | null; pot: number | null; upside: number | null;
  speed: number | null; boardRank: number;
  recommendation: { label: string; reasons: string[] } | null;
}
interface DraftData {
  leagueName: string;
  hasDraft: boolean;
  poolVisible: boolean;
  gameDate: string | null;
  draftDate: string | null;
  poolDate: string | null;
  combineDate: string | null;
  rounds: number;
  total: number;
  /**
   * Eligible men this board deliberately left out. Shown only when it is not
   * empty: a reader whose universe runs its own high-school and college drafts
   * saw a board full of the wrong players and had no way to tell whether the
   * app had missed his class or ruled it out.
   */
  excluded?: { alreadyPicked: number; otherDraft: number; unrated: number };
  /**
   * 'flag' where OOTP marks the class itself, 'class' where the league runs its
   * own school competitions and eligibility has to be read from the year group.
   */
  poolRule?: 'flag' | 'class';
  needs: Array<{ position: number; positionName: string; bestValue: number | null }>;
  prospects: DraftProspect[];
}

/**
 * Says what the board left out, when it left anything out.
 *
 * Silent on a save where none of it applies, which is most of them. It exists
 * because "these are the wrong players" and "the app cannot see my players"
 * look identical from the outside, and a reader with high-school and college
 * leagues of his own hit exactly that.
 */
function leftOut(x: DraftData['excluded']): string {
  if (!x) return '';
  const parts: string[] = [];
  if (x.alreadyPicked > 0) parts.push(`${x.alreadyPicked} already drafted`);
  if (x.otherDraft > 0) parts.push(`${x.otherDraft} in another league's draft`);
  if (x.unrated > 0) parts.push(`${x.unrated} with no scouted ceiling`);
  return parts.length ? ` Not shown: ${parts.join(', ')}.` : '';
}

/** Builds a local Date from YYYY-MM-DD, which Date.parse would read as UTC. */
const asDate = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const pretty = (iso: string | null): string =>
  iso ? asDate(iso).toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' }) : '';
const monthDay = (iso: string | null): string =>
  iso ? asDate(iso).toLocaleDateString([], { month: 'long', day: 'numeric' }) : '';
const daysUntil = (from: string, to: string): number =>
  Math.round((asDate(to).getTime() - asDate(from).getTime()) / 86_400_000);

/** Position groups, so "infield" does not mean typing four filters. */
const GROUPS: Record<string, string[]> = {
  C: ['C'],
  IF: ['1B', '2B', '3B', 'SS'],
  OF: ['LF', 'CF', 'RF'],
  P: ['P'],
};

/** The table is long; rendering the whole class at once is not useful. */
const PAGE = 100;

function Calendar({ data }: { data: DraftData }) {
  const stops: Array<[string, string | null]> = [
    ['Class published', data.poolDate],
    ['Combine', data.combineDate],
    ['Draft day', data.draftDate],
  ];
  const known = stops.filter(([, d]) => d);
  if (known.length === 0) return null;
  return (
    <table className="mini">
      <tbody>
        {known.map(([label, d]) => (
          <tr key={label}>
            <td>{label}</td>
            <td className="num">{pretty(d)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Draft({ orgId }: { orgId: number }) {
  const [data, setData] = useState<DraftData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [group, setGroup] = useState<'all' | keyof typeof GROUPS>('all');
  const [school, setSchool] = useState<'all' | 'HS' | 'College'>('all');
  const [maxAge, setMaxAge] = useState(30);
  const [minPot, setMinPot] = useState(0);
  const [sortKey, setSortKey] = useState<string>('pot');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<DraftData>(`/api/draft/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  const setSort = (key: string) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      // Ratings read best high-first; name and age read best low-first
      setSortDir(key === 'name' || key === 'age' || key === 'boardRank' ? 1 : -1);
    }
    setLimit(PAGE);
  };
  const arrow = (key: string) => (key === sortKey ? (sortDir === 1 ? ' ▲' : ' ▼') : '');

  const filtered = useMemo(() => {
    /*
     * These run before the lines below that hand back "no draft" and "class not
     * published", so they see every answer the endpoint can give — including
     * the ones with no class in them at all.
     */
    if (!data?.prospects) return [];
    const needle = q.trim().toLowerCase();
    const rows = data.prospects.filter((p) => {
      if (needle && !p.name.toLowerCase().includes(needle)) return false;
      if (group !== 'all' && !GROUPS[group].includes(p.positionName)) return false;
      if (school !== 'all' && p.school !== school) return false;
      if (p.age > maxAge) return false;
      if ((p.pot ?? 0) < minPot) return false;
      return true;
    });
    const val = (p: DraftProspect): number | string => {
      switch (sortKey) {
        case 'name': return p.name;
        case 'age': return p.age;
        case 'pos': return p.positionName;
        case 'school': return p.school;
        case 'cur': return p.cur ?? 0;
        case 'upside': return p.upside ?? 0;
        case 'boardRank': return p.boardRank;
        default: return p.pot ?? 0;
      }
    };
    return [...rows].sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (typeof x === 'string' || typeof y === 'string') {
        return sortDir * String(x).localeCompare(String(y));
      }
      return sortDir * (x - y);
    });
  }, [data, q, group, school, maxAge, minPot, sortKey, sortDir]);

  /**
   * A short list to actually act on. Best available is the honest first answer;
   * the need-based picks are offered second and labelled as the weaker idea,
   * because a draft pick is years from helping the club he is drafted by.
   */
  const shortlist = useMemo(() => {
    if (!data?.prospects) return { best: [] as DraftProspect[], fits: [] as DraftProspect[] };
    const best = data.prospects.slice(0, 5);
    const thin = new Set((data.needs ?? []).slice(0, 3).map((h) => h.positionName));
    const chosen = new Set(best.map((p) => p.player_id));
    const fits = data.prospects
      .filter((p) => thin.has(p.positionName) && !chosen.has(p.player_id))
      .slice(0, 3);
    return { best, fits };
  }, [data]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the scouting reports…</p>;

  if (!data.hasDraft) {
    return (
      <div className="hint">
        <h3>No amateur draft</h3>
        <p>{data.leagueName} does not run one, so there is no class to scout.</p>
      </div>
    );
  }

  if (!data.poolVisible) {
    const before = !!(data.gameDate && data.poolDate && data.poolDate > data.gameDate);
    return (
      <div className="hint">
        <h3>The class has not been published yet</h3>
        <p>
          {before ? (
            <>
              {data.leagueName} publishes the draft class on <strong>{pretty(data.poolDate)}</strong>
              {data.gameDate && <> — {daysUntil(data.gameDate, data.poolDate!)} days from now</>}. The
              board fills in on its own that morning.
            </>
          ) : (
            <>
              This year&rsquo;s draft is behind you. The next class is published around{' '}
              <strong>{monthDay(data.poolDate) || 'the same date next season'}</strong>.
            </>
          )}
        </p>
        <p className="muted">
          Amateurs exist in your export before then, but OOTP keeps them off every screen until the
          class is announced — they are on no team, in no league, and in no draft pool. Ranking them
          early would be scouting information the game has not given you.
        </p>
        <Calendar data={data} />
      </div>
    );
  }

  const shown = filtered.slice(0, limit);

  return (
    <div>
      <section>
        <h2>Who to take</h2>
        <div className="two-col">
          <div>
            <strong className="muted">Best available</strong>
            <table className="mini">
              <tbody>
                {shortlist.best.map((p) => (
                  <tr key={p.player_id}>
                    <td className="num muted">{p.boardRank}</td>
                    <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                    <td>{p.positionName}</td>
                    <td className="num">{formatRatingPair(p.cur, p.pot)}</td>
                    <td className="muted">{p.recommendation?.label ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {shortlist.fits.length > 0 && (
            <div>
              <strong className="muted">
                Best at your thinnest spots ({(data.needs ?? []).slice(0, 3).map((h) => h.positionName).join(', ')})
              </strong>
              <table className="mini">
                <tbody>
                  {shortlist.fits.map((p) => (
                    <tr key={p.player_id}>
                      <td className="num muted">{p.boardRank}</td>
                      <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                      <td>{p.positionName}</td>
                      <td className="num">{formatRatingPair(p.cur, p.pot)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className="muted hint-line">
          Best available is the stronger idea. Drafting for a hole is the weaker one and is offered
          second on purpose: a pick taken today is years from the majors, and the position you are
          thin at now is rarely the one you will be short of when he arrives. Every number here is a
          scouted rating on an amateur your staff has barely seen — treat the ordering as rough.
        </p>
      </section>

      <div className="toolbar">
        <span className="muted">
          {data.total} draft-eligible players.
          {data.draftDate && data.gameDate && (
            <> Draft day is {pretty(data.draftDate)}, {daysUntil(data.gameDate, data.draftDate)} days out
              {data.rounds > 0 && <> — {data.rounds} rounds</>}.
            </>
          )}
          {leftOut(data.excluded)}
          {/* Said out loud because it is a judgement rather than a lookup, and
              the reader is the one who can tell us if it has the class wrong */}
          {data.poolRule === 'class' && (
            <> Your league runs its own school competitions, so the class is read
              from school year — seniors and college upperclassmen.</>
          )}
        </span>
      </div>

      <div className="draft-filters">
        <input
          className="trade-search"
          placeholder="Search by name…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setLimit(PAGE); }}
        />
        <select value={group} onChange={(e) => { setGroup(e.target.value as typeof group); setLimit(PAGE); }}>
          <option value="all">All positions</option>
          <option value="C">Catchers</option>
          <option value="IF">Infielders</option>
          <option value="OF">Outfielders</option>
          <option value="P">Pitchers</option>
        </select>
        <select value={school} onChange={(e) => { setSchool(e.target.value as typeof school); setLimit(PAGE); }}>
          <option value="all">HS and college</option>
          <option value="HS">High school</option>
          <option value="College">College</option>
        </select>
        <label className="muted">
          Age ≤{' '}
          <input
            type="number" min={16} max={30} value={maxAge}
            onChange={(e) => { setMaxAge(Number(e.target.value) || 30); setLimit(PAGE); }}
          />
        </label>
        <label className="muted">
          Ceiling ≥{' '}
          <input
            type="number" min={0} max={80} step={5} value={minPot}
            onChange={(e) => { setMinPot(Number(e.target.value) || 0); setLimit(PAGE); }}
          />
        </label>
        {(q || group !== 'all' || school !== 'all' || maxAge !== 30 || minPot !== 0) && (
          <button
            className="link-button"
            onClick={() => { setQ(''); setGroup('all'); setSchool('all'); setMaxAge(30); setMinPot(0); setLimit(PAGE); }}
          >
            Clear filters
          </button>
        )}
      </div>

      <p className="muted hint-line">
        {filtered.length === data.total
          ? `Showing ${shown.length} of ${data.total}.`
          : `${filtered.length} match — showing ${shown.length}.`}{' '}
        Click a column to sort.
      </p>

      <table>
        <thead>
          <tr>
            <th onClick={() => setSort('boardRank')}>Rk{arrow('boardRank')}</th>
            <th onClick={() => setSort('name')}>Player{arrow('name')}</th>
            <th onClick={() => setSort('age')}>Age{arrow('age')}</th>
            <th onClick={() => setSort('pos')}>Pos{arrow('pos')}</th>
            <Th>B/T</Th>
            <th onClick={() => setSort('school')}>From{arrow('school')}</th>
            <th className="num" onClick={() => setSort('cur')}>Cur{arrow('cur')}</th>
            <th className="num" onClick={() => setSort('pot')}>
              <Tip label="Pot" tip={TIP_CURPOT} />{arrow('pot')}
            </th>
            <th className="num" onClick={() => setSort('upside')}>
              <Tip
                label="Upside"
                tip="Ceiling minus current ability — how much of the projection has yet to happen. A big number is upside and risk in the same breath."
              />
              {arrow('upside')}
            </th>
            <Th>Read</Th>
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.player_id}>
              <td className="num muted">{p.boardRank}</td>
              <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
              <td>{p.age}</td>
              <td>{p.positionName}</td>
              <td>{p.bats}/{p.throws}</td>
              <td>{p.school}</td>
              <td className="num">{formatRating(p.cur)}</td>
              <td className="num">{formatRating(p.pot)}</td>
              <td className="num">{p.upside === null ? '' : `+${p.upside}`}</td>
              <td className="muted">{p.recommendation?.label ?? ''}</td>
            </tr>
          ))}
          {shown.length === 0 && (
            <tr><td colSpan={10} className="muted">Nothing matches those filters.</td></tr>
          )}
        </tbody>
      </table>

      {filtered.length > shown.length && (
        <p>
          <button onClick={() => setLimit((n) => n + PAGE)}>
            Show {Math.min(PAGE, filtered.length - shown.length)} more
          </button>
        </p>
      )}
    </div>
  );
}
