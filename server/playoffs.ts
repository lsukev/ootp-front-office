import { db, hasColumns, tableExists } from './db.js';

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

/**
 * Regular-season games a club has still to play.
 *
 * Counted from the schedule rather than subtracted from a season length, and
 * restricted to `game_type = 0`. Both matter. The old reading counted every
 * row in `games` for the club — which includes the exhibition slate — and
 * subtracted the games played, so a club that had finished all 162 was told it
 * had 28 games left to settle its season: exactly the number of spring games
 * it had already played in March.
 *
 * A user caught it at the only moment it becomes obvious, with every game of
 * the year in the books and the dashboard still offering to buy. It had been
 * wrong all season — twenty-eight phantom games in every odds calculation the
 * card made.
 */
/**
 * A club's regular-season schedule: how many games it holds, and how many are
 * still to play.
 *
 * Both numbers matter. The count is restricted to `game_type = 0`, because the
 * old reading counted every row in `games` for the club — the exhibition slate
 * included — and subtracted the games played, so a club that had finished all
 * 162 was told it had 28 games left to settle its season: exactly the number of
 * spring games it had already played in March. A user caught it at the only
 * moment it becomes obvious, with the whole year in the books and the dashboard
 * still offering to buy. It had been wrong all season, with twenty-eight
 * phantom games in every odds calculation the card ever made.
 *
 * The total is returned so a caller can check the schedule against the record
 * before trusting it. An export whose schedule does not even cover the games
 * already played cannot be used to say the season is over.
 */
export interface ScheduleRead {
  /** Regular-season games on the schedule, played or not. */
  total: number;
  /** Regular-season games still to play. */
  left: number;
}

/**
 * The season length OOTP was configured with, for the league.
 *
 * A fallback for saves whose export carries no schedule for a league — some
 * winter and independent leagues in my own save have records but almost no
 * games rows. It is read rather than assumed because it is nowhere near
 * constant: 162 in the majors, 150 and 138 and 132 down the affiliate ladder,
 * and 55 in the complex league. The old fallback assumed 162 for all of them.
 */
export function configuredSeasonLength(leagueId: number): number | null {
  if (!tableExists('leagues') || !hasColumns('leagues', 'rules_schedule_games_per_team')) return null;
  const n = Number(
    (db
      .prepare(`SELECT rules_schedule_games_per_team AS n FROM leagues WHERE league_id = ?`)
      .get(leagueId) as { n?: number } | undefined)?.n ?? 0
  );
  return n > 0 ? n : null;
}

/**
 * Regular-season games left, for every club in a league.
 *
 * One query and one rule, because three screens now need this number and the
 * first two disagreed: the dashboard counted the exhibition slate as games
 * still to play, and the standings page did not count anything at all.
 *
 * The schedule is preferred and only trusted when it accounts for the games
 * already played — a partial one would otherwise read as a finished season.
 * Failing that, the length OOTP was configured with for the league stands in,
 * which is 162 in the majors and 150, 138, 132 or 55 further down. Failing
 * both, nothing is returned and every caller says nothing rather than guessing.
 */
export function gamesLeftByTeam(leagueId: number): Map<number, number> | null {
  if (!tableExists('teams') || !tableExists('team_record')) return null;

  const readable = tableExists('games') &&
    hasColumns('games', 'game_type', 'played', 'home_team', 'away_team');
  const rows = db
    .prepare(
      `SELECT t.team_id, r.w + r.l AS played,
              ${readable ? `(SELECT COUNT(*) FROM games g
                 WHERE (g.home_team = t.team_id OR g.away_team = t.team_id)
                   AND g.game_type = 0)` : '0'} AS total,
              ${readable ? `(SELECT COUNT(*) FROM games g
                 WHERE (g.home_team = t.team_id OR g.away_team = t.team_id)
                   AND g.game_type = 0 AND COALESCE(g.played, 0) = 0)` : '0'} AS unplayed
       FROM teams t JOIN team_record r ON r.team_id = t.team_id
       WHERE t.league_id = ? AND t.allstar_team = 0`
    )
    .all(leagueId) as Array<{ team_id: number; played: number; total: number; unplayed: number }>;
  if (rows.length === 0) return null;

  const scheduleUsable =
    readable && rows.some((r) => r.total > 0) && rows.every((r) => r.total >= r.played);
  if (scheduleUsable) {
    return new Map(rows.map((r) => [r.team_id, r.unplayed]));
  }

  const configured = configuredSeasonLength(leagueId);
  if (configured === null) return null;
  return new Map(rows.map((r) => [r.team_id, Math.max(0, configured - r.played)]));
}

/** OOTP writes 1000 for "not applicable" and counts a real one down past zero
 *  once the race is settled. Only a positive number is a magic number. */
export function displayMagicNumber(raw: number | null | undefined): number | null {
  return raw !== null && raw !== undefined && raw > 0 && raw !== 1000 ? raw : null;
}

