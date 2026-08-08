import { useEffect, useState } from 'react';
import { apiGet } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { findStat, formatStat, plusColor as statPlusColor } from '../stats';
import { Th } from '../Th';

const TIP_STAMINA =
  "OOTP's stamina rating on the same 1-100 scale as the other ratings. It drives how deep a " +
  'starter can go before he tires, and whether a reliever can cover more than an inning.';
const TIP_FIP =
  findStat('pitching', 'fip')?.desc ??
  'Fielding Independent Pitching — ERA rebuilt from only strikeouts, walks, and home runs.';
const TIP_ERA_PLUS = findStat('pitching', 'eraPlus')?.desc ?? '';
const TIP_P3D =
  'Pitches thrown across the last three days — today, yesterday, and the day before. This is ' +
  'the number that decides whether an arm is really available tonight, regardless of how good ' +
  'his season line looks.';
const TIP_REST = 'Days since this pitcher last appeared in a game.';

const ERA_PLUS_DEF = findStat('pitching', 'eraPlus');

const plusColor = (value: number | null | undefined): string | undefined =>
  ERA_PLUS_DEF ? statPlusColor(ERA_PLUS_DEF, value) : undefined;

/**
 * Uses the shared formatter so a pitcher with a 0.00 ERA reads as an infinite
 * ERA+ here exactly as it does on the roster and player-search pages.
 */
const eraPlusText = (stats: Stats | null): string => {
  if (!ERA_PLUS_DEF || !stats) return '';
  return formatStat(ERA_PLUS_DEF, stats.eraPlus, stats as unknown as Record<string, number | null>);
};

interface Stats {
  era: number | null; eraPlus: number | null; fip: number | null; whip: number | null;
  ip: number | null; k9: number | null; kbb: number | null; sv: number | null; hld: number | null;
  g: number | null; gs: number | null; w: number | null; l: number | null; war: number | null;
}
interface Arm {
  player_id: number;
  name: string;
  age: number;
  throws: string;
  stamina: number | null;
  velocity: number | null;
  daysRest: number | null;
  lastOuting: { date: string; pitches: number; outs: number } | null;
  injury: { status: string; daysLeft: number | null } | null;
  stats: Stats | null;
}
interface Starter extends Arm {
  slot: number | null;
  projected: boolean;
  nextStartInDays: number | null;
}
interface Reliever extends Arm {
  isCloser: boolean;
  status: string;
  tone: 'ok' | 'warn' | 'bad';
  pitchesLast3: number;
  appearancesLast3: number;
}
interface PitchingData {
  today: number | null;
  rotation: Starter[];
  starterDepth: Starter[];
  bullpen: Reliever[];
  tired: number;
  injured: number;
}

const era = (v: number | null | undefined) => (v === null || v === undefined ? '' : v.toFixed(2));
const num = (v: number | null | undefined) => (v === null || v === undefined ? '' : String(v));

function InjuryTag({ injury }: { injury: Arm['injury'] }) {
  if (!injury) return null;
  return (
    <span className="injury-tag" title={injury.daysLeft ? `About ${injury.daysLeft} days remaining` : undefined}>
      {injury.status}
      {injury.daysLeft ? ` ~${injury.daysLeft}d` : ''}
    </span>
  );
}

