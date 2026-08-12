import { db, tableExists } from './db.js';

/**
 * Where the club actually stands for a playoff place.
 *
 * The dashboard showed games back in the division and nothing else, which
 * answers the wrong question for most of the league most of the time: eleven
 * of fifteen clubs in a division are not going to win it, and the race they
 * are in is the one for a wild card.
 *
 * None of this is in the export. team_record carries the division gb and
 * OOTP's magic number and stops there, so the wild-card race is worked out
 * here — but the shape of it is read rather than assumed, because
 * num_wild_cards varies from none to eight across the leagues in a single
 * save and a hard-coded three would be wrong in most of them.
 */

export interface PlayoffPicture {
  /** How many wild cards this league gives out. Zero means no such race. */
  spots: number;
  /** 'division' leading it, 'wildcard' holding one, 'out' otherwise. */
  route: 'division' | 'wildcard' | 'out';
  /** Games back in the division, as OOTP reports it. */
  divisionGb: number;
  /**
   * Games back of the last wild-card place. Negative means that many games
   * clear of the first club on the outside, which is how a club in a place
   * reads its own cushion.
   */
  wildcardGb: number | null;
  /** Position in the wild-card queue, counting only clubs not leading a division. */
  wildcardRank: number | null;
  /**
   * Games clear of the nearest club that would take the place — second in the
   * division for a leader, the first man out for a wild card. Null when not in
   * a place at all.
   *
   * Without it every leader looked equally safe: a twelve-game lead and a
   * half-game lead both read as "leading the division", and anything asking
   * how likely they were to stay there got the same answer for both.
   */
  cushion: number | null;
  /** OOTP's own number, when it has published one. */
  magicNumber: number | null;
  /** Said in a line, so the page does not have to assemble the wording. */
  summary: string;
}

interface Row {
  team_id: number;
  division_id: number;
  pos: number;
  w: number;
  l: number;
  gb: number;
  magic_number: number | null;
}

/** The standard half-game formula, from the club ahead to the club behind. */
const gamesBack = (ahead: { w: number; l: number }, behind: { w: number; l: number }): number =>
  ((ahead.w - behind.w) + (behind.l - ahead.l)) / 2;

export function playoffPicture(teamId: number): PlayoffPicture | null {
  if (!tableExists('team_record') || !tableExists('teams')) return null;

  const me = db
    .prepare(
      `SELECT t.league_id, t.sub_league_id, t.division_id, t.level
       FROM teams t WHERE t.team_id = ?`
    )
    .get(teamId) as
    | { league_id: number; sub_league_id: number; division_id: number; level: number }
    | undefined;
  if (!me) return null;

  const spots = tableExists('league_playoffs')
    ? Number(
        (db
          .prepare(`SELECT num_wild_cards FROM league_playoffs WHERE league_id = ?`)
          .get(me.league_id) as { num_wild_cards?: number } | undefined)?.num_wild_cards ?? 0
      )
    : 0;

  /*
   * The club's own conference, which is what a wild card is contested in.
   * Restricted to the same level as well: an affiliate shares a league_id with
   * nobody, but a save with independent leagues can put clubs of different
   * standing under one roof.
   */
  const rows = db
    .prepare(
      `SELECT t.team_id, t.division_id, r.pos, r.w, r.l, r.gb, r.magic_number
       FROM teams t JOIN team_record r ON r.team_id = t.team_id
       WHERE t.league_id = ? AND t.sub_league_id = ? AND t.level = ? AND t.allstar_team = 0
       ORDER BY r.w * 1.0 / MAX(r.w + r.l, 1) DESC, r.w DESC`
    )
    .all(me.league_id, me.sub_league_id, me.level) as Row[];

  const mine = rows.find((r) => r.team_id === teamId);
  if (!mine) return null;

  const magicNumber = mine.magic_number === 1000 ? null : (mine.magic_number ?? null);
  const divisionGb = mine.gb ?? 0;
  // OOTP's own first place, so its tiebreakers are respected rather than redone
  const leadsDivision = mine.pos === 1;

  /** How far clear of the best club not leading this division. */
  const divisionCushion = (): number | null => {
    const rivals = rows.filter((r) => r.division_id === mine.division_id && r.team_id !== teamId);
    if (rivals.length === 0) return null;
    const nearest = rivals.reduce((a, b) => (gamesBack(a, b) <= 0 ? a : b));
    return gamesBack(mine, nearest);
  };

  if (spots <= 0) {
    return {
      spots: 0,
      route: leadsDivision ? 'division' : 'out',
      divisionGb,
      wildcardGb: null,
      wildcardRank: null,
      cushion: leadsDivision ? divisionCushion() : null,
      magicNumber,
      summary: leadsDivision
        ? 'Leading the division.'
        : `${fmt(divisionGb)} back in the division, and this league has no wild card.`,
    };
  }

  // The queue: everybody not already in by winning their division
  const queue = rows.filter((r) => r.pos !== 1);
  const rank = queue.findIndex((r) => r.team_id === teamId);

  if (leadsDivision) {
    return {
      spots,
      route: 'division',
      divisionGb,
      wildcardGb: null,
      wildcardRank: null,
      cushion: divisionCushion(),
      magicNumber,
      summary: magicNumber
        ? `Leading the division — magic number ${magicNumber}.`
        : 'Leading the division.',
    };
  }

  const lastIn = queue[spots - 1];
  const firstOut = queue[spots];
  const inAPlace = rank >= 0 && rank < spots;

  /*
   * A club in a place is measured against the first one outside it, and a club
   * outside against the last one in. Measuring everybody against the same team
   * would tell whoever holds the final place that they are nought games back
   * of themselves.
   */
  const wildcardGb = inAPlace
    ? firstOut
      ? -gamesBack(mine, firstOut)
      : null
    : lastIn
      ? gamesBack(lastIn, mine)
      : null;

  const ordinal = rank >= 0 ? nth(rank + 1) : null;
  let summary: string;
  if (inAPlace) {
    const cushion = wildcardGb === null ? null : Math.abs(wildcardGb);
    summary =
      cushion === null
        ? `Holding the ${ordinal} wild card.`
        : `Holding the ${ordinal} wild card, ${fmt(cushion)} clear of the field.`;
  } else if (wildcardGb === null) {
    summary = `${fmt(divisionGb)} back in the division.`;
  } else {
    summary = `${fmt(wildcardGb)} back of the last wild card${ordinal ? `, ${ordinal} in the race` : ''}.`;
  }

  return {
    spots,
    route: inAPlace ? 'wildcard' : 'out',
    divisionGb,
    wildcardGb,
    wildcardRank: rank >= 0 ? rank + 1 : null,
    cushion: inAPlace && wildcardGb !== null ? -wildcardGb : null,
    magicNumber,
    summary,
  };
}

/** Half games read better as .5 than as 0.5, and whole ones without a decimal. */
function fmt(games: number): string {
  const n = Math.abs(games);
  const text = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${text} game${n === 1 ? '' : 's'}`;
}

function nth(n: number): string {
  if (n === 1) return '1st';
  if (n === 2) return '2nd';
  if (n === 3) return '3rd';
  return `${n}th`;
}