export function regularSeasonSchedule(teamId: number): ScheduleRead | null {
  if (!tableExists('games') || !hasColumns('games', 'game_type', 'played', 'home_team', 'away_team')) {
    return null;
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN COALESCE(played, 0) = 0 THEN 1 ELSE 0 END) AS left_
       FROM games
       WHERE (home_team = ? OR away_team = ?) AND game_type = 0`
    )
    .get(teamId, teamId) as { total: number; left_: number | null };
  if (!row || row.total === 0) return null;
  return { total: Number(row.total), left: Number(row.left_ ?? 0) };
}

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
  /** OOTP's own number, when it has published a real one. */
  magicNumber: number | null;
  /** A place is secured — nobody left can finish above enough clubs to take it. */
  clinched: boolean;
  /** Mathematically out: the berths will all go to clubs he cannot now catch. */
  eliminated: boolean;
  /** Regular-season games the club has left, null when the schedule is unreadable. */
  gamesLeft: number | null;
  /** Every regular-season game played. The race is a result, not a question. */
  seasonOver: boolean;
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

/** A club's line, as much of it as the race arithmetic needs. */
export interface RaceRow {
  team_id: number;
  division_id: number;
  /** OOTP's own division rank, so its tiebreakers are respected rather than redone. */
  pos: number;
  w: number;
  l: number;
  gamesLeft: number;
}

/** What a standings page prints beside a club: in, out, or nothing yet. */
export type RaceMark = 'x' | 'e' | null;

/**
 * Who is in and who is out, for a whole conference at once.
 *
 * "OOTP puts an x for every team that reached postseason, worth replicating.
 * Negative magic numbers or zero in League Standings page at the end of
 * regular season remain."
 *
 * Both readings are exact, and both are conservative in the same direction: a
 * mark is only printed where the arithmetic leaves no room for the season to
 * disagree with it. Saying a club is out when it is not would be worse than
 * saying nothing.
 *
 *  - IN by winning the division: no club in it can still reach this one's win
 *    total. Or in by wild card: fewer clubs than there are wild cards can
 *    reach that total. Counting against the wild cards rather than against
 *    every place is deliberate — a division winner from elsewhere takes a
 *    place without taking a wild card, and counting them would claim a place
 *    that a weak division can still take away.
 *  - OUT when this club can no longer win its own division AND at least as
 *    many clubs as there are places have already won more games than it can
 *    finish with. Those totals cannot fall, so the places are gone.
 *
 * Once the season has been played out the question is not arithmetic any more,
 * and the marks are simply who finished in a place.
 */
export function raceMarks(rows: RaceRow[], spots: number): Map<number, RaceMark> {
  const marks = new Map<number, RaceMark>(rows.map((r) => [r.team_id, null]));
  const divisions = new Set(rows.map((r) => r.division_id)).size;
  const berths = divisions + Math.max(0, spots);
  if (rows.length < 2 || berths <= 0) return marks;

  const seasonOver = rows.every((r) => r.gamesLeft === 0);
  if (seasonOver) {
    const queue = rows
      .filter((r) => r.pos !== 1)
      .sort((a, b) => b.w / Math.max(1, b.w + b.l) - a.w / Math.max(1, a.w + a.l));
    for (const r of rows) if (r.pos === 1) marks.set(r.team_id, 'x');
    for (const r of queue.slice(0, Math.max(0, spots))) marks.set(r.team_id, 'x');
    return marks;
  }

  for (const mine of rows) {
    const others = rows.filter((r) => r.team_id !== mine.team_id);
    const myMax = mine.w + mine.gamesLeft;
    const inDivision = others.filter((r) => r.division_id === mine.division_id);

    const wonDivision = inDivision.length > 0 && inDivision.every((r) => r.w + r.gamesLeft < mine.w);
    const wonWildcard = spots > 0 && others.filter((r) => r.w + r.gamesLeft >= mine.w).length < spots;
    if (wonDivision || wonWildcard) {
      marks.set(mine.team_id, 'x');
      continue;
    }

    const cannotWinDivision = inDivision.some((r) => r.w > myMax);
    const aheadForGood = others.filter((r) => r.w > myMax).length;
    if (cannotWinDivision && aheadForGood >= berths) marks.set(mine.team_id, 'e');
  }
  return marks;
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
  /*
   * Games left per club, from the schedule. An export with no usable schedule
   * gets zero, which makes the clinch arithmetic say nothing rather than
   * claim everything is already settled.
   */
  const left = gamesLeftByTeam(me.league_id);

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

  /*
   * OOTP writes 1000 for "not applicable" and counts the number down as the
   * race tightens — past zero once it is settled. A club that had won its
   * division read "magic number -1", because a negative number is a truthy
   * one and the line was printed whenever the field was set.
   */
  const magicNumber = displayMagicNumber(mine.magic_number);

  const scheduleKnown = left !== null;
  const gamesLeft = left?.get(teamId) ?? null;
  const seasonOver = gamesLeft === 0;
  const marks = scheduleKnown
    ? raceMarks(
        rows.map((r) => ({
          team_id: r.team_id, division_id: r.division_id, pos: r.pos,
          w: r.w, l: r.l, gamesLeft: left!.get(r.team_id) ?? 0,
        })),
        spots
      )
    : new Map<number, RaceMark>();
  const clinched = marks.get(teamId) === 'x' && !seasonOver;
  const eliminated = marks.get(teamId) === 'e';
  const settled = { clinched, eliminated, gamesLeft, seasonOver };

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
      ...settled,
      summary: leadsDivision
        ? seasonOver
          ? 'Won the division.'
          : clinched
            ? 'Clinched the division.'
            : 'Leading the division.'
        : seasonOver
          ? `Finished ${fmt(divisionGb)} back in the division.`
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
      ...settled,
      summary: seasonOver
        ? 'Won the division.'
        : clinched
          ? 'Clinched the division.'
          : magicNumber
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
  if (seasonOver) {
    summary = inAPlace
      ? `Finished with the ${ordinal} wild card.`
      : wildcardGb === null
        ? `Finished ${fmt(divisionGb)} back in the division.`
        : `Finished ${fmt(wildcardGb)} short of the last wild card.`;
  } else if (eliminated) {
    summary = wildcardGb === null
      ? `Out of the race, ${fmt(divisionGb)} back in the division.`
      : `Out of the race — ${fmt(wildcardGb)} back of the last wild card with ${gamesLeft} to play.`;
  } else if (inAPlace) {
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
    ...settled,
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