export function Pitching({ teamId }: { teamId: number }) {
  const [data, setData] = useState<PitchingData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    apiGet<PitchingData>(`/api/pitching/${teamId}`).then(setData).catch((e) => setError(e.message));
  }, [teamId]);

  if (error) return <div className="banner error">{error}</div>;
  if (!data) return <p className="muted">Reading the staff…</p>;

  return (
    <div>
      <p className="muted hint-line">
        Rotation order comes from the save&rsquo;s own projected starters. Bullpen availability is
        computed from actual game-by-game pitch counts, so it reflects who can really throw tonight
        rather than who has the best season line.
      </p>

      <section>
        <h2>Rotation</h2>
        {data.rotation.length === 0 ? (
          <p className="muted">No projected rotation in this save.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th></th>
                <Th>Pitcher</Th>
                <Th>T</Th>
                <Th>Age</Th>
                <Th>W-L</Th>
                <Th>IP</Th>
                <Th>ERA</Th>
                <th><Tip label="ERA+" tip={TIP_ERA_PLUS} /></th>
                <th><Tip label="FIP" tip={TIP_FIP} /></th>
                <Th>WHIP</Th>
                <Th>K/9</Th>
                <th><Tip label="Stam" tip={TIP_STAMINA} /></th>
                <th><Tip label="Rest" tip={TIP_REST} /></th>
                <Th>Next start</Th>
              </tr>
            </thead>
            <tbody>
              {data.rotation.map((p) => (
                <tr key={p.player_id}>
                  <td className="slot-num">{p.slot}</td>
                  <td className="name">
                    <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
                    <InjuryTag injury={p.injury} />
                  </td>
                  <td>{p.throws}</td>
                  <td className="num">{p.age}</td>
                  <td className="num">{num(p.stats?.w)}-{num(p.stats?.l)}</td>
                  <td className="num">{num(p.stats?.ip)}</td>
                  <td className="num">{era(p.stats?.era)}</td>
                  <td className="num" style={{ color: plusColor(p.stats?.eraPlus) }}>{eraPlusText(p.stats)}</td>
                  <td className="num">{era(p.stats?.fip)}</td>
                  <td className="num">{era(p.stats?.whip)}</td>
                  <td className="num">{num(p.stats?.k9)}</td>
                  <td className="num">{num(p.stamina)}</td>
                  <td className="num">{p.daysRest === null ? '' : `${p.daysRest}d`}</td>
                  <td className="num">
                    {p.nextStartInDays === null
                      ? ''
                      : p.nextStartInDays === 0
                        ? 'today'
                        : `in ${p.nextStartInDays}d`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h2>
          Bullpen{' '}
          {data.tired > 0 && (
            <span className="muted subtle-count">
              — {data.tired} of {data.bullpen.length} limited or unavailable
            </span>
          )}
        </h2>
        <table>
          <thead>
            <tr>
              <Th>Pitcher</Th>
              <Th>T</Th>
              <Th>IP</Th>
              <Th>ERA</Th>
              <th><Tip label="ERA+" tip={TIP_ERA_PLUS} /></th>
              <th><Tip label="FIP" tip={TIP_FIP} /></th>
              <Th>SV</Th>
              <Th>HLD</Th>
              <th><Tip label="P/3d" tip={TIP_P3D} /></th>
              <Th>App</Th>
              <Th>Availability tonight</Th>
            </tr>
          </thead>
          <tbody>
            {data.bullpen.map((p) => (
              <tr key={p.player_id}>
                <td className="name">
                  {p.isCloser && <span className="role-tag">CL</span>}
                  <PlayerLink id={p.player_id}>{p.name}</PlayerLink>
                  <InjuryTag injury={p.injury} />
                </td>
                <td>{p.throws}</td>
                <td className="num">{num(p.stats?.ip)}</td>
                <td className="num">{era(p.stats?.era)}</td>
                <td className="num" style={{ color: plusColor(p.stats?.eraPlus) }}>{eraPlusText(p.stats)}</td>
                <td className="num">{era(p.stats?.fip)}</td>
                <td className="num">{num(p.stats?.sv)}</td>
                <td className="num">{num(p.stats?.hld)}</td>
                <td className="num">{p.pitchesLast3 || ''}</td>
                <td className="num">{p.appearancesLast3 || ''}</td>
                <td>
                  <span className={`avail avail-${p.tone}`}>{p.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {data.starterDepth.length > 0 && (
        <section>
          <h2>
            Starting depth{' '}
            <span className="muted subtle-count">— spot starters, long men, and arms on the IL</span>
          </h2>
          <table>
            <thead>
              <tr>
                <Th>Pitcher</Th><Th>T</Th><Th>Age</Th><Th>IP</Th><Th>ERA</Th>
                <th><Tip label="ERA+" tip={TIP_ERA_PLUS} /></th>
                <th><Tip label="Stam" tip={TIP_STAMINA} /></th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {data.starterDepth.map((p) => (
                <tr key={p.player_id}>
                  <td className="name"><PlayerLink id={p.player_id}>{p.name}</PlayerLink></td>
                  <td>{p.throws}</td>
                  <td className="num">{p.age}</td>
                  <td className="num">{num(p.stats?.ip)}</td>
                  <td className="num">{era(p.stats?.era)}</td>
                  <td className="num" style={{ color: plusColor(p.stats?.eraPlus) }}>{eraPlusText(p.stats)}</td>
                  <td className="num">{num(p.stamina)}</td>
                  <td>
                    {p.injury ? (
                      <span className="avail avail-bad">
                        {p.injury.status}
                        {p.injury.daysLeft ? ` · about ${p.injury.daysLeft} days left` : ''}
                      </span>
                    ) : (
                      <span className="avail avail-ok">Healthy</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
