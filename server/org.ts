import { Router } from 'express';
import { db, tableExists, tableColumns } from './db.js';
import { LEVEL_NAMES } from './valuation.js';

export const orgRoutes = Router();


const avg = (vals: Array<number | null | undefined>): number | null => {
  const nums = vals.filter((v): v is number => typeof v === 'number');
  if (!nums.length) return null;
  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
};

/** MLB parent clubs, with the human-controlled org flagged and team colors. */
orgRoutes.get('/orgs', (_req, res) => {
  if (!tableExists('teams')) return res.json([]);
  const rows = db
    .prepare(
      `SELECT team_id, name, nickname, human_team,
              background_color_id AS bg, text_color_id AS fg,
              jersey_secondary_color_id AS secondary, ballcaps_main_color_id AS cap
       FROM teams WHERE level = 1 AND allstar_team = 0 ORDER BY name`
    )
    .all() as Array<{
    team_id: number; name: string; nickname: string; human_team: number;
    bg: string | null; fg: string | null; secondary: string | null; cap: string | null;
  }>;
  res.json(
    rows.map((r) => ({
      team_id: r.team_id,
      label: r.name === r.nickname ? r.name : `${r.name} ${r.nickname}`,
      isHuman: r.human_team === 1,
      colors: { bg: r.bg, fg: r.fg, secondary: r.secondary, cap: r.cap },
    }))
  );
});

/** The column signings nobody has assigned yet are gathered under. */
const UNASSIGNED_TEAM = -1;

function orgTeams(orgId: number) {
  return db
    .prepare(
      `SELECT team_id, name, nickname, level FROM teams
       WHERE team_id = ? OR parent_team_id = ? ORDER BY level, team_id`
    )
    .all(orgId, orgId) as Array<{ team_id: number; name: string; nickname: string; level: number }>;
}

interface OrgPlayer {
  player_id: number;
  team_id: number;
  first_name: string;
  last_name: string;
  age: number;
  position: number;
  role: number;
  /** 0 when the save has him on no roster — signed, not yet assigned. */
  rostered: number;
  con: number | null; gap: number | null; pow: number | null; eye: number | null; avk: number | null;
  conP: number | null; gapP: number | null; powP: number | null; eyeP: number | null; avkP: number | null;
  stu: number | null; mov: number | null; ctl: number | null;
  stuP: number | null; movP: number | null; ctlP: number | null;
  spd: number | null;
  /** OOTP's own Overall and Potential, when the export carries them. */
  oa: number | null;
  potOa: number | null;
}

/** Prefer OOTP's exact grade; fall back when a save only carries the rounded one. */
const VALUE_OA = tableExists('players_value') && tableColumns('players_value').includes('oa')
  ? 'v.oa'
  : 'v.oa_rating';
const VALUE_POT = tableExists('players_value') && tableColumns('players_value').includes('pot')
  ? 'v.pot'
  : 'v.pot_rating';

function orgPlayers(orgId: number): OrgPlayer[] {
  return db
    .prepare(
      `SELECT p.player_id, p.team_id, p.first_name, p.last_name, p.age, p.position, p.role,
              b.batting_ratings_overall_contact AS con, b.batting_ratings_overall_gap AS gap,
              b.batting_ratings_overall_power AS pow, b.batting_ratings_overall_eye AS eye,
              b.batting_ratings_overall_strikeouts AS avk,
              b.batting_ratings_talent_contact AS conP, b.batting_ratings_talent_gap AS gapP,
              b.batting_ratings_talent_power AS powP, b.batting_ratings_talent_eye AS eyeP,
              b.batting_ratings_talent_strikeouts AS avkP,
              b.running_ratings_speed AS spd,
              pi.pitching_ratings_overall_stuff AS stu, pi.pitching_ratings_overall_movement AS mov,
              pi.pitching_ratings_overall_control AS ctl,
              pi.pitching_ratings_talent_stuff AS stuP, pi.pitching_ratings_talent_movement AS movP,
              pi.pitching_ratings_talent_control AS ctlP,
              ${VALUE_OA} AS oa, ${VALUE_POT} AS potOa,
              /*
               * Whether he is on a roster anywhere.
               *
               * OOTP parks a signing nobody has assigned yet on the parent
               * club's team_id with no roster entry at all, which is how a
               * dozen sixteen-year-olds out of the international complex came
               * to be listed among the major-league pitchers. Every one of the
               * thirty clubs in this save carries a few. A man actually on the
               * club appears in team_roster; these do not.
               */
              EXISTS (SELECT 1 FROM team_roster r WHERE r.player_id = p.player_id) AS rostered
       FROM players p
       LEFT JOIN players_batting b ON b.player_id = p.player_id
       LEFT JOIN players_pitching pi ON pi.player_id = p.player_id
       LEFT JOIN players_value v ON v.player_id = p.player_id
       WHERE p.organization_id = ? AND p.team_id > 0 AND p.retired = 0`
    )
    .all(orgId) as OrgPlayer[];
}

