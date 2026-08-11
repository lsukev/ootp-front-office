import { db, tableExists } from './db.js';

/**
 * What a man can actually play, and how well.
 *
 * OOTP rates every player at all nine positions, now and projected, and keeps
 * the components underneath — range, arm, hands, the double play, and the
 * three that only matter behind the plate. None of it was reaching the app.
 * The trade desk was judging deals on bats alone and said so when pressed:
 * asked whether a second baseman could be moved to shortstop, it answered that
 * it had no fielding ratings in front of it and would not guess. It was right
 * not to guess, and wrong to have been asked without them.
 *
 * Every field position is reported, including ones he has never played. That
 * is deliberate: a ceiling somewhere he has never stood is the whole basis for
 * asking whether he could be moved there, and hiding it would answer the
 * question by omission.
 *
 * The one exclusion is the pitcher's slot for a position player, which is not
 * a projection at all. Across this league 8,589 non-pitchers carry exactly 80
 * potential as a pitcher — a flat default sitting where a rating should be,
 * against a proper spread at the eight field positions. Reporting it would
 * have the app telling you your shortstop is a future ace.
 *
 * A current rating of zero means no established grade there, not incapacity,
 * so it is shown as unrated beside its ceiling rather than as a zero.
 */

export const POSITION_CODES = ['P', 'C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'] as const;

export interface PositionRating {
  /** OOTP's position number, 1-9. */
  position: number;
  code: string;
  /** 20-80 scouting scale. Zero means no established rating there. */
  current: number;
  potential: number;
  /** OOTP's experience counter at the position; 0 means he has never played it. */
  experience: number;
  /** True for the position he is listed at. */
  isPrimary: boolean;
}

export interface Gloves {
  listed: string;
  positions: PositionRating[];
  /** Only the group that applies to him — nobody needs a shortstop's framing. */
  components: Record<string, number>;
}

const INFIELD = {
  range: 'fielding_ratings_infield_range',
  arm: 'fielding_ratings_infield_arm',
  turnDoublePlay: 'fielding_ratings_turn_doubleplay',
  errors: 'fielding_ratings_infield_error',
};
const OUTFIELD = {
  range: 'fielding_ratings_outfield_range',
  arm: 'fielding_ratings_outfield_arm',
  errors: 'fielding_ratings_outfield_error',
};
const CATCHER = {
  arm: 'fielding_ratings_catcher_arm',
  ability: 'fielding_ratings_catcher_ability',
  framing: 'fielding_ratings_catcher_framing',
};

const num = (row: Record<string, unknown>, key: string): number => Number(row[key] ?? 0);

function componentsFor(row: Record<string, unknown>, positions: PositionRating[]): Record<string, number> {
  /*
   * Judged on the positions he is actually rated at, not every one that ever
   * appears for him. A relief pitcher with a stray game behind the plate in
   * his history was being reported with his catcher framing — a floor value of
   * 20 that says nothing about anybody and reads as though it does.
   */
  const real = positions.filter((p) => p.current > 0 || p.isPrimary);
  const plays = (from: number, to: number): boolean =>
    real.some((p) => p.position >= from && p.position <= to);
  const out: Record<string, number> = {};
  const take = (prefix: string, map: Record<string, string>): void => {
    for (const [name, column] of Object.entries(map)) {
      const value = num(row, column);
      if (value > 0) out[`${prefix}${name[0].toUpperCase()}${name.slice(1)}`] = value;
    }
  };
  // 2 is catcher, 3-6 the infield, 7-9 the outfield
  if (plays(2, 2)) take('catcher', CATCHER);
  if (plays(3, 6)) take('infield', INFIELD);
  if (plays(7, 9)) take('outfield', OUTFIELD);
  return out;
}

/**
 * One player's defensive profile, or null when the save carries no fielding
 * data for him — which is normal for an amateur who has never taken the field.
 */
export function gloves(playerId: number): Gloves | null {
  if (!tableExists('players_fielding')) return null;
  const row = db.prepare(`SELECT * FROM players_fielding WHERE player_id = ?`).get(playerId) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const listedPosition = Number(row.position ?? 0);
  const isPitcher = listedPosition === 1;
  const positions: PositionRating[] = [];
  for (let position = 1; position <= 9; position++) {
    const current = num(row, `fielding_rating_pos${position}`);
    const potential = num(row, `fielding_rating_pos${position}_pot`);
    const experience = num(row, `fielding_experience${position - 1}`);
    // The flat 80 a position player carries at pitcher is a default, not a read
    if (position === 1 && !isPitcher) continue;
    // Nothing at all recorded: no grade, no ceiling, never played it
    if (current <= 0 && potential <= 0 && experience <= 0 && position !== listedPosition) continue;
    positions.push({
      position,
      code: POSITION_CODES[position - 1],
      current,
      potential,
      experience,
      isPrimary: position === listedPosition,
    });
  }
  // His own position first, then the rest by how well he plays them
  positions.sort((a, b) =>
    a.isPrimary === b.isPrimary ? b.current - a.current || b.potential - a.potential : a.isPrimary ? -1 : 1
  );

  return {
    listed: POSITION_CODES[listedPosition - 1] ?? '—',
    positions,
    components: componentsFor(row, positions),
  };
}

/**
 * The same profile written as one line, for a prompt rather than a page.
 *
 * "60 at 2B, 35 at SS (ceiling 55)" is the answer to the question that
 * prompted all of this, and it is short enough to carry for every man in a
 * trade without crowding out the bats.
 */
export function glovesLine(playerId: number): string | null {
  const g = gloves(playerId);
  if (!g || g.positions.length === 0) return null;
  const parts = g.positions
    .filter((p) => p.current > 0 || p.potential > 0)
    // Where he could be tried matters as much as where he plays, so the list
    // runs long enough to carry the alternatives rather than only the job
    .slice(0, 6)
    .map((p) => {
      const ceiling = p.potential > p.current ? ` (ceiling ${p.potential})` : '';
      const rated = p.current > 0 ? `${p.current}` : 'unrated';
      return `${rated} at ${p.code}${ceiling}`;
    });
  if (parts.length === 0) return null;
  const components = Object.entries(g.components)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase().trim()} ${v}`)
    .join(', ');
  return parts.join(', ') + (components ? ` — ${components}` : '');
}
