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
  /** Regular-season games this club has left, for the clinch arithmetic. */
  games_left: number;
  /** Its whole regular-season schedule, for checking that against the record. */
  games_scheduled: number;
}

/**
 * Whether the race is already decided, by counting wins nobody can take back.
 *
 * Both readings are exact rather than probabilistic, and both are one line:
 *
 *  - A club is OUT when every berth is held by a club whose wins already beat
 *    the most this club can finish with. Those clubs can only add to their
 *    totals, and anybody who displaces one of them must finish above them, so
 *    the berths are gone whatever happens from here.
 *  - A club is IN when fewer clubs than there are berths can still reach its
 *    current win total. It can only add to that total, so the count is a floor.
 *
 * Ties are treated as not settled — a tie is decided by a rule or a game this
 * app cannot see, and claiming a place on one would be claiming to know more
 * than the export says.
 */
function decide(rows: Row[], mine: Row, spots: number): { clinched: boolean; eliminated: boolean } {
  const divisions = new Set(rows.map((r) => r.division_id)).size;
  const berths = divisions + Math.max(0, spots);
  const others = rows.filter((r) => r.team_id !== mine.team_id);
  if (berths <= 0 || others.length < berths) return { clinched: false, eliminated: false };

  const myMax = mine.w + mine.games_left;
  // The clubs currently holding berths, weakest first
  const holders = [...others].sort((a, b) => b.w - a.w).slice(0, berths);
  const eliminated = holders.length === berths && holders.every((h) => h.w > myMax);

  const canReachMe = others.filter((r) => r.w + r.games_left >= mine.w).length;
  const clinched = canReachMe < berths;

  return { clinched, eliminated: eliminated && !clinched };
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
  const scheduleReadable = hasColumns('games', 'game_type', 'played', 'home_team', 'away_team');
  const perTeam = (predicate: string) =>
    scheduleReadable
      ? `(SELECT COUNT(*) FROM games g
          WHERE (g.home_team = t.team_id OR g.away_team = t.team_id)
            AND g.game_type = 0${predicate})`
      : '0';
  const leftColumn = perTeam(' AND COALESCE(g.played, 0) = 0');
  const totalColumn = perTeam('');

  const rows = db
    .prepare(
      `SELECT t.team_id, t.division_id, r.pos, r.w, r.l, r.gb, r.magic_number,
              ${leftColumn} AS games_left, ${totalColumn} AS games_scheduled
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
  const magicNumber =
    mine.magic_number !== null && mine.magic_number > 0 && mine.magic_number !== 1000
      ? mine.magic_number
      : null;

  /*
   * The schedule is only trusted when it accounts for the games already played.
   * An export carrying a partial one would otherwise report nought games left
   * and be read as a finished season — which is a worse answer than admitting
   * the schedule cannot be read.
   */
  const fromSchedule =
    scheduleReadable && rows.every((r) => r.games_scheduled >= r.w + r.l) &&
    rows.some((r) => r.games_scheduled > 0);

  /*
   * Where the export carries no schedule for this league, the length OOTP was
   * configured with stands in — every club's played total is known, so the
   * remainder is arithmetic. Without either, nothing is claimed.
   */
  const configured = fromSchedule ? null : configuredSeasonLength(me.league_id);
  const scheduleKnown = fromSchedule || configured !== null;
  if (configured !== null) {
    for (const r of rows) r.games_left = Math.max(0, configured - (r.w + r.l));
  }
  const gamesLeft = scheduleKnown ? mine.games_left : null;
  const seasonOver = scheduleKnown && mine.games_left === 0;
  const { clinched, eliminated } = scheduleKnown
    ? decide(rows, mine, spots)
    : { clinched: false, eliminated: false };
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
