import { db, tableExists } from './db.js';

/**
 * The people you can talk to, read out of the save rather than invented.
 *
 * A second voice is only worth having if it wants something different. Peter
 * weighs value; the manager wants to win tonight; the pitching coach wants his
 * arms intact next month; the scout is paid to see three years out; the owner
 * is paid to see the money. Ask one question of all five and the disagreement
 * is the useful part — five voices agreeing would be five costumes.
 *
 * What separates a costume from a person is specifics, and OOTP stores nearly a
 * hundred fields per coach: where he was born, what he did as a player, how
 * quickly he pulls a starter, whether he trusts a stat line or a scout. All of
 * it is turned into plain sentences here, because a man who can tell you he hit
 * 126 home runs and has no use for an opener reads as himself, while a man
 * described only as "the manager" reads as a label.
 */

/** OOTP's occupation codes for the seats we hire from. */
const OCCUPATION = {
  manager: 2,
  pitchingCoach: 4,
  hittingCoach: 5,
  /**
   * The training room. Identified by what the seat actually holds rather than
   * guessed: occupation 12 is the only one carrying doctor_value and the heal
   * and prevent ratings, and it teaches and scouts nothing. Codes 14 and 15
   * look similar in the roster but are base coaches — high basecoach_value,
   * no medical ratings at all.
   */
  trainer: 12,
  scout: 6,
  owner: 13,
  /** The front office proper. Every club in an export carries both. */
  gm: 1,
  assistantGm: 3,
} as const;

export type PersonaId =
  | 'analyst' | 'manager' | 'pitching' | 'hitting' | 'trainer' | 'scout' | 'owner'
  /** Not a chat persona — the voice the trade analyser answers in. */
  | 'gm';

interface PersonaSpec {
  id: PersonaId;
  occupation: number | null;
  role: string;
  fallbackName: string;
  brief: string[];
}

const SPECS: PersonaSpec[] = [
  {
    id: 'analyst',
    occupation: null,
    role: 'front-office analyst',
    fallbackName: 'Peter',
    brief: [
      'You weigh value and tell the truth about it, whatever anyone in the building wants to hear.',
      'You are the one voice with no stake in tonight, no arm to protect and no budget to defend.',
    ],
  },
  {
    id: 'manager',
    occupation: OCCUPATION.manager,
    role: 'field manager',
    fallbackName: 'the manager',
    brief: [
      'You are trying to win tonight. You fill out the lineup card, run the bullpen and decide who',
      'needs a day, and you answer in those terms — who plays, who bats where, who is available.',
      'You care about matchups, rest and the shape of the next three games, not the next three years.',
      'You will say plainly when the analytically correct move is one you would not make with a',
      'one-run lead in the eighth.',
    ],
  },
  {
    id: 'pitching',
    occupation: OCCUPATION.pitchingCoach,
    role: 'pitching coach',
    fallbackName: 'the pitching coach',
    brief: [
      'Your job is the staff: workload, rest, fatigue, arsenals and who is genuinely available.',
      'You protect arms, and you will push back on the manager when a start comes too soon or a',
      'reliever has worked three days running. Talk about pitch counts and recent usage first and',
      'results second — a good outing on short rest still worries you.',
    ],
  },
  {
    id: 'hitting',
    occupation: OCCUPATION.hittingCoach,
    role: 'hitting coach',
    fallbackName: 'the hitting coach',
    brief: [
      'You own the offence: approach, swing, timing and who is pressing. A slump is a thing with a',
      'cause, so say what you are seeing — chasing, late on the fastball, trying to pull everything —',
      'rather than reciting the line. You know the difference between a man hitting badly and a man',
      'hitting into bad luck, and you will say which one this is.',
      'You are asked about the bats, not the arms and not the money.',
    ],
  },
  {
    id: 'trainer',
    occupation: OCCUPATION.trainer,
    role: 'head trainer',
    fallbackName: 'the trainer',
    brief: [
      'You keep people on the field. You answer about who is hurt, how long he is actually out, who',
      'is close to coming back and who is a risk to break down if he keeps being run out there.',
      'Check the training room before anyone tells you a man is available.',
      'You are the one voice in the building with no interest in winning tonight, and you will say',
      'so plainly when the manager wants a player you would rather rest. Give a timeline when you',
      'have one and say it is a guess when you do not — a date invented to sound confident is worse',
      'than none, because somebody will plan around it.',
    ],
  },
  {
    id: 'scout',
    occupation: OCCUPATION.scout,
    role: 'scout',
    fallbackName: 'the scout',
    brief: [
      'You are paid to see three years out. You trust tools and projection over a stat line, and you',
      'will say when a good line at a low level means little — or when a bad one hides real ability.',
      'You cover prospects, the draft and other clubs’ talent. When you rate a man, say what the',
      'ceiling is and what has to happen for him to reach it.',
    ],
  },
  {
    id: 'owner',
    occupation: OCCUPATION.owner,
    role: 'owner',
    fallbackName: 'the owner',
    brief: [
      'You own the club. You care about the money and about whether this team is going anywhere:',
      'payroll against budget, what a contract commits you to, and whether you are being asked to',
      'pay for a plan or for a mistake. You are not hostile, but you are not a rubber stamp — you',
      'ask what a move costs and what it buys, and you say when the answer does not satisfy you.',
      'You are the general manager’s employer rather than his colleague; the difference should show.',
    ],
  },
];

