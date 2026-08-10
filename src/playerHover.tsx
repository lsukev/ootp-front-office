import { useEffect, useRef, useState, type ReactNode } from 'react';
import { getPlayer, type PlayerDossier } from './api';

/**
 * The card that appears when you rest on a player's name, the way OOTP shows a
 * summary on hover.
 *
 * Dossiers are cached for the life of the page: the same handful of names
 * recur all over a roster or a briefing, and re-fetching each time you brush
 * past one would put a request behind every mouse movement.
 */
const cache = new Map<number, PlayerDossier>();
const inFlight = new Map<number, Promise<PlayerDossier>>();

function load(id: number): Promise<PlayerDossier> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const running = inFlight.get(id);
  if (running) return running;
  const p = getPlayer(id)
    .then((d) => {
      cache.set(id, d);
      inFlight.delete(id);
      return d;
    })
    .catch((e: unknown) => {
      inFlight.delete(id);
      throw e;
    });
  inFlight.set(id, p);
  return p;
}

/** Long enough that sweeping the mouse across a table does not fire it. */
const OPEN_DELAY = 350;
const CARD_WIDTH = 290;

const fmt3 = (v: unknown): string =>
  typeof v === 'number' ? v.toFixed(3).replace(/^0\./, '.') : '—';

const LEVEL_ORDER = ['MLB', 'AAA', 'AA', 'A', 'R'];

/**
 * The current season's line.
 *
 * Career rows arrive newest-first, and a player can have several rows for one
 * year when he has moved between levels — so this takes the latest year and,
 * within it, the highest level he reached. Reading from the end of the list
 * instead showed Aaron Villa his A-ball season from a decade ago.
 *
 * The level is printed whenever it is not the majors. Rate stats are measured
 * against the level they were compiled at, so ".267/.356/.419, 104 OPS+" means
 * something very different at Triple-A than in the big leagues, and the card
 * sits inches from ratings that are on a major-league scale.
 */
function currentLine(d: PlayerDossier): string | null {
  const rows = (d.isPitcher ? d.pitchingYears : d.battingYears) ?? [];
  if (rows.length === 0) return null;
  const latestYear = rows[0]?.year;
  const best = rows
    .filter((r) => r.year === latestYear)
    .sort(
      (a, b) =>
        LEVEL_ORDER.indexOf(String(a.levelName ?? 'MLB')) -
        LEVEL_ORDER.indexOf(String(b.levelName ?? 'MLB'))
    )[0];
  if (!best) return null;

  const level = best.levelName && best.levelName !== 'MLB' ? `${best.levelName} · ` : '';
  if (d.isPitcher) {
    const ip = best.ip;
    const era = best.era;
    if (ip === undefined && era === undefined) return null;
    return `${level}${ip ?? '—'} IP · ${typeof era === 'number' ? era.toFixed(2) : '—'} ERA · ${best.k ?? '—'} K`;
  }
  if (best.pa === undefined) return null;
  return `${level}${best.pa} PA · ${fmt3(best.avg)}/${fmt3(best.obp)}/${fmt3(best.slg)} · ${best.hr ?? 0} HR`;
}

function Card({ id, anchor }: { id: number; anchor: DOMRect }) {
  const [data, setData] = useState<PlayerDossier | null>(cache.get(id) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load(id)
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Flip above or to the left rather than running off the window
  const spaceBelow = window.innerHeight - anchor.bottom;
  const above = spaceBelow < 240 && anchor.top > 240;
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - CARD_WIDTH - 8);
  const style: React.CSSProperties = above
    ? { left, bottom: window.innerHeight - anchor.top + 6 }
    : { left, top: anchor.bottom + 6 };

  if (failed) return null;

  return (
    <div className="phover" style={style} role="tooltip">
      {!data ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="phover-head">
            <strong>{data.name}</strong>
            <span className="muted">
              {data.uniform !== null ? `#${data.uniform} · ` : ''}
              {data.roleName ?? data.positionName} · {data.bats}/{data.throws} · {data.age}
            </span>
          </div>
          {data.team && <div className="muted phover-team">{data.team}</div>}

          <div className="phover-grid">
            {data.oaRating !== null && (
              <span>
                OA <b>{data.oaRating}</b>
                {data.potRating !== null && data.potRating !== data.oaRating && (
                  <>→{data.potRating}</>
                )}
              </span>
            )}
            {data.overallPct !== null && (
              <span>
                Value <b>{data.overallPct}</b>
              </span>
            )}
            {data.talentPct !== null && (
              <span>
                Talent <b>{data.talentPct}</b>
              </span>
            )}
            {data.contract && (
              <span>
                <b>${(data.contract.salaryNow / 1_000_000).toFixed(1)}M</b> thru {data.contract.endYear}
              </span>
            )}
          </div>

          {currentLine(data) && <div className="phover-line">{currentLine(data)}</div>}

          {data.currentInjury && (
            <div className="phover-injury">
              {data.currentInjury.status}
              {data.currentInjury.daysLeft ? ` · ~${data.currentInjury.daysLeft}d` : ''}
            </div>
          )}

          <div className="muted phover-hint">Click for the full card</div>
        </>
      )}
    </div>
  );
}

/**
 * Wraps anything that names a player. Hovering opens the card; the underlying
 * element keeps whatever click behaviour it already had.
 */
export function PlayerHover({ id, children }: { id: number; children: ReactNode }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const timer = useRef<number | null>(null);
  const ref = useRef<HTMLSpanElement>(null);

  const clear = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);

  const open = () => {
    clear();
    // Warm the cache immediately so the card is populated when it appears
    void load(id).catch(() => {});
    timer.current = window.setTimeout(() => {
      if (ref.current) setAnchor(ref.current.getBoundingClientRect());
    }, OPEN_DELAY);
  };
  const close = () => {
    clear();
    setAnchor(null);
  };

  return (
    <span
      ref={ref}
      className="phover-anchor"
      onMouseEnter={open}
      onMouseLeave={close}
      onFocus={open}
      onBlur={close}
      // A card that stayed open through a click would cover what you clicked to
      onMouseDown={close}
    >
      {children}
      {anchor && <Card id={id} anchor={anchor} />}
    </span>
  );
}
