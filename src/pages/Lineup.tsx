import { useEffect, useState } from 'react';
import { apiGet, getLineup, type LineupResponse } from '../api';
import { PlayerLink, Tip } from '../playerModal';
import { findStat, plusColor as statPlusColor } from '../stats';
import { Th } from '../Th';

/** OOTP's own internal rating, which is what the ordering is actually built on. */
const TIP_OFF_VALUE =
  "OOTP's own offensive value for this batter against this hand of pitching, read straight from " +
  "the save (players_value.offensive_value_vsr / _vsl). It is a projection built from the hitter's " +
  'current ratings — contact, power, eye, gap — on an arbitrary scale where only the ranking ' +
  'matters, not the number itself. The batting order is sorted by it, and switching between ' +
  'vs RHP and vs LHP re-ranks everyone on their platoon split.\n\n' +
  'It is NOT this season\'s production. A veteran whose ratings have slipped can rank low while ' +
  'hitting well, and a highly rated young player can rank high during a slump — so read it ' +
  'alongside the OPS+ and wRC+ columns, which are what actually happened.';
const TIP_OPS_PLUS = findStat('batting', 'opsPlus')?.desc ?? '';
const TIP_WRC_PLUS = findStat('batting', 'wrcPlus')?.desc ?? '';

const plusColor = (value: number | null): string | undefined => {
  const def = findStat('batting', 'opsPlus');
  return def ? statPlusColor(def, value) : undefined;
};

interface NextGame {
  date: string;
  isHome: boolean;
  opponent: string;
  ourStarter: { player_id: number; name: string; throws: string } | null;
  theirStarter: { player_id: number; name: string; throws: string } | null;
}

export function Lineup({ teamId }: { teamId: number }) {
  const [vs, setVs] = useState<'r' | 'l'>('r');
  const [style, setStyle] = useState<'saber' | 'trad'>('saber');
  const [data, setData] = useState<LineupResponse | null>(null);
  const [next, setNext] = useState<NextGame | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    apiGet<NextGame | null>(`/api/next-game/${teamId}`)
      .then((g) => {
        setNext(g);
        // Default the platoon side to tonight's actual opposing starter
        if (g?.theirStarter?.throws === 'L') setVs('l');
      })
      .catch(() => {});
  }, [teamId]);

  useEffect(() => {
    setData(null);
    setError(null);
    getLineup(teamId, vs, style).then(setData).catch((e) => setError(e.message));
  }, [teamId, vs, style]);

  return (
    <div>
      {next && (
        <div className="next-game-banner">
          <span className="story-category">Tonight · {next.date}</span>
          <span>
            {next.isHome ? 'vs' : '@'} <strong>{next.opponent}</strong>
            {next.theirStarter && (
              <>
                {' — their probable: '}
                <PlayerLink id={next.theirStarter.player_id}>{next.theirStarter.name}</PlayerLink>{' '}
                ({next.theirStarter.throws}HP)
              </>
            )}
            {next.ourStarter && (
              <>
                {' · ours: '}
                <PlayerLink id={next.ourStarter.player_id}>{next.ourStarter.name}</PlayerLink>
              </>
            )}
          </span>
          {next.theirStarter && vs !== (next.theirStarter.throws === 'L' ? 'l' : 'r') && (
            <button onClick={() => setVs(next.theirStarter!.throws === 'L' ? 'l' : 'r')}>
              Build vs {next.theirStarter.name}
            </button>
          )}
        </div>
      )}
      <div className="toolbar">
        <div className="tabs">
          <button className={style === 'saber' ? 'active' : ''} onClick={() => setStyle('saber')}>
            Sabermetric
          </button>
          <button className={style === 'trad' ? 'active' : ''} onClick={() => setStyle('trad')}>
            Traditional
          </button>
        </div>
        <div className="tabs">
          <button className={vs === 'r' ? 'active' : ''} onClick={() => setVs('r')}>
            vs RHP
          </button>
          <button className={vs === 'l' ? 'active' : ''} onClick={() => setVs('l')}>
            vs LHP
          </button>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {!data && !error && <p className="muted">Building lineup…</p>}
      {data && (
        <>
          <p className="muted hint-line">
            {style === 'saber'
              ? 'Ordering per The Book (Tango et al.): your three best hitters bat 1, 2, and 4 — not 3-4-5.'
              : 'Classic ordering: speed leads off, bat control 2nd, best hitter 3rd, power cleanup.'}{' '}
            Platoon-aware: ranked by each player's offensive value {vs === 'r' ? 'vs right-handed' : 'vs left-handed'}{' '}
            pitching.
          </p>
          <table>
            <thead>
              <tr>
                <th></th>
                <Th>Player</Th>
                <Th>Pos</Th>
                <Th>B</Th>
                <th>
                  <Tip label="Off Value" tip={TIP_OFF_VALUE} />
                </th>
                <Th>PA</Th>
                <Th>OPS</Th>
                <th><Tip label="OPS+" tip={TIP_OPS_PLUS} /></th>
                <th><Tip label="wRC+" tip={TIP_WRC_PLUS} /></th>
                <Th>WAR</Th>
                <Th>Why here</Th>
              </tr>
            </thead>
            <tbody>
              {data.lineup.map((l) => (
                <tr key={l.slot}>
                  <td className="slot-num">{l.slot}</td>
                  <td className="name"><PlayerLink id={l.player_id}>{l.name}</PlayerLink></td>
                  <td>{l.positionName}</td>
                  <td>{l.bats}</td>
                  <td className="num">{Math.round(l.off)}</td>
                  <td className="num">{l.pa ?? ''}</td>
                  <td className="num">{l.ops !== null ? l.ops.toFixed(3).replace(/^0\./, '.') : ''}</td>
                  <td className="num" style={{ color: plusColor(l.opsPlus) }}>{l.opsPlus ?? ''}</td>
                  <td className="num" style={{ color: plusColor(l.wrcPlus) }}>{l.wrcPlus ?? ''}</td>
                  <td className="num">{l.war !== null ? l.war.toFixed(1) : ''}</td>
                  <td className="reasons">{l.why}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.bench.length > 0 && (
            <p className="muted">
              Bench: {data.bench.map((b) => `${b.name} (${b.positionName})`).join(', ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