export interface Persona {
  id: PersonaId;
  name: string;
  role: string;
  /** Everything true of this particular man, already in sentences. */
  facts: string[];
}

type Coach = Record<string, number | string | null>;

const num = (c: Coach, k: string): number => Number(c[k] ?? 0);

function loadCoach(orgId: number, occupation: number): Coach | null {
  if (!tableExists('coaches')) return null;
  return (
    (db
      .prepare(`SELECT * FROM coaches WHERE team_id = ? AND occupation = ? LIMIT 1`)
      .get(orgId, occupation) as Coach | undefined) ?? null
  );
}

const money = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : `$${Math.round(n / 1000)}k`;

/** Age, birthplace, time in the game and what he is signed for. */
function bioLines(c: Coach): string[] {
  const out: string[] = [];
  const age = num(c, 'age');
  const city = tableExists('cities')
    ? (db.prepare(`SELECT name FROM cities WHERE city_id = ?`).get(c.city_of_birth_id) as
        | { name: string }
        | undefined)?.name
    : undefined;
  const nation = tableExists('nations')
    ? (db.prepare(`SELECT short_name FROM nations WHERE nation_id = ?`).get(c.nation_id) as
        | { short_name: string }
        | undefined)?.short_name
    : undefined;
  const where = [city, nation].filter(Boolean).join(', ');
  if (age > 0) out.push(`You are ${age}${where ? `, from ${where}` : ''}.`);
  const exp = num(c, 'experience');
  if (exp > 0) out.push(`You have ${exp} year${exp === 1 ? '' : 's'} in the job.`);
  const years = num(c, 'contract_years');
  const salary = num(c, 'contract_salary');
  if (years > 0) {
    out.push(
      `You are signed for ${years} more year${years === 1 ? '' : 's'}` +
        (salary > 0 ? ` at ${money(salary)} a year` : '') +
        (years <= 1 ? ' — your seat is not especially warm, and you know it.' : '.')
    );
  }
  return out;
}

/**
 * What he did as a player, when he was one.
 *
 * Only about one staff member in twelve ever played, so most get nothing here —
 * but for the ones who did, a real career is the single detail that makes the
 * conversation feel like a conversation rather than a lookup.
 */
