import { db, tableExists } from './db.js';
import { configuredSeasonLength, playoffPicture, regularSeasonSchedule } from './playoffs.js';
import { currentGameDate } from './valuation.js';

/**
 * Buy, hold or sell — and the arithmetic behind it.
 *
 * The question a deadline actually poses is not "are we good" but "can we
 * still get there from here", and those come apart badly. A club five games
 * out in May and a club five games out in September are the same line in the
 * standings and opposite answers.
 *
 * So the verdict is driven by one number: the chance of reaching the
 * postseason, worked out rather than felt. Talent comes from run differential
 * instead of won-lost record, because a club's runs predict its future better
 * than its results do — a 45-46 team outscoring its opponents by fifty is a
 * good team having bad luck, and it should be buying.
 *
 * Deliberately willing to say hold. Most clubs most of the time genuinely are
 * on the fence, and a tool that manufactures a decision to seem useful is
 * worse than one that admits the season has not decided yet.
 */

export type Posture = 'buy' | 'lean-buy' | 'hold' | 'lean-sell' | 'sell';

export interface DeadlineRead {
  posture: Posture;
  /** Chance of reaching the postseason, 0-1. Certain once settled. */
  odds: number;
  /**
   * Set once the race is a result rather than a question — the season has been
   * played out, or the arithmetic has closed either way. A card that offers to
   * buy after the last game of the year is not reading the season, and the
   * reader who reported this was looking at exactly that.
   */
  settled: 'in' | 'out' | null;
  /** The word on the card: the posture, or IN / OUT once it is settled. */
  verdict: string;
  /** The line beside it, which used to be hardcoded in the page. */
  caption: string;
  headline: string;
  /** The two or three facts doing the work, for the page to list. */
  reasons: string[];
  gamesPlayed: number;
  gamesLeft: number;
  runDiff: number;
  /** Wins the run differential says they should have, against what they do. */
  pythagoreanWins: number;
  actualWins: number;
  /** False when the export gave nothing to work the figure out from. */
  gamesLeftKnown: boolean;
  /** Null when the save has no deadline, or it has already passed. */
  daysToDeadline: number | null;
  deadlinePassed: boolean;
}

/** Pythagorean expectation at the exponent that fits modern scoring. */
const pythag = (rs: number, ra: number): number => {
  if (rs <= 0 && ra <= 0) return 0.5;
  const rs18 = Math.pow(rs, 1.83);
  return rs18 / (rs18 + Math.pow(ra, 1.83));
};

/** The normal CDF, for turning a games-back gap into a probability. */
function normalCdf(z: number): number {
  // Abramowitz & Stegun 26.2.17 — plenty for a number shown to the nearest %
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (1.330274429 * t ** 4 - 1.821255978 * t ** 3 + 1.781477937 * t ** 2 - 0.356563782 * t + 0.319381530);
  return z > 0 ? 1 - p : p;
}

function runsFor(teamId: number): { rs: number; ra: number } {
  const rs = tableExists('team_batting_stats')
    ? Number((db.prepare(`SELECT SUM(r) AS r FROM team_batting_stats WHERE team_id = ?`).get(teamId) as { r: number | null })?.r ?? 0)
    : 0;
  // `r` is runs allowed here; `ra` is a different measure entirely
  const ra = tableExists('team_pitching_stats')
    ? Number((db.prepare(`SELECT SUM(r) AS r FROM team_pitching_stats WHERE team_id = ?`).get(teamId) as { r: number | null })?.r ?? 0)
    : 0;
  return { rs, ra };
}