/**
 * Current ability and ceiling, as OOTP itself grades them.
 *
 * These pages used to average a player's component ratings — stuff, movement
 * and control for a pitcher; contact, gap, power, eye and avoid-K for a hitter
 * — and print the result in the same "current → potential" style the player
 * card uses for OOTP's own Overall. The two disagreed constantly, because an
 * unweighted mean of five scouted tools is not the same thing as a weighted,
 * position-aware Overall, and a user cross-checking the farm page against the
 * game found numbers that varied wildly with no way to tell why.
 *
 * OOTP's own grades are now used everywhere they are available, so the depth
 * chart, the farm pages, the roster and the player card all quote one number.
 * The old average survives only as a fallback for an export without
 * players_value, where something is better than an empty column.
 */
function composites(p: OrgPlayer): { cur: number | null; pot: number | null } {
  if (p.oa !== null && p.oa !== undefined) {
    return { cur: p.oa, pot: p.potOa ?? p.oa };
  }
  if (p.position === 1) {
    return { cur: avg([p.stu, p.mov, p.ctl]), pot: avg([p.stuP, p.movP, p.ctlP]) };
  }
  return {
    cur: avg([p.con, p.gap, p.pow, p.eye, p.avk]),
    pot: avg([p.conP, p.gapP, p.powP, p.eyeP, p.avkP]),
  };
}

orgRoutes.get('/depth-chart/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  const teams = orgTeams(orgId).map((t) => ({
    ...t,
    label: `${t.name} ${t.nickname}`,
    levelName: LEVEL_NAMES[t.level] ?? `L${t.level}`,
  }));
  const roster = orgPlayers(orgId);
  /*
   * A signing nobody has assigned yet sits on the parent club's team_id with
   * no roster entry, so the depth chart had a dozen sixteen-year-olds out of
   * the international complex standing among the major-league pitchers. They
   * belong to the organisation and not to that club, so they get a column of
   * their own rather than being hidden — every one of the thirty clubs in this
   * save has some, and quietly dropping them would lose real prospects.
   */
  const unassigned = roster.some((p) => !p.rostered);
  if (unassigned) {
    teams.push({
      team_id: UNASSIGNED_TEAM,
      name: 'Unassigned',
      nickname: '',
      level: 99,
      label: 'Unassigned',
      levelName: 'ORG',
    });
  }
  const players = roster.map((p) => {
    const { cur, pot } = composites(p);
    return {
      player_id: p.player_id,
      team_id: p.rostered ? p.team_id : UNASSIGNED_TEAM,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      position: p.position,
      role: p.role,
      cur,
      pot,
    };
  });
  res.json({ teams, players });
});

/** Aggregate latest-season stats per player (split 1 = overall). */
/**
 * OOTP keeps a drafted amateur's school season in career stats alongside his
 * professional one, under no league at all (`league_id = 0`, levels 10 and 11
 * for college and high school). Summing every row therefore credits a new
 * draftee with what he did to high schoolers — six WAR and a full season of
 * plate appearances — which sails past the promotion gates the moment he signs
 * and is assigned to an affiliate.
 *
 * Only professional lines count. In this save the two are cleanly separable:
 * every `league_id = 0` row is level 10 or 11, and no real league uses either.
 */