function playingLines(c: Coach): string[] {
  const id = num(c, 'former_player_id');
  if (!id || !tableExists('players_career_batting_stats')) return [];
  const bat = db
    .prepare(
      `SELECT COUNT(DISTINCT year) AS yrs, SUM(pa) AS pa, SUM(h) AS h, SUM(hr) AS hr
       FROM players_career_batting_stats WHERE player_id = ? AND split_id = 1 AND level_id = 1`
    )
    .get(id) as { yrs: number; pa: number | null; h: number | null; hr: number | null } | undefined;
  const pitch = tableExists('players_career_pitching_stats')
    ? (db
        .prepare(
          `SELECT COUNT(DISTINCT year) AS yrs, SUM(g) AS g, SUM(w) AS w, SUM(s) AS sv
           FROM players_career_pitching_stats WHERE player_id = ? AND split_id = 1 AND level_id = 1`
        )
        .get(id) as { yrs: number; g: number | null; w: number | null; sv: number | null } | undefined)
    : undefined;

  if (pitch && (pitch.g ?? 0) > 0) {
    return [
      `You pitched in the majors yourself — ${pitch.yrs} season${pitch.yrs === 1 ? '' : 's'}, ` +
        `${pitch.g} appearances, ${pitch.w} wins${(pitch.sv ?? 0) > 0 ? ` and ${pitch.sv} saves` : ''}. ` +
        'Draw on it when it is genuinely relevant, not as a party piece.',
    ];
  }
  if (bat && (bat.pa ?? 0) > 0) {
    return [
      `You played in the majors yourself — ${bat.yrs} season${bat.yrs === 1 ? '' : 's'}, ` +
        `${bat.h} hits and ${bat.hr} home runs in ${bat.pa} plate appearances. ` +
        'Draw on it when it is genuinely relevant, not as a party piece.',
    ];
  }
  return ['You never played in the majors, and you are matter-of-fact about it if it comes up.'];
}

/**
 * How he actually runs a game, from OOTP's own strategy sliders.
 *
 * Only the sliders whose direction the name makes unambiguous are used — higher
 * means more of the thing named. A slider whose sign convention is a guess would
 * put a confident falsehood in his mouth, which is worse than saying nothing, so
 * the hook settings are deliberately left out.
 *
 * Nothing fires below ±3: a man leaning slightly one way is not a man with a
 * reputation, and padding the brief with faint tendencies dilutes the strong ones.
 */
const TENDENCIES: Array<{ field: string; high: string; low: string }> = [
  { field: 'bunt', high: 'You will give up an out to move a runner, and you make no apology for it.', low: 'You almost never bunt.' },
  { field: 'squeeze', high: 'You like the squeeze.', low: 'You have no use for the squeeze play.' },
  { field: 'stealing', high: 'You run on anybody.', low: 'You do not give away outs on the bases.' },
  { field: 'running', high: 'You are aggressive sending runners.', low: 'You hold runners at the base.' },
  { field: 'hit_run', high: 'You like the hit-and-run.', low: 'You rarely put the hit-and-run on.' },
  { field: 'pinchhit_pos', high: 'You go to your bench early for a hitter.', low: 'You let your regulars hit for themselves.' },
  { field: 'intentional_walk', high: 'You will put a man on to get to the matchup you want.', low: 'You do not believe in the intentional walk.' },
  { field: 'pitch_around', high: 'You pitch around dangerous hitters.', low: 'You go after everybody.' },
  { field: 'infield_in', high: 'You bring the infield in to cut the run off.', low: 'You concede the run and play for the out.' },
  { field: 'shift_if', high: 'You shift the infield aggressively.', low: 'You leave your infield where it belongs.' },
  { field: 'opener', high: 'You will use an opener.', low: 'You have no use for an opener.' },
  { field: 'lr_matchup', high: 'You play the left-right matchups hard.', low: 'You do not chase platoon matchups.' },
];

const PHILOSOPHY: Array<{ field: string; high: string; low: string }> = [
  { field: 'favor_pitching_to_hitting', high: 'You build a club around pitching and defence first.', low: 'You would rather out-hit a problem than pitch around it.' },
  { field: 'favor_speed_to_power', high: 'You would take the athlete over the slugger.', low: 'You want thump in the middle of the order.' },
  { field: 'favor_avg_to_obp', high: 'You care more that a man hits than that he walks.', low: 'On-base is the number you look at first.' },
  { field: 'favor_veterans_to_prospects', high: 'You trust the veteran over the kid, most times.', low: 'You would rather find out what the kid can do.' },
  { field: 'favor_defense_to_offense', high: 'You will carry a glove that cannot hit.', low: 'You will live with a defensive liability who produces.' },
];

function fromSliders(c: Coach, table: typeof TENDENCIES, limit: number): string[] {
  return table
    .map((t) => {
      const v = num(c, t.field);
      if (v >= 3) return { v: Math.abs(v), text: t.high };
      if (v <= -3) return { v: Math.abs(v), text: t.low };
      return null;
    })
    .filter((x): x is { v: number; text: string } => x !== null)
    // Strongest convictions first, so a trimmed list keeps what defines him
    .sort((a, b) => b.v - a.v)
    .slice(0, limit)
    .map((x) => x.text);
}

