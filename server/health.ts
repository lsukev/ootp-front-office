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

export interface Health {
  status: 'IL-60' | 'IL' | 'Day-to-day' | 'Injured';
  daysLeft: number | null;
  /**
   * Whether he can still be written into tonight's lineup. Day-to-day men can:
   * OOTP lets a manager play through it, so that is his call rather than ours.
   */
  playable: boolean;
}

export function healthOf(p: HealthFields): Health | null {
  const daysLeft = p.injury_left ?? null;
  const active = p.is_active === 1;

  if (active) {
    // On the roster and playing. Only a live injury field means anything here,
    // and it never makes him unavailable — that is what being active means.
    if (p.injury_dtd_injury === 1) return { status: 'Day-to-day', daysLeft, playable: true };
    if (p.injury_is_injured === 1) return { status: 'Day-to-day', daysLeft, playable: true };
    return null;
  }

  if (p.is_on_dl60 === 1) return { status: 'IL-60', daysLeft, playable: false };
  if (p.is_on_dl === 1) return { status: 'IL', daysLeft, playable: false };
  if (p.injury_dtd_injury === 1) return { status: 'Day-to-day', daysLeft, playable: false };
  if (p.injury_is_injured === 1) return { status: 'Injured', daysLeft, playable: false };
  return null;
}

/**
 * The SQL half of the same rule, for queries that filter before the rows reach
 * JavaScript. Kept beside {@link healthOf} so the two cannot drift apart.
 */
export const HURT_SQL =
  `((rs.is_active = 1 AND (p.injury_is_injured = 1 OR p.injury_dtd_injury = 1))
    OR (rs.is_active != 1 AND (rs.is_on_dl = 1 OR rs.is_on_dl60 = 1
        OR p.injury_is_injured = 1 OR p.injury_dtd_injury = 1)))`;