/**
 * One line per level, not one line per man.
 *
 * A reader wrote in about a prospect credited with "a 1.120 OPS and 21 HR in
 * just 181 PAs" at Triple-A, where he was in fact hitting .200 — all 21 home
 * runs were struck at Double-A, and the two seasons had been added together
 * and then labelled with whichever club he happened to be on. A promotion case
 * built on that is a promotion case for somebody who does not exist, and it
 * was compared against the Triple-A average as well, so the mismatch was
 * counted twice in his favour.
 *
 * Keying by level costs nothing and it is what the question means: how is he
 * doing where he is now.
 */
const statKey = (playerId: number, level: number): string => `${playerId}:${level}`;

function seasonBatting(): Map<string, Record<string, number>> {
  const t = 'players_career_batting_stats';
  const out = new Map<string, Record<string, number>>();
  if (!tableExists(t)) return out;
  const year = (db.prepare(`SELECT MAX(year) AS y FROM "${t}"`).get() as { y: number }).y;
  const rows = db
    .prepare(
      `SELECT player_id, level_id, SUM(pa) AS pa, SUM(ab) AS ab, SUM(h) AS h, SUM(d) AS d,
              SUM(t) AS t, SUM(hr) AS hr, SUM(bb) AS bb, SUM(hp) AS hp, SUM(k) AS k,
              SUM(sf) AS sf, SUM(sb) AS sb, SUM(war) AS war
       FROM "${t}" WHERE year = ? AND split_id = 1 AND league_id != 0
       GROUP BY player_id, level_id`
    )
    .all(year) as Array<Record<string, number>>;
  for (const r of rows) out.set(statKey(r.player_id, r.level_id), r);
  return out;
}

/** Professional lines only, per level, for the same reasons as {@link seasonBatting}. */
function seasonPitching(): Map<string, Record<string, number>> {
  const t = 'players_career_pitching_stats';
  const out = new Map<string, Record<string, number>>();
  if (!tableExists(t)) return out;
  const year = (db.prepare(`SELECT MAX(year) AS y FROM "${t}"`).get() as { y: number }).y;
  const rows = db
    .prepare(
      `SELECT player_id, level_id, SUM(outs) AS outs, SUM(er) AS er, SUM(bb) AS bb,
              SUM(k) AS k, SUM(bf) AS bf, SUM(ha) AS ha, SUM(g) AS g, SUM(gs) AS gs,
              SUM(war) AS war
       FROM "${t}" WHERE year = ? AND split_id = 1 AND league_id != 0
       GROUP BY player_id, level_id`
    )
    .all(year) as Array<Record<string, number>>;
  for (const r of rows) out.set(statKey(r.player_id, r.level_id), r);
  return out;
}

const ops = (s: Record<string, number>): number | null => {
  const ab = s.ab ?? 0;
  if (!ab) return null;
  const singles = s.h - s.d - s.t - s.hr;
  const obpDen = ab + s.bb + s.hp + s.sf;
  const obp = obpDen ? (s.h + s.bb + s.hp) / obpDen : 0;
  const slg = (singles + 2 * s.d + 3 * s.t + 4 * s.hr) / ab;
  return obp + slg;
};

/**
 * League-wide per-level baselines (avg age of rostered players; avg OPS / ERA / K%
 * of players with a meaningful sample), computed from THIS save's data so the
 * thresholds self-calibrate to the league environment.
 */
function levelBaselines(batting: Map<string, Record<string, number>>, pitching: Map<string, Record<string, number>>) {
  const players = db
    .prepare(
      `SELECT p.player_id, p.age, p.position, t.level FROM players p
       JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND t.level >= 1 AND t.allstar_team = 0`
    )
    .all() as Array<{ player_id: number; age: number; position: number; level: number }>;

  const acc = new Map<number, { ages: number[]; ops: number[]; era: number[]; kpct: number[] }>();
  for (const p of players) {
    if (!acc.has(p.level)) acc.set(p.level, { ages: [], ops: [], era: [], kpct: [] });
    const a = acc.get(p.level)!;
    a.ages.push(p.age);
    // The line he produced AT this level, so the level's own average is not
    // built partly out of what its players did somewhere else
    const b = batting.get(statKey(p.player_id, p.level));
    if (b && (b.pa ?? 0) >= 50) {
      const o = ops(b);
      if (o !== null) a.ops.push(o);
    }
    const pi = pitching.get(statKey(p.player_id, p.level));
    if (pi && (pi.outs ?? 0) >= 45) {
      a.era.push(((pi.er ?? 0) / (pi.outs / 3)) * 9);
      if (pi.bf > 0) a.kpct.push(pi.k / pi.bf);
    }
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((x, y) => x + y, 0) / xs.length : null);
  const out: Record<number, { avgAge: number | null; avgOps: number | null; avgEra: number | null; avgKpct: number | null }> = {};
  for (const [level, a] of acc) {
    out[level] = { avgAge: mean(a.ages), avgOps: mean(a.ops), avgEra: mean(a.era), avgKpct: mean(a.kpct) };
  }
  return out;
}


