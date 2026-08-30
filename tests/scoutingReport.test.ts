import { describe, expect, it, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { db } from '../server/db.js';
import { clearScoutingCache, playerTransactions, scoutingReport } from '../server/playerfile.js';
import request from './request.js';
import { IDS, SEASON } from './fixture.js';

/**
 * A scouting report the export does not contain.
 *
 * "On the player cards could you include a brief scouting report transactions
 * and contract info?"
 *
 * The contract was already there. The report cannot be, in the form the request
 * implies: OOTP exports no scouting prose at all — a hundred and sixteen
 * columns on the players table and not one of them is a sentence. So it is
 * composed from his own ratings, and every line carries the rank behind it.
 *
 * The population those ranks are taken from is the whole of it. The first
 * version ranked against every rating row in the export — a hundred and
 * thirty-three thousand of them, median contact 20 — where a grade of 50 came
 * out 99th and a 40 came out 96th. Against major-league position players the
 * same two are 80th and 71st. The first reading would have told a reader that
 * an ordinary big-league bat was one of the best in the world, which is the
 * same mistake as quoting a Double-A line as though it were a major-league one.
 */

const STAR = 9970;
const ORDINARY = 9971;
const ARM = 9972;

beforeAll(() => {
  const player = db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college,
                          personality_work_ethic, personality_leader, personality_intelligence,
                          personality_greed, personality_loyalty)
     VALUES (?, 'Scout', ?, 27, ?, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0, ?, ?, 100, 100, 100)`
  );
  const bat = db.prepare(
    `INSERT INTO players_batting VALUES (?, ?, ?, ?, ?, ?, 45, 45, 45, 45, 45, 45)`
  );

  /*
   * A field of ordinary major leaguers to be ranked against. Without a
   * population there is nothing to be a percentile of, and the report says so
   * rather than inventing one.
   */
  for (let i = 0; i < 40; i++) {
    const id = 9600 + i;
    player.run(id, `Field${i}`, 7, 200 + i, IDS.mlbTeam, IDS.mlbTeam, 100, 100);
    bat.run(id, 40, 40, 40, 40, 40);
  }

  // Elite power, poor eye, and a famously hard worker
  player.run(STAR, 'Star', 7, 91, IDS.mlbTeam, IDS.mlbTeam, 190, 100);
  bat.run(STAR, 40, 40, 80, 10, 40);

  // Everything average — a man with nothing worth remarking on
  player.run(ORDINARY, 'Ordinary', 7, 92, IDS.mlbTeam, IDS.mlbTeam, 100, 100);
  bat.run(ORDINARY, 40, 40, 40, 40, 40);

  // A staff to rank him against, for the same reason the hitters have a field
  const arm = db.prepare(`INSERT INTO players_pitching VALUES (?, ?, ?, ?, 50, 50, 50, 50, 90)`);
  for (let i = 0; i < 40; i++) {
    const id = 9700 + i;
    player.run(id, `Staff${i}`, 1, 300 + i, IDS.mlbTeam, IDS.mlbTeam, 100, 100);
    arm.run(id, 40, 40, 40);
  }
  player.run(ARM, 'Arm', 1, 93, IDS.mlbTeam, IDS.mlbTeam, 100, 100);
  arm.run(ARM, 80, 40, 40);

  clearScoutingCache();
});

describe('a man with a standout tool', () => {
  it('has it named, with the rank behind it', () => {
    const r = scoutingReport(STAR, false);
    const power = r.tools.find((t) => t.label === 'Power');
    expect(power, 'his best tool went unmentioned').toBeDefined();
    expect(power!.good).toBe(true);
    expect(power!.rank).toBeGreaterThanOrEqual(75);
    expect(power!.grade).toBe(80);
  });

  it('has his weakness named too', () => {
    // A report that lists only what a man is good at is a sales pitch
    const r = scoutingReport(STAR, false);
    const eye = r.tools.find((t) => t.label === 'Eye');
    expect(eye, 'the hole in his game went unmentioned').toBeDefined();
    expect(eye!.good).toBe(false);
    expect(eye!.rank).toBeLessThanOrEqual(25);
  });

  it('leads with what he is before what he is not', () => {
    const r = scoutingReport(STAR, false);
    expect(r.tools[0].good).toBe(true);
    expect(r.tools[r.tools.length - 1].good).toBe(false);
  });

  it('mentions his makeup where it is remarkable', () => {
    expect(scoutingReport(STAR, false).makeup.join(' ')).toMatch(/works hard/);
  });
});

describe('a man with nothing remarkable about him', () => {
  it('gets no report rather than a padded one', () => {
    /*
     * Silence is the answer here. A report that fires on everybody trains a
     * reader to stop reading it.
     */
    const r = scoutingReport(ORDINARY, false);
    expect(r.tools).toHaveLength(0);
    expect(r.empty).toBe(true);
  });
});

describe('who the ranks are against', () => {
  it('is his own level and his own side of the ball', () => {
    /*
     * A pitcher's contact rating is not a hitter he competes with, and a
     * Double-A man is not up against major leaguers.
     */
    expect(scoutingReport(STAR, false).peers).toMatch(/major-league position players/);
    expect(scoutingReport(ARM, true).peers).toMatch(/major-league pitchers/);
  });

  it('is said on the page, because a percentile is meaningless without it', () => {
    const modal = fs.readFileSync(path.join(process.cwd(), 'src/playerModal.tsx'), 'utf8');
    expect(modal).toMatch(/OOTP exports no written scouting/);
    expect(modal).toMatch(/scouting\.peers/);
  });

  it('reports a pitcher on pitching tools, not batting ones', () => {
    const r = scoutingReport(ARM, true);
    expect(r.tools.map((t) => t.label)).toContain('Stuff');
    expect(r.tools.map((t) => t.label)).not.toContain('Power');
  });
});

describe('a level with nobody to rank against', () => {
  it('says nothing rather than ranking a man against four people', () => {
    // A percentile drawn from a handful of players is a number pretending
    const r = scoutingReport(IDS.optioned, false);
    expect(r.tools).toHaveLength(0);
  });
});

describe('how he got here', () => {
  beforeAll(() => {
    db.prepare(
      `INSERT INTO trade_history (date, summary, message_id, team_id_0, team_id_1,
                                  player_id_0_0, player_id_1_0)
       VALUES (?, ?, 900, ?, ?, ?, 0)`
    ).run(
      `${SEASON}-7-4`,
      `The <Other Club:team#${IDS.otherMlbTeam}> trade <Scout Star:player#${STAR}> to the ` +
        `<Test Nine:team#${IDS.mlbTeam}>.`,
      IDS.otherMlbTeam, IDS.mlbTeam, STAR
    );
  });

  it('lists the trades he was part of', () => {
    const t = playerTransactions(STAR);
    expect(t.length).toBeGreaterThan(0);
    expect(t[0].kind).toBe('trade');
    expect(t[0].plain).toMatch(/Scout Star/);
  });

  it('keeps the names linkable rather than flattening them to text', () => {
    // The same markup the transactions page parses, so a name opens a card
    const t = playerTransactions(STAR);
    expect(t[0].summary.some((s) => s.kind === 'player' && s.id === STAR)).toBe(true);
  });

  it('says nothing for a man nothing has happened to', () => {
    expect(playerTransactions(ORDINARY)).toHaveLength(0);
  });

  it('reaches the card', async () => {
    const d = await request(`/api/player/${STAR}`);
    expect(d.transactions.length).toBeGreaterThan(0);
    expect(d.scouting.tools.length).toBeGreaterThan(0);
  });
});