/** Parses OOTP's loose date strings — '2026-8-3' as readily as '2026-08-03'. */
function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value.trim());
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function deadlineRead(teamId: number): DeadlineRead | null {
  if (!tableExists('teams') || !tableExists('team_record')) return null;

  const team = db
    .prepare(`SELECT league_id FROM teams WHERE team_id = ?`)
    .get(teamId) as { league_id: number } | undefined;
  const record = db
    .prepare(`SELECT w, l FROM team_record WHERE team_id = ?`)
    .get(teamId) as { w: number; l: number } | undefined;
  if (!team || !record) return null;

  const played = record.w + record.l;
  if (played === 0) return null;

  /*
   * From the schedule, counting only regular-season games not yet played. The
   * old reading counted every row in `games` — exhibition slate included — and
   * subtracted the games played, which told a club that had finished its 162
   * that it had 28 games left: its March exhibition games, to the game. Every
   * odds calculation this card has ever made was run with those in it.
   */
  const schedule = regularSeasonSchedule(teamId);
  // Only trusted when it covers the games already played — a partial schedule
  // would otherwise read as a season with nothing left in it
  /*
   * The schedule first, then the length OOTP was configured with for the
   * league, and only then a guess. The guess is kept for the odds — they need
   * some horizon — but it is flagged, because a fabricated "132 games left to
   * settle it" is the same fault as the 28 that started this: a number on the
   * card that nothing in the export supports. Some independent and winter
   * leagues in a save have records and no schedule at all.
   */
  const configured = configuredSeasonLength(team.league_id);
  const fromSchedule = schedule !== null && schedule.total >= played;
  const gamesLeft = fromSchedule
    ? schedule!.left
    : Math.max(0, (configured ?? 162) - played);
  const gamesLeftKnown = fromSchedule || configured !== null;

  const { rs, ra } = runsFor(teamId);
  const talent = pythag(rs, ra);
  const picture = playoffPicture(teamId);

  /*
   * The gap to close, in games. A club already in a place is defending one, so
   * its gap is negative and the arithmetic runs the same way — the chance of
   * still being ahead at the end rather than of catching up.
   */
  const gap = picture
    ? picture.route === 'out'
      ? (picture.wildcardGb ?? picture.divisionGb)
      // In a place: the gap is the cushion, negative, so the same arithmetic
      // asks how likely they are to still be there rather than to catch up
      : -(picture.cushion ?? 1)
    : 0;

  /*
   * Over the games that remain, the difference between two clubs' win totals
   * is roughly normal. Assume whoever holds the place is a .520 club — near
   * enough for every league, and it avoids reading one rival's hot streak as
   * permanent talent.
   */
  const rival = 0.52;
  const expectedGain = gamesLeft * (talent - rival);
  const sigma = Math.sqrt(Math.max(1, gamesLeft) * (talent * (1 - talent) + rival * (1 - rival)));
  const odds = gamesLeft === 0
    ? (gap <= 0 ? 1 : 0)
    : Math.min(0.99, Math.max(0.01, normalCdf((expectedGain - gap) / sigma)));

  const deadline = parseDate(
    (db.prepare(`SELECT trade_deadline_date AS d FROM leagues WHERE league_id = ?`).get(team.league_id) as { d?: string } | undefined)?.d
  );
  /*
   * Through the shared helper, which quotes the column name. SQLite has a
   * built-in CURRENT_DATE keyword that silently shadows the column of that
   * name, so the unquoted version returns the real-world date rather than the
   * league's — and reported a deadline nine days past that is in fact
   * twenty-eight days away.
   */
  const today = parseDate(currentGameDate(team.league_id));
  const daysToDeadline = deadline && today
    ? Math.round((deadline.getTime() - today.getTime()) / 86_400_000)
    : null;
  const deadlinePassed = daysToDeadline !== null && daysToDeadline < 0;

  const pythagoreanWins = talent * played;
  const luck = record.w - pythagoreanWins;

  /*
   * Whether there is still a question. A season that has been played out, or a
   * race the arithmetic has closed, is a result — and a result is not a
   * posture. Reported separately from the verdict so the page can stop asking
   * a settled question rather than answering it at 99%.
   */
  const seasonOver = picture?.seasonOver ?? false;
  const reachedIt = seasonOver && picture !== null && picture.route !== 'out';
  const settled: 'in' | 'out' | null =
    seasonOver
      ? reachedIt ? 'in' : 'out'
      : picture?.clinched
        ? 'in'
        : picture?.eliminated
          ? 'out'
          : null;

  // Certainty, not a model, once the race is decided either way
  const settledOdds = settled === 'in' ? 1 : settled === 'out' ? 0 : odds;

  let posture: Posture;
  if (settled === 'in') posture = 'buy';
  else if (settled === 'out') posture = 'sell';
  else if (odds >= 0.75) posture = 'buy';
  else if (odds >= 0.55) posture = 'lean-buy';
  else if (odds >= 0.25) posture = 'hold';
  else if (odds >= 0.10) posture = 'lean-sell';
  else posture = 'sell';

  const reasons: string[] = [];
  reasons.push(
    `${record.w}-${record.l} with a ${rs - ra >= 0 ? '+' : ''}${rs - ra} run differential — ` +
    `the runs say a ${(talent * 162).toFixed(0)}-win pace.`
  );
  if (Math.abs(luck) >= 3) {
    reasons.push(
      luck > 0
        ? `Winning ${luck.toFixed(0)} more than the runs support, which tends not to last.`
        : `Losing ${Math.abs(luck).toFixed(0)} more than the runs support — better than the record looks.`
    );
  }
  if (picture) reasons.push(picture.summary);
  if (seasonOver) reasons.push(`${played} games played — the regular season is over.`);
  else if (gamesLeftKnown) reasons.push(`${gamesLeft} games left to settle it.`);
  // The deadline is beside the point once the games have run out
  if (!seasonOver) {
    if (deadlinePassed) reasons.push('The deadline has passed — this reads the season, not the market.');
    else if (daysToDeadline !== null) reasons.push(`${daysToDeadline} days to the deadline.`);
  }

  const chance = `${Math.round(settledOdds * 100)}%`;
  const headline = settled
    ? seasonOver
      ? settled === 'in'
        ? 'Reached the postseason.'
        : 'Missed the postseason.'
      : settled === 'in'
        ? 'A place is secured — the rest is seeding.'
        : `Eliminated with ${gamesLeft} to play. Play for next year.`
    : {
        buy: `Buy — ${chance} to reach the postseason.`,
        'lean-buy': `Lean buy — ${chance}, and the games left are enough.`,
        hold: `Hold — ${chance}. The season has not decided yet.`,
        'lean-sell': `Lean sell — ${chance}, and running out of road.`,
        sell: `Sell — ${chance}. Play for next year.`,
      }[posture];

  /*
   * The card's own words, so the wording travels with the reading. The page
   * had "to reach the postseason" written into it, which is why the screenshot
   * a reader sent in still read that under a season that had finished.
   */
  const verdict = settled ? (settled === 'in' ? 'in' : 'out') : posture.replace('-', ' ');
  const caption = settled
    ? seasonOver
      ? settled === 'in' ? 'reached the postseason' : 'missed the postseason'
      : settled === 'in' ? 'a postseason place is clinched' : 'eliminated from the race'
    : 'to reach the postseason';

  return {
    posture, odds: settledOdds, settled, verdict, caption, headline, reasons,
    gamesPlayed: played, gamesLeft, gamesLeftKnown,
    runDiff: rs - ra,
    pythagoreanWins: Number(pythagoreanWins.toFixed(1)),
    actualWins: record.w,
    daysToDeadline, deadlinePassed,
  };
}
