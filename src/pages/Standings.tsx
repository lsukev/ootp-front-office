import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { TeamLogo } from '../TeamLogo';
import { Tip } from '../playerModal';
import { Th } from '../Th';

interface StandingsTeam {
  team_id: number;
  team: string;
  abbr: string | null;
  w: number;
  l: number;
  pct: number;
  gb: number;
  g: number;
  streak: string;
  magicNumber: number | null;
  rs: number | null;
  ra: number | null;
  diff: number | null;
  isOrg: boolean;
}
interface StandingsData {
  scheduledGames?: number | null;
  subLeagues: Array<{ name: string; divisions: Array<{ name: string; teams: StandingsTeam[] }> }>;
}

const pct = (n: number) => n.toFixed(3).replace(/^0\./, '.');

export function Standings({ orgId }: { orgId: number }) {
  const [data, setData] = useState<StandingsData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<StandingsData>(`/api/standings/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Loading standings…</p>;

  return (
    <div>
      <p className="muted hint-line">
        Full league standings. Run differential is runs scored minus runs allowed — over a season it
        predicts future record better than the record itself does.
      </p>
      {data.subLeagues.map((sl) => (
        <section key={sl.name}>
          <h2>{sl.name}</h2>
          <div className="standings-grid">
            {sl.divisions.map((div) => (
              <div key={div.name} className="standings-card">
                <h3>{div.name}</h3>
                <table className="mini">
                  <thead>
                    <tr>
                      <Th>Team</Th><Th>W</Th><Th>L</Th><Th>PCT</Th><Th>GB</Th>
                      <Th>RS</Th><Th>RA</Th><Th>DIFF</Th><Th>STRK</Th>
                      <th>
                        <Tip
                          label="Pace"
                          tip="The record this club is on course for if it keeps playing at its current rate over the full schedule. It is arithmetic, not a projection — it takes no account of who is left to play, injuries, or trades."
                        />
                      </th>
                      <th>
                        <Tip
                          label="Magic"
                          tip="Magic number: wins by this club plus losses by the closest chaser that would clinch the division. Shown only for a club that is leading; OOTP reports it for the leader alone."
                        />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {div.teams.map((t) => (
                      <tr key={t.team_id} className={t.isOrg ? 'row-us' : ''}>
                        <td className="standings-team">
                          <TeamLogo teamId={t.team_id} size={40} className="logo-sm" />
                          {t.team}
                        </td>
                        <td className="num">{t.w}</td>
                        <td className="num">{t.l}</td>
                        <td className="num">{pct(t.pct)}</td>
                        <td className="num">{t.gb > 0 ? t.gb : '—'}</td>
                        <td className="num">{t.rs ?? ''}</td>
                        <td className="num">{t.ra ?? ''}</td>
                        <td className={`num ${(t.diff ?? 0) > 0 ? 'good-text' : (t.diff ?? 0) < 0 ? 'bad-text' : ''}`}>
                          {t.diff === null ? '' : t.diff > 0 ? `+${t.diff}` : t.diff}
                        </td>
                        <td className="num">{t.streak}</td>
                        <td className="num muted">
                          {data.scheduledGames && t.g > 0
                            ? `${Math.round(t.pct * data.scheduledGames)}-${
                                data.scheduledGames - Math.round(t.pct * data.scheduledGames)
                              }`
                            : ''}
                        </td>
                        <td className="num">{t.magicNumber ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