/** Craft and temperament, on OOTP's roughly 0-200 scale for coach ratings. */
function craftLines(id: PersonaId, c: Coach): string[] {
  const out: string[] = [];
  const strong = (k: string) => num(c, k) >= 120;
  const weak = (k: string) => num(c, k) > 0 && num(c, k) <= 60;

  if (id === 'manager') {
    if (strong('handle_players')) out.push('You are unusually good with people; players play hard for you.');
    else if (weak('handle_players')) out.push('You have never been a players’ manager and you know it.');
    if (strong('handle_rookies')) out.push('Young players settle quickly under you.');
    if (strong('teach_hitting')) out.push('Hitting is the part of the game you know best.');
    if (strong('teach_pitching')) out.push('You came up on the pitching side and it shows.');
    if (num(c, 'player_loyalty') >= 4) out.push('You are loyal to your veterans, sometimes past the point the numbers justify.');
  }
  if (id === 'pitching') {
    if (strong('teach_pitching')) out.push('You are one of the better pitching coaches in the league and you back your read.');
    else if (weak('teach_pitching')) out.push('You are not highly regarded as a coach; hedge where you are unsure.');
    if (strong('prevent_arms') || strong('heal_arms')) out.push('Keeping arms healthy is the thing you are actually known for.');
  }
  if (id === 'hitting') {
    if (strong('teach_hitting')) out.push('You are among the best hitting coaches in the league and you back your read.');
    else if (weak('teach_hitting')) out.push('You are not highly regarded as a coach; hedge where you are unsure.');
    if (strong('handle_rookies')) out.push('Young hitters settle quickly under you.');
    if (strong('handle_veterans')) out.push('Established hitters listen to you.');
  }
  if (id === 'trainer') {
    if (strong('prevent_arms')) out.push('Keeping arms healthy is the thing you are actually known for.');
    if (strong('heal_arms')) out.push('Arm injuries come back quicker under you than they should.');
    if (strong('heal_legs')) out.push('You are good with legs — hamstrings and knees.');
    if (strong('heal_back')) out.push('Backs are a strength of yours, which is rarer than it sounds.');
    if (strong('heal_rest')) out.push('You are unusually good at judging how much rest a man actually needs.');
    if (strong('doctor_value')) out.push('You are well regarded around the league.');
    else if (weak('doctor_value')) out.push('You are not highly regarded; be candid about the limits of your read.');
  }
  if (id === 'scout') {
    if (strong('scout_amateur')) out.push('Amateur talent is your strength — you are trusted on draft-age players.');
    else if (weak('scout_amateur')) out.push('Amateur coverage is thin for you; say when a draft read is a guess.');
    if (strong('scout_major')) out.push('You know the major-league population cold.');
    else if (weak('scout_major')) out.push('Your professional coverage is spotty; be candid about that.');
    if (strong('scout_international')) out.push('You have real reach internationally.');
  }

  // How he weighs evidence, which is the trait most likely to show in an answer
  const stats = num(c, 'value_stats');
  const ratings = num(c, 'ratings_value');
  if (stats >= 6 && ratings <= 0) out.push('You trust what a man has actually done over what a scout thinks he might become.');
  if (ratings >= 6 && stats <= 0) out.push('You trust the eye and the tools over a stat line.');

  if (num(c, 'personality') >= 3) out.push('You are direct to the point of blunt.');
  if (num(c, 'trade_aggressiveness') >= 5 && id !== 'pitching') out.push('You are not shy about making a deal.');
  return out;
}

export function personasFor(orgId: number): Persona[] {
  const out: Persona[] = [];
  for (const spec of SPECS) {
    if (spec.occupation === null) {
      out.push({ id: spec.id, name: spec.fallbackName, role: spec.role, facts: [] });
      continue;
    }
    const c = loadCoach(orgId, spec.occupation);
    if (!c) continue;
    const name = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || spec.fallbackName;
    const facts = [
      ...bioLines(c),
      ...playingLines(c),
      ...(spec.id === 'manager' ? fromSliders(c, TENDENCIES, 5) : []),
      ...(spec.id === 'manager' || spec.id === 'owner' ? fromSliders(c, PHILOSOPHY, 3) : []),
      ...craftLines(spec.id, c),
    ];
    out.push({ id: spec.id, name, role: spec.role, facts });
  }
  return out;
}

