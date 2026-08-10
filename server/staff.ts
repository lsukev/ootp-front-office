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
 * They are real staff with real ratings, so what OOTP thinks of a man shapes
 * what he says. A manager who leans on the bunt says so; a scout rated 170 at
 * amateur coverage speaks with a confidence a poorly-rated one has not earned.
 */

/** OOTP's occupation codes for the seats we hire from. */
const OCCUPATION = {
  manager: 2,
  pitchingCoach: 4,
  scout: 6,
  owner: 13,
} as const;

export type PersonaId = 'analyst' | 'manager' | 'pitching' | 'scout' | 'owner';

interface PersonaSpec {
  id: PersonaId;
  /** Seat in the organisation, or null for Peter, who is the app itself. */
  occupation: number | null;
  role: string;
  /** Shown on the tab when the save has nobody in the seat. */
  fallbackName: string;
  /** What this person is trying to achieve, which is what makes him worth asking. */
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
  /** Traits worth putting in the prompt, already in words. */
  traits: string[];
}

interface CoachRow {
  first_name: string;
  last_name: string;
  teach_hitting: number | null;
  teach_pitching: number | null;
  scout_major: number | null;
  scout_amateur: number | null;
  favor_pitching_to_hitting: number | null;
  bunt_hit: number | null;
  hit_run: number | null;
  player_loyalty: number | null;
  personality: number | null;
}

const COACH_FIELDS =
  `first_name, last_name, teach_hitting, teach_pitching, scout_major, scout_amateur,
   favor_pitching_to_hitting, bunt_hit, hit_run, player_loyalty, personality`;

function coachInSeat(orgId: number, occupation: number): CoachRow | null {
  if (!tableExists('coaches')) return null;
  return (
    (db
      .prepare(`SELECT ${COACH_FIELDS} FROM coaches WHERE team_id = ? AND occupation = ? LIMIT 1`)
      .get(orgId, occupation) as CoachRow | undefined) ?? null
  );
}

/**
 * Turns a coach's numbers into sentences he could say about himself.
 *
 * OOTP's coach ratings run roughly 0-200 rather than the 20-80 scale used for
 * players, and the strategy sliders are signed preferences centred on zero.
 * Only traits that actually distinguish him are mentioned — a middling number
 * says nothing and would just pad the prompt.
 */
function traitsFor(id: PersonaId, c: CoachRow): string[] {
  const out: string[] = [];
  const strong = (v: number | null) => (v ?? 0) >= 120;
  const weak = (v: number | null) => (v ?? 0) > 0 && (v ?? 0) <= 60;

  if (id === 'manager') {
    if ((c.favor_pitching_to_hitting ?? 0) >= 4) out.push('You build a club around pitching and defence first.');
    if ((c.favor_pitching_to_hitting ?? 0) <= -4) out.push('You would rather out-hit a problem than pitch around it.');
    if ((c.bunt_hit ?? 0) >= 3) out.push('You like the bunt more than the numbers say you should, and you know it.');
    if ((c.hit_run ?? 0) >= 3) out.push('You will put runners in motion.');
    if (strong(c.teach_hitting)) out.push('Hitting is the part of the game you know best.');
    if (strong(c.teach_pitching)) out.push('You came up on the pitching side and it shows.');
    if ((c.player_loyalty ?? 0) >= 3) out.push('You are loyal to your veterans, sometimes past the point the numbers justify.');
  }
  if (id === 'pitching') {
    if (strong(c.teach_pitching)) out.push('You are one of the better pitching coaches in the league and you back your read.');
    if (weak(c.teach_pitching)) out.push('You are not a highly regarded coach; hedge where you are unsure.');
  }
  if (id === 'scout') {
    if (strong(c.scout_amateur)) out.push('Amateur talent is your strength — you are trusted on draft-age players.');
    if (weak(c.scout_amateur)) out.push('Amateur coverage is thin for you; say when a draft read is a guess.');
    if (strong(c.scout_major)) out.push('You know the major-league population cold.');
    if (weak(c.scout_major)) out.push('Your professional coverage is spotty; be candid about that.');
  }
  if ((c.personality ?? 0) >= 3) out.push('You are direct to the point of blunt.');
  return out;
}

/**
 * Everyone available to talk on this club. A seat the save has not filled is
 * simply left out rather than given an invented name — the point of using the
 * real staff is that they are real.
 */
export function personasFor(orgId: number): Persona[] {
  const out: Persona[] = [];
  for (const spec of SPECS) {
    if (spec.occupation === null) {
      out.push({ id: spec.id, name: spec.fallbackName, role: spec.role, traits: [] });
      continue;
    }
    const c = coachInSeat(orgId, spec.occupation);
    if (!c) continue;
    out.push({
      id: spec.id,
      name: `${c.first_name} ${c.last_name}`.trim() || spec.fallbackName,
      role: spec.role,
      traits: traitsFor(spec.id, c),
    });
  }
  return out;
}

export function personaById(orgId: number, id: string): Persona | null {
  return personasFor(orgId).find((p) => p.id === id) ?? null;
}

/** The role-specific half of the system prompt. The league context is shared. */
export function personaBrief(p: Persona): string {
  const spec = SPECS.find((s) => s.id === p.id);
  if (!spec) return '';
  const lines = [
    p.id === 'analyst'
      ? `Your name is ${p.name}. You are the ${p.role} inside OOTP Front Office, a desktop companion`
      : `You are ${p.name}, ${p.role} of this club, speaking to the general manager through the`,
    p.id === 'analyst'
      ? 'app for a saved Out of the Park Baseball league. You are talking to the general manager,'
      : 'club’s front-office app. Introduce yourself by name only if asked who you are.',
    ...(p.id === 'analyst' ? ['who is your boss. Introduce yourself by name only if asked who you are.'] : []),
    '',
    ...spec.brief,
  ];
  if (p.traits.length > 0) {
    lines.push('', 'What you are actually like, from your own record:', ...p.traits.map((t) => `- ${t}`));
  }
  if (p.id !== 'analyst') {
    lines.push(
      '',
      'Stay in your seat. Another voice in this app covers the numbers in depth, and the others',
      'cover their own ground — when a question is really for one of them, give your own view in a',
      'line and say whose call it properly is. Never pretend to a view you would not hold.'
    );
  }
  return lines.join('\n');
}