const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};

/** What calling a man up would actually cost, and whether it is worth it. */
export interface CorrespondingMove {
  /** The weakest man at his spot on the big club — the one he would displace. */
  replaces: { player_id: number; name: string; cur: number | null } | null;
  /** How many men at his spot are graded above him. */
  ahead: number;
  /** The best of the men ahead of him, for the sentence the page prints. */
  bestAhead: { player_id: number; name: string; cur: number | null } | null;
  blocked: boolean;
  note: string;
}

/**
 * Who would have to come off the big club to make room, and whether the swap
 * is an improvement.
 *
 * The farm page ranked minor leaguers against their own level and stopped
 * there, so it recommended three call-ups without once looking at the men
 * already in the majors — and a reader with a better man at every one of those
 * spots was being told to make his club worse. A promotion is a swap; naming
 * only half of it is naming none of it.
 *
 * The comparison runs on OOTP's Overall grade rather than on the season lines,
 * and that is the whole reason it can be made at all: a .900 OPS in Double-A
 * and a .900 OPS in the majors are not the same achievement, and putting them
 * in the same column would be the exact mistake this exists to prevent. The
 * grade is scouted current ability, level-independent by construction, and it
 * is the number the rest of the app already quotes.
 *
 * The bar is beating the WEAKEST man at the spot, which is the least he can be
 * asked: he is not being made a starter, he is being given a place on the
 * roster. Where the grade is missing for either man no verdict is offered at
 * all, since the alternative is a recommendation resting on a blank.
 */
function correspondingMoves(orgId: number, players: OrgPlayer[]): Map<number, CorrespondingMove> {
  const out = new Map<number, CorrespondingMove>();

  /*
   * The big club, and only men actually on a roster there. OOTP parks an
   * unassigned signing on the parent club's team_id with no roster row, and a
   * sixteen-year-old out of the international complex is not somebody a
   * call-up displaces.
   */
  const majors = players.filter((p) => p.team_id === orgId && p.rostered);
  const byPosition = new Map<number, Array<{ player_id: number; name: string; cur: number | null }>>();
  for (const m of majors) {
    const { cur } = composites(m);
    if (cur === null) continue;
    /*
     * Pitchers are grouped as pitchers rather than by rotation slot. A starter
     * and a reliever hold the same kind of place on a twenty-six-man roster,
     * and OOTP's role flag moves around often enough that splitting on it
     * would have men blocked one week and clear the next.
     */
    const spot = m.position === 1 ? 1 : m.position;
    const list = byPosition.get(spot) ?? [];
    list.push({ player_id: m.player_id, name: `${m.first_name} ${m.last_name}`, cur });
    byPosition.set(spot, list);
  }

  for (const p of players) {
    if (p.team_id === orgId) continue; // already there
    const { cur } = composites(p);
    if (cur === null) continue;
    const spot = p.position === 1 ? 1 : p.position;
    const incumbents = byPosition.get(spot);
    const where = POSITION_NAMES[spot] ?? `position ${spot}`;
    if (!incumbents || incumbents.length === 0) {
      out.set(p.player_id, {
        replaces: null, ahead: 0, bestAhead: null, blocked: false,
        note: `nobody at ${where} on the big club`,
      });
      continue;
    }
    const sorted = [...incumbents].sort((a, b) => (a.cur ?? 0) - (b.cur ?? 0));
    const weakest = sorted[0];
    const ahead = sorted.filter((m) => (m.cur ?? 0) >= cur);
    const blocked = ahead.length === incumbents.length;
    const best = sorted[sorted.length - 1];
    out.set(p.player_id, {
      replaces: blocked ? null : weakest,
      ahead: ahead.length,
      bestAhead: ahead.length > 0 ? best : null,
      blocked,
      /*
       * A grade equal to the man in the way is not a reason to move anybody, so
       * it counts as blocked — the tie goes to the roster you already have.
       */
      note: blocked
        ? incumbents.length === 1
          ? `blocked at ${where} — ${best.name} grades ${best.cur} to his ${cur}`
          : `blocked at ${where} — all ${incumbents.length} graded above him, best ${best.name} at ${best.cur} to his ${cur}`
        : `would take ${weakest.name}'s spot at ${where} — ${cur} to his ${weakest.cur}`,
    });
  }
  return out;
}

