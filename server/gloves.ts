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
 * Only what OOTP has already shown you. A current rating above zero is the
 * game's own flag for a position it has revealed: it prints the number there
 * and a dash everywhere else, and the app must not print what the dash is
 * hiding.
 *
 * Checked against the game rather than assumed. Trent Grisham's card in OOTP
 * shows 60 in center field and a dash at all eight others; his row here holds
 * a 75 ceiling in left, a 65 in right and a 70 as a pitcher, none of it
 * revealed. Right field is the one that settles the rule — two hundred
 * experience there and OOTP still prints a dash — so having played a position
 * does not expose it either. The current rating is the only signal that does.
 *
 * The cost of the alternative is worth stating: showing a ceiling the game has
 * withheld would hand you a scouting report you have not earned, in an app
 * whose whole purpose is to read your save rather than to play it for you.
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
  const positions: PositionRating[] = [];
  for (let position = 1; position <= 9; position++) {
    const current = num(row, `fielding_rating_pos${position}`);
    const potential = num(row, `fielding_rating_pos${position}_pot`);
    const experience = num(row, `fielding_experience${position - 1}`);
    // The dash in OOTP. Everything behind it stays behind it
    if (current <= 0) continue;
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