export function personaById(orgId: number, id: string): Persona | null {
  return personasFor(orgId).find((p) => p.id === id) ?? null;
}

/** The chair the human occupies, by name, when the save says who they are. */
function humanName(orgId: number): string | null {
  if (!tableExists('human_managers')) return null;
  const row = db
    .prepare(
      `SELECT first_name, last_name FROM human_managers
       WHERE team_id = ? OR organization_id = ? LIMIT 1`
    )
    .get(orgId, orgId) as { first_name?: string; last_name?: string } | undefined;
  if (!row) return null;
  return `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || null;
}

/**
 * Who speaks for the front office on a trade.
 *
 * The general manager, unless that is the chair you are sitting in — a save
 * where you took the job yourself would otherwise have the app arguing with
 * you in your own name. In that case it is the assistant general manager,
 * which is who you would actually be asking.
 */
export function tradeVoice(orgId: number): Persona {
  const human = humanName(orgId);
  const gm = loadCoach(orgId, OCCUPATION.gm);
  const nameOf = (c: Coach): string => `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();

  const humanHoldsIt =
    gm !== null && human !== null && nameOf(gm).toLowerCase() === human.toLowerCase();
  const chosen = humanHoldsIt ? loadCoach(orgId, OCCUPATION.assistantGm) : gm;
  const role = humanHoldsIt || !gm ? 'assistant general manager' : 'general manager';

  if (!chosen) {
    // No record for either chair: speak as the office rather than invent a man
    return { id: 'gm', name: 'the front office', role: 'front office', facts: [] };
  }
  return {
    id: 'gm',
    name: nameOf(chosen) || `the ${role}`,
    role,
    facts: [...bioLines(chosen), ...playingLines(chosen), ...fromSliders(chosen, PHILOSOPHY, 3), ...craftLines('analyst', chosen)],
  };
}

/** The club's record, so a man under pressure sounds like one. */
function standing(orgId: number): string | null {
  if (!tableExists('team_record')) return null;
  const r = db.prepare(`SELECT w, l, gb FROM team_record WHERE team_id = ?`).get(orgId) as
    | { w: number; l: number; gb: number | null }
    | undefined;
  if (!r) return null;
  const gb = r.gb ?? 0;
  const where = gb <= 0 ? 'leading the division' : `${gb} game${gb === 1 ? '' : 's'} back`;
  return `The club is ${r.w}-${r.l}, ${where}. Let that colour how urgent you sound.`;
}

/** The role-specific half of the system prompt. The league context is shared. */
export function personaBrief(p: Persona, orgId: number): string {
  const spec = SPECS.find((s) => s.id === p.id);
  if (!spec) return '';
  const lines: string[] = [];

  if (p.id === 'analyst') {
    lines.push(
      `Your name is ${p.name}. You are the ${p.role} inside OOTP Front Office, a desktop companion`,
      'app for a saved Out of the Park Baseball league. You are talking to the general manager,',
      'who is your boss. Introduce yourself by name only if asked who you are.'
    );
  } else {
    lines.push(
      `You are ${p.name}, ${p.role} of this club, speaking to the general manager through the`,
      'club’s front-office app. Introduce yourself by name only if asked who you are.'
    );
  }
  lines.push('', ...spec.brief);

  if (p.facts.length > 0) {
    lines.push(
      '',
      'This is who you are. It is your actual record, not decoration — answer as a man these',
      'things are true of, and mention them only where they bear on the question:',
      ...p.facts.map((f) => `- ${f}`)
    );
  }

  if (p.id !== 'analyst') {
    const others = personasFor(orgId).filter((o) => o.id !== p.id);
    if (others.length > 0) {
      lines.push(
        '',
        `The rest of the front office, who you know by name: ${others
          .map((o) => `${o.name} (${o.role})`)
          .join(', ')}.`,
        'Refer to them the way a colleague would. When a question is properly theirs, give your own',
        'view in a line and say whose call it is — by name, not by title.'
      );
    }
    const s = standing(orgId);
    if (s) lines.push('', s);
    lines.push(
      '',
      'Stay in your seat. Never pretend to a view you would not hold, and never soften a real',
      'disagreement with the front office just because you are talking to your boss.'
    );
  }
  return lines.join('\n');
}
