import { BATTING_STATS, PITCHING_STATS } from './stats';

/**
 * One definition for every stat, rating, and derived value the app puts on
 * screen, so a column means the same thing on every page.
 *
 * Stat lines already carry their own descriptions in stats.ts; those are folded
 * in automatically and only overridden here when a page needs a different
 * emphasis. Everything else — roster status, scouting, contract, and schedule
 * vocabulary — is defined below.
 */

const EXTRA: Record<string, string> = {
  // ── Identity and roster ────────────────────────────────────────────────
  Age: "The player's age as of this point in the season. OOTP ages players on their real birthday, so a 'Age 27' season may end at 28.",
  Pos: 'Primary fielding position, the one OOTP lists him at. Many players are rated at several — open the player card to see every position he can cover.',
  'B/T': 'Bats / Throws. L = left, R = right, S = switch hitter. The batting hand drives the platoon advantage: hitters generally do better against the opposite hand.',
  B: 'Which side he bats from. L = left, R = right, S = switch hitter.',
  T: 'Which hand he throws with.',
  Team: 'The club. On roster and search views this is the player\u2019s current team — for minor leaguers that is the affiliate, not the parent club.',
  Level: 'The level he is playing at: MLB, AAA, AA, A, or Rookie ball.',
  Lvl: 'The level the stat line was compiled at. Numbers from different levels are not directly comparable — a .900 OPS in A-ball is a far weaker signal than the same mark in the majors.',
  Player: 'Click any name to open the full player card: ratings, contract, career history, game logs, and injuries.',
  Pitcher: 'Click the name to open the full player card, including his pitch arsenal and velocity.',
  Svc: 'Major-league service years. Six years of service normally brings free agency, and three brings arbitration — the two dates that shape every contract decision.',

  // ── Scouting ───────────────────────────────────────────────────────────
  Stam: "Stamina, on the 1-100 rating scale. It governs how deep a starter can go before tiring and whether a reliever can handle more than one inning.",
  Stuff: 'Raw swing-and-miss ability on the 1-100 scale — the rating most associated with strikeouts.',
  Control: 'Command of the strike zone on the 1-100 scale. Low control shows up as walks.',
  Movement: 'How much the ball moves, on the 1-100 scale. It mostly suppresses home runs and hard contact.',
  Velocity: 'Fastball velocity. Useful context for Stuff — the same Stuff rating plays differently at 91 mph than at 98.',

  // ── Standings and schedule ─────────────────────────────────────────────
  W: 'Wins.',
  L: 'Losses.',
  'W-L': "The pitcher's won-lost record. It depends heavily on run support and bullpen work, so it says more about the team than the pitcher — ERA+ and FIP are far better measures.",
  PCT: 'Winning percentage: wins divided by games played.',
  GB: 'Games behind the division leader. One game back means winning one more and having the leader lose one would tie it.',
  RS: 'Runs scored across the season so far.',
  RA: 'Runs allowed across the season so far.',
  DIFF: 'Run differential — runs scored minus runs allowed. Over a full season it predicts future record better than the current record does, so a good team with a bad record usually improves.',
  STRK: 'Current streak. W3 means three straight wins, L2 two straight losses.',
  Opp: 'The opposing team in that game.',
  'Next start': 'How many days until this starter is next in line, assuming a normal five-man rotation.',
  Rest: 'Days since this pitcher last appeared in a game.',
  Shape: "The salary curve across the life of the deal. A rising line is a backloaded contract; a falling one is frontloaded. Hard to see in a row of numbers, obvious as a shape.",

  // ── Bullpen availability ───────────────────────────────────────────────
  App: 'Appearances in the last three days — today, yesterday, and the day before.',
  'P/3d': 'Pitches thrown across the last three days. This is what actually decides whether an arm is available tonight, no matter how good the season line looks.',
  'Availability tonight': 'Whether this reliever can realistically be used in the next game, based on his recent pitch counts and consecutive appearances rather than on his season stats.',

  // ── Contracts and money ────────────────────────────────────────────────
  Salary: 'What he is paid this season.',
  'Current salary': 'What the player earned in the most recent season, a rough anchor for what he will ask for next.',
  'Yrs left': 'Seasons still guaranteed after this one. Zero means the deal expires at the end of this season.',
  Thru: 'The final season covered by the contract.',
  Through: 'The final season covered by the contract.',
  Notes: 'Contract clauses: team, player, and vesting options, plus no-trade protection.',
  Flags: 'Quick contract markers — expiring, still under team control, options, and no-trade clauses.',
  Recommendation: "The app's own read on the contract, weighing age, remaining years, how good he is now versus his ceiling, and what he costs. It is a starting point for your judgment, not a verdict.",
  Fit: 'How well this free agent addresses a hole on your roster, comparing his value to what you currently have at that position.',

  // ── Roster mechanics ───────────────────────────────────────────────────
  Status: 'Roster status — active, on an option to the minors, on the injured list, or exposed to waivers.',
  'Options used': 'Option years already burned. A player normally has three; once they are gone he cannot be sent down without clearing waivers first.',
  Issues: 'Roster problems needing a decision — out of options, Rule 5 exposure, or a designation clock running.',
  'Est. return': 'Estimated days until the player is back. OOTP revises this as the injury progresses.',
  'IL days this yr': 'Days spent on the injured list this season.',
  Missed: 'Games missed from this injury.',

  // ── Development ────────────────────────────────────────────────────────
  'Cur Δ': 'Change in current ability since the previous import. Positive means he has genuinely improved, not just performed better.',
  'Pot Δ': 'Change in scouted ceiling since the previous import. A falling ceiling on a young player is the earliest warning a prospect is stalling.',
  'What changed': 'Which individual ratings moved, so a change in the overall number can be traced to a cause.',

  // ── Staff ──────────────────────────────────────────────────────────────
  Manager: 'The person in the role. Coach ratings feed player development and in-game decisions.',
  'Teach Hitting': "The coach's ability to develop hitters, on the 1-100 scale. It compounds over a full season of instruction.",
  'Teach Pitching': "The coach's ability to develop pitchers, on the 1-100 scale.",
  'Handle Rookies': 'How well the coach develops young and inexperienced players specifically.',

  Rk: 'Rank within this list.',
  Signal: "The app's read on whether this player is ready for a promotion, is worth watching, or needs more time — driven by his performance relative to his level and his age relative to his peers.",

  // ── Misc ───────────────────────────────────────────────────────────────
  'Why here': 'The reason this player landed in this lineup slot.',
  Why: 'What drove this ranking.',
  'Your notes': 'Your own scouting notes. They are stored locally and never leave your machine.',
  Type: 'The kind of injury.',
};

/** Stat descriptions from the shared registry, keyed by their display label. */
const fromStats = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const def of [...BATTING_STATS, ...PITCHING_STATS]) {
    // Batting is listed first; pitching wins ties for shared labels like K and BB
    // only where the pitching meaning differs, which the descriptions already state.
    if (!out[def.label]) out[def.label] = def.desc;
  }
  return out;
};

const TABLE: Record<string, string> = { ...fromStats(), ...EXTRA };

const normalize = (label: string): string => label.trim().replace(/\s+/g, ' ');

/** The definition for a column label, or undefined if there isn't one. */
export function define(label: string): string | undefined {
  const key = normalize(label);
  if (TABLE[key]) return TABLE[key];
  const lower = key.toLowerCase();
  const hit = Object.keys(TABLE).find((k) => k.toLowerCase() === lower);
  return hit ? TABLE[hit] : undefined;
}

/** Every term that has a definition, for the in-app glossary listing. */
export const allTerms = (): Array<{ term: string; definition: string }> =>
  Object.entries(TABLE)
    .map(([term, definition]) => ({ term, definition }))
    .sort((a, b) => a.term.localeCompare(b.term, undefined, { sensitivity: 'base' }));
