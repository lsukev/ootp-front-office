/**
 * Whether a player is hurt, and whether he can play anyway.
 *
 * Four pages worked this out for themselves and all four got it wrong the same
 * way: they read the injured-list flags first and believed them. OOTP does not
 * always clear those flags when a man is activated, so a healthy player still
 * carrying `is_on_dl60` was being listed as IL-60 on the injury report — and,
 * worse, quietly dropped from the lineup card as unavailable.
 *
 * `is_active` settles it. A man on the active roster is playing, whatever a
 * stale flag says; a man genuinely on the injured list is not active. In this
 * save every one of the 620 real injured-list rows has `is_active = 0`, while
 * 21 active players carry an injury flag — those are the day-to-day cases, who
 * are on the roster and available. So the list flags are read only for someone
 * who is not active, and for anyone who is, only the injury fields speak.
 */

export interface HealthFields {
  is_active?: number | null;
  is_on_dl?: number | null;
  is_on_dl60?: number | null;
  injury_is_injured?: number | null;
  injury_dtd_injury?: number | null;
  injury_left?: number | null;
}

/**
 * The day count OOTP writes when it has none to write.
 *
 * A reader spotted this: "the 1000 days injury is what OOTP exports if the
 * number of days is unknown... players with 1000 days are treated as if they
 * aren't coming back."
 *
 * He is right, and the save says so plainly. Injury lengths in my own export
 * run continuously from 1 day to 597 — and then stop. There is not one player
 * anywhere between 598 and 999, and then thirty-nine of them sit on exactly
 * 1000. Not one of the thirty-nine carries the career-ending flag, which OOTP
 * does export and which two other players in the league have. Thirty-seven of
 * the forty are not on the injured list at all.
 *
 * What settles it is that they play. Fernando Tatis Jr. carries 1000 days
 * remaining and has played fifty-eight games this season, the last of them a
 * week before the export was taken. A man out for a thousand days does not
 * play fifty-eight games, so the number is not days.
 *
 * Read as a duration it was the worst kind of wrong: not obviously broken,
 * just quietly saying a healthy man is gone for three years. The one other
 * value above the range is a single 2250, and it is treated the same way —
 * whether that is a second placeholder or a genuine six-year absence, "about
 * 2250 more days" is not a thing to tell a manager either.
 */
export const NO_TIMETABLE = 1000;

export interface Health {
  status: 'IL-60' | 'IL' | 'Day-to-day' | 'Injured';
  /** Days remaining, or null when the export did not give a real number. */
  daysLeft: number | null;
  /**
   * He is hurt and there is no date on it. Distinct from `daysLeft === null`
   * with this false, which is an export that said nothing about the injury at
   * all — the screens word the two differently.
   */
  durationUnknown: boolean;
  /**
   * Whether he can still be written into tonight's lineup. Day-to-day men can:
   * OOTP lets a manager play through it, so that is his call rather than ours.
   */
  playable: boolean;
}

export function healthOf(p: HealthFields): Health | null {
  const raw = p.injury_left ?? null;
  const durationUnknown = raw !== null && raw >= NO_TIMETABLE;
  const daysLeft = raw !== null && raw > 0 && !durationUnknown ? raw : null;
  const active = p.is_active === 1;

  if (active) {
    // On the roster and playing. Only a live injury field means anything here,
    // and it never makes him unavailable — that is what being active means.
    if (p.injury_dtd_injury === 1) return { status: 'Day-to-day', daysLeft, durationUnknown, playable: true };
    if (p.injury_is_injured === 1) return { status: 'Day-to-day', daysLeft, durationUnknown, playable: true };
    return null;
  }

  if (p.is_on_dl60 === 1) return { status: 'IL-60', daysLeft, durationUnknown, playable: false };
  if (p.is_on_dl === 1) return { status: 'IL', daysLeft, durationUnknown, playable: false };
  if (p.injury_dtd_injury === 1) return { status: 'Day-to-day', daysLeft, durationUnknown, playable: false };
  if (p.injury_is_injured === 1) return { status: 'Injured', daysLeft, durationUnknown, playable: false };
  return null;
}

/**
 * The placeholder rule in SQL, for queries that read the column directly rather
 * than through {@link healthOf}. Kept here so a placeholder cannot reach a
 * screen — or an AI prompt — by way of a query that forgot about it.
 */
export const daysLeftSql = (column: string): string =>
  `CASE WHEN ${column} >= ${NO_TIMETABLE} OR ${column} <= 0 THEN NULL ELSE ${column} END`;

/**
 * The SQL half of the hurt/not-hurt rule, for queries that filter before the
 * rows reach JavaScript. Kept beside {@link healthOf} so the two cannot drift.
 */
export const HURT_SQL =
  `((rs.is_active = 1 AND (p.injury_is_injured = 1 OR p.injury_dtd_injury = 1))
    OR (rs.is_active != 1 AND (rs.is_on_dl = 1 OR rs.is_on_dl60 = 1
        OR p.injury_is_injured = 1 OR p.injury_dtd_injury = 1)))`;

export interface StandingFields extends HealthFields {
  designated_for_assignment?: number | null;
  days_on_dfa_left?: number | null;
  is_on_waivers?: number | null;
}

export interface Standing {
  /** Short label: DFA, Waivers, IL-60, IL, Day-to-day, Active, Reserve. */
  label: string;
  daysLeft: number | null;
  /** Hurt, with no return date in the export. Never true of DFA or waivers. */
  durationUnknown: boolean;
  /** Whether he can be used tonight. False for DFA, waivers and the IL. */
  available: boolean;
}

/**
 * Where a man stands with the club, which is not the same as whether he is hurt.
 *
 * OOTP's own roster list keeps a designated player on it — he is still club
 * property while the clock runs — so a page reading that list alone sees no
 * difference between a starting third baseman and one who was DFA'd this
 * morning. That is how the manager came to describe a designated player as the
 * starting third baseman: the roster said he was there and nothing said
 * otherwise.
 *
 * Designation and waivers come first because they outrank everything else: a
 * man on the DFA clock is not available whatever his health says.
 */
export function standingOf(p: StandingFields): Standing {
  if (p.designated_for_assignment === 1) {
    return { label: 'DFA', daysLeft: p.days_on_dfa_left ?? null, durationUnknown: false, available: false };
  }
  if (p.is_on_waivers === 1) {
    return { label: 'Waivers', daysLeft: p.days_on_dfa_left ?? null, durationUnknown: false, available: false };
  }
  const health = healthOf(p);
  if (health) {
    return {
      label: health.status,
      daysLeft: health.daysLeft,
      durationUnknown: health.durationUnknown,
      available: health.playable,
    };
  }
  return { label: p.is_active === 1 ? 'Active' : 'Reserve', daysLeft: null, durationUnknown: false, available: true };
}
