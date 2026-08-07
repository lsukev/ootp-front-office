import { useEffect, useState } from 'react';
import { apiGet } from '../api';

interface StaffMember {
  role: string; coach_id: number; name: string; age: number; experience: number;
  salary: number; yearsLeft: number; formerPlayer: boolean;
  ratings: Array<{ label: string; value: number }>;
}
interface FarmManager {
  team: string; levelName: string; name: string; age: number;
  ratings: Array<{ label: string; value: number }>;
}
interface StaffData { staff: StaffMember[]; farmManagers: FarmManager[] }

const money = (n: number) => (Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1000)}k`);

/** Coach ratings use OOTP's internal 1-200 scale. */
function CoachBar({ value }: { value: number }) {
  const pct = Math.min(100, (value / 200) * 100);
  return (
    <div className="rating wide">
      <div className="rating-bar" style={{ width: `${pct}%`, background: `hsl(${(pct / 100) * 120}, 65%, 45%)` }} />
      <span>{value}</span>
    </div>
  );
}

export function Staff({ orgId }: { orgId: number }) {
  const [data, setData] = useState<StaffData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    apiGet<StaffData>(`/api/staff/${orgId}`).then(setData).catch((e) => setError(e.message));
  }, [orgId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Checking the clubhouse offices…</p>;

  return (
    <div>
      <h2>Major League Staff</h2>
      <div className="staff-grid">
        {data.staff.map((s) => (
          <div key={s.coach_id} className="staff-card">
            <span className="story-category">{s.role}</span>
            <h3 className="staff-name">{s.name}</h3>
            <span className="muted">
              Age {s.age} · {s.experience} yrs exp{s.formerPlayer ? ' · former player' : ''}
              {s.salary ? ` · ${money(s.salary)}/yr, ${s.yearsLeft} yr${s.yearsLeft === 1 ? '' : 's'} left` : ''}
            </span>
            <div className="rating-rows">
              {s.ratings.map((r) => (
                <div key={r.label} className="rating-row">
                  <span className="rating-row-label">{r.label}</span>
                  <CoachBar value={r.value} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <h2>Farm System Managers</h2>
      <table>
        <thead>
          <tr><th>Team</th><th>Manager</th><th>Age</th><th>Teach Hitting</th><th>Teach Pitching</th><th>Handle Rookies</th></tr>
        </thead>
        <tbody>
          {data.farmManagers.map((m, i) => (
            <tr key={i}>
              <td><span className="level-tag">{m.levelName}</span> {m.team}</td>
              <td className="name">{m.name}</td>
              <td>{m.age}</td>
              {m.ratings.map((r) => (
                <td key={r.label}><CoachBar value={r.value} /></td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
