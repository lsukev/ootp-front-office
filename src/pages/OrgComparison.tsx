import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { TeamLogo } from '../TeamLogo';
import { Th } from '../Th';
import { Tip } from '../playerModal';

interface Club {
  team_id: number;
  team: string;
  isOrg: boolean;
  mlbTalent: number;
  farmTalent: number;
  farmCount: number;
  topProspect: number;
  youngTalent: number;
  w: number | null;
  l: number | null;
  mlbRank: number | null;
  farmRank: number | null;
  youngRank: number | null;
}

type SortKey = 'farmRank' | 'mlbRank' | 'youngRank' | 'topProspect' | 'w';

const TIP_FARM =
  'Every player in the organization below the majors, added up by scouted ceiling. It answers ' +
  '"how much future is in the system" rather than how good it is today — a deep system of solid ' +
  'prospects can out-total a thin one holding two stars.';
const TIP_MLB =
  "The major-league roster added up by OOTP's current value. This is present strength, which is " +
  'why a club can rank first here and last in the farm.';
const TIP_YOUNG =
  'Ceiling held by players aged 21 and under. The same talent is worth more the younger it is, ' +
  'and this separates a system built on teenagers from one built on 25-year-old Triple-A depth.';

export function OrgComparison({ orgId }: { orgId: number }) {
  const [clubs, setClubs] = useState<Club[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>('farmRank');

  useEffect(() => {
    setClubs(null);
    setError(null);
    apiGet<{ clubs: Club[] }>(`/api/org-comparison/${orgId}`)
      .then((d) => setClubs(d.clubs))
      .catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!clubs) return <p className="muted">Sizing up the league…</p>;

  const sorted = [...clubs].sort((a, b) => {
    if (sort === 'topProspect') return b.topProspect - a.topProspect;
    if (sort === 'w') return (b.w ?? 0) - (a.w ?? 0);
    return (a[sort] ?? 99) - (b[sort] ?? 99);
  });
  const me = clubs.find((c) => c.isOrg) ?? null;
  const peak = Math.max(...clubs.map((c) => c.farmTalent), 1);

  return (
    <div>
      {me && (
        <div className="finance-grid">
          <div className="finance-card">
            <span className="muted">Your farm system</span>
            <strong>#{me.farmRank}</strong>
            <span className="muted">of {clubs.length}</span>
          </div>
          <div className="finance-card">
            <span className="muted">Your major-league talent</span>
            <strong>#{me.mlbRank}</strong>
            <span className="muted">of {clubs.length}</span>
          </div>
          <div className="finance-card">
            <span className="muted">Talent aged 21 and under</span>
            <strong>#{me.youngRank}</strong>
            <span className="muted">of {clubs.length}</span>
          </div>
          <div className="finance-card">
            <span className="muted">Players in the system</span>
            <strong>{me.farmCount}</strong>
          </div>
        </div>
      )}

      <p className="muted hint-line">
        Everything here is OOTP&rsquo;s own valuation of your players, added up — useful for placing
        your organization against the rest of the league, but it is a sum of scouting opinions, not
        a measurement of results. Click a column to re-rank.
      </p>

      <table>
        <thead>
          <tr>
            <Th>#</Th>
            <Th>Club</Th>
            <th className="num" onClick={() => setSort('w')}>Record</th>
            <th className="num" onClick={() => setSort('mlbRank')}>
              <Tip label="MLB talent" tip={TIP_MLB} />
            </th>
            <th className="num" onClick={() => setSort('farmRank')}>
              <Tip label="Farm system" tip={TIP_FARM} />
            </th>
            <th className="num" onClick={() => setSort('youngRank')}>
              <Tip label="Under 22" tip={TIP_YOUNG} />
            </th>
            <th className="num" onClick={() => setSort('topProspect')}>Best prospect</th>
            <Th className="num">In system</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((c, i) => (
            <tr key={c.team_id} className={c.isOrg ? 'row-us' : ''}>
              <td className="num muted">{i + 1}</td>
              <td className="standings-team">
                <TeamLogo teamId={c.team_id} size={40} className="logo-sm" />
                {c.team}
              </td>
              <td className="num muted">{c.w !== null ? `${c.w}-${c.l}` : ''}</td>
              <td className="num">#{c.mlbRank}</td>
              <td className="num">
                {/* The bar makes the gap between systems legible; the rank alone hides it */}
                <div className="farm-bar-wrap" title={c.farmTalent.toLocaleString()}>
                  <div className="farm-bar" style={{ width: `${(c.farmTalent / peak) * 100}%` }} />
                  <span>#{c.farmRank}</span>
                </div>
              </td>
              <td className="num">#{c.youngRank}</td>
              <td className="num muted">{c.topProspect.toLocaleString()}</td>
              <td className="num muted">{c.farmCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