export function computeProspects(orgId: number): { batters: unknown[]; pitchers: unknown[]; baselines: unknown } {
  const batting = seasonBatting();
  const pitching = seasonPitching();
  const baselines = levelBaselines(batting, pitching);
  const teams = new Map(orgTeams(orgId).map((t) => [t.team_id, t]));

  const batters: unknown[] = [];
  const pitchers: unknown[] = [];
  const roster = orgPlayers(orgId);
  const moves = correspondingMoves(orgId, roster);

  /*
   * The bottom of the organisation, so nobody is told to send a man below it.
   * Read rather than assumed: an org may have two rookie clubs and no Single-A,
   * or a level this app has never seen, and "demote" only means something if
   * there is somewhere for him to go.
   */
  const lowestLevel = Math.max(...[...teams.values()].map((t) => t.level));

  for (const p of roster) {
    const team = teams.get(p.team_id);
    if (!team || team.level <= 1) continue; // only minor leaguers
    const base = baselines[team.level];
    if (!base) continue;
    const { cur, pot } = composites(p);
    const ageDiff = base.avgAge !== null ? base.avgAge - p.age : null;
    const common = {
      player_id: p.player_id,
      name: `${p.first_name} ${p.last_name}`,
      age: p.age,
      team: `${team.name} ${team.nickname}`,
      level: team.level,
      levelName: LEVEL_NAMES[team.level] ?? `L${team.level}`,
      cur,
      pot,
      ageDiff,
      move: moves.get(p.player_id) ?? null,
    };

    if (p.position === 1) {
      const s = pitching.get(statKey(p.player_id, team.level));
      // ~15 IP minimum, at the level he is actually pitching at. A man who has
      // just moved up has to earn the case again there rather than carry the
      // one he made below.
      if (!s || (s.outs ?? 0) < 45) continue;
      const ip = s.outs / 3;
      const era = ((s.er ?? 0) / ip) * 9;
      const kpct = s.bf > 0 ? s.k / s.bf : 0;
      const eraDiff = base.avgEra !== null ? base.avgEra - era : 0;
      const kDiff = base.avgKpct !== null ? kpct - base.avgKpct : 0;
      const reasons: string[] = [];
      if (eraDiff >= 1.0) reasons.push(`ERA ${era.toFixed(2)} vs level avg ${base.avgEra!.toFixed(2)}`);
      /*
       * The case against him, said out loud. Without this a man carried a
       * DEMOTE badge beside an empty column: the app asserting something and
       * showing nothing for it, which is the one thing every other
       * recommendation in here is careful not to do.
       */
      if (eraDiff <= -1.25) {
        reasons.push(`ERA ${era.toFixed(2)} against a level average of ${base.avgEra!.toFixed(2)}`);
        if (ageDiff !== null && ageDiff < 0) {
          reasons.push(`and ${Math.abs(ageDiff).toFixed(1)} years older than the level`);
        }
      }
      if (kDiff >= 0.05) reasons.push(`K% ${(kpct * 100).toFixed(0)} vs level avg ${(base.avgKpct! * 100).toFixed(0)}`);
      if (ageDiff !== null && ageDiff >= 1.5) reasons.push(`young for level (${p.age} vs avg ${base.avgAge!.toFixed(1)})`);
      if (cur !== null && pot !== null && pot - cur <= 5) reasons.push('near ceiling — development mostly done');
      const score = eraDiff * 12 + kDiff * 200 + (ageDiff ?? 0) * 8;
      pitchers.push({
        ...common, role: p.role, ip: Number(ip.toFixed(1)), era: Number(era.toFixed(2)),
        kpct: Number((kpct * 100).toFixed(1)), war: s.war ?? 0,
        score: Number(score.toFixed(1)), reasons,
        /*
         * Demotion asks more than promotion does, on purpose. Sending a man
         * down is the more consequential call and the easier one to get wrong,
         * so it wants a bigger gap, a longer look, and — the part that matters
         * most — a man who is not young for where he is. A nineteen-year-old
         * struggling at Double-A is on schedule; a twenty-six-year-old
         * struggling at Single-A is not the same sentence.
         */
        signal:
          eraDiff >= 1.0 && ip >= 30 ? callUp(p.player_id)
          : overmatched(eraDiff <= -1.25, ip >= 30, ageDiff, team.level) ? 'demote'
          : score > 5 ? 'watch'
          : null,
      });
    } else {
      const s = batting.get(statKey(p.player_id, team.level));
      if (!s || (s.pa ?? 0) < 60) continue;
      const o = ops(s);
      if (o === null) continue;
      const opsDiff = base.avgOps !== null ? o - base.avgOps : 0;
      const reasons: string[] = [];
      if (opsDiff >= 0.1) reasons.push(`OPS ${o.toFixed(3)} vs level avg ${base.avgOps!.toFixed(3)}`);
      // The case against him, for the same reason as the pitchers above
      if (opsDiff <= -0.1) {
        reasons.push(`OPS ${o.toFixed(3)} against a level average of ${base.avgOps!.toFixed(3)}`);
        if (ageDiff !== null && ageDiff < 0) {
          reasons.push(`and ${Math.abs(ageDiff).toFixed(1)} years older than the level`);
        }
      }
      if (ageDiff !== null && ageDiff >= 1.5) reasons.push(`young for level (${p.age} vs avg ${base.avgAge!.toFixed(1)})`);
      if (cur !== null && pot !== null && pot - cur <= 5) reasons.push('near ceiling — development mostly done');
      if (cur !== null && pot !== null && pot - cur >= 15) reasons.push('high remaining upside');
      const score = opsDiff * 300 + (ageDiff ?? 0) * 8;
      batters.push({
        ...common, pa: s.pa, opsVal: Number(o.toFixed(3)), hr: s.hr, sb: s.sb, war: s.war ?? 0,
        score: Number(score.toFixed(1)), reasons,
        signal:
          opsDiff >= 0.075 && s.pa >= 100 ? callUp(p.player_id)
          : overmatched(opsDiff <= -0.100, s.pa >= 100, ageDiff, team.level) ? 'demote'
          : score > 5 ? 'watch'
          : null,
      });
    }
  }

  /**
   * A man who has earned a promotion, and what the big club has to say about it.
   *
   * Earning it at his level is the whole of what the signal used to mean, and
   * a reader with a better man at the same spot in the majors was being told
   * to make his club worse. Where every man at his position is graded above
   * him the verdict becomes `blocked` — he is still on the page, still worth
   * knowing about for an injury or a trade, but the app stops calling for a
   * move that costs the club something.
   */
  function callUp(playerId: number): 'promote' | 'blocked' {
    return moves.get(playerId)?.blocked ? 'blocked' : 'promote';
  }

  /**
   * Clearly below his level, with enough season behind it, and not young for it.
   *
   * The sample it asks for is the same one promote asks for; the asymmetry sits
   * entirely in how big the gap has to be. That is the honest place for it —
   * the claim is what differs, not the evidence needed to look. Demanding more
   * innings as well simply hid the men the feature exists to find: a
   * twenty-six-year-old carrying a 6.95 earned run average in Single-A missed
   * the first version of this by six innings and showed no badge at all.
   */
  function overmatched(
    belowLevel: boolean, enoughPlayed: boolean, ageDiff: number | null, level: number
  ): boolean {
    if (!belowLevel || !enoughPlayed) return false;
    // Being young for the level excuses the numbers; being old for it does not
    if (ageDiff === null || ageDiff > 0) return false;
    // Nowhere below to send him
    return level < lowestLevel;
  }

  const byScore = (a: unknown, b: unknown) => (b as { score: number }).score - (a as { score: number }).score;
  batters.sort(byScore);
  pitchers.sort(byScore);
  return { batters, pitchers, baselines };
}

orgRoutes.get('/prospects/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  res.json(computeProspects(orgId));
});
