import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { assembleContext } from '../server/storylines.js';
import { IDS } from './fixture.js';

/**
 * What Storylines is told about a season line.
 *
 * A reader reported a storyline setting his closer against another reliever
 * where one line was major-league and the other Triple-A — a comparison the
 * prose presented as like for like. The cause was in the query rather than the
 * model: a career line carries a row per level a man played at this year, and
 * summing them without a level filter blends a call-up's minor-league work
 * into his major-league numbers. In the save this was reproduced against, Ryan
 * Weathers read as a 4.91 ERA that was neither his 5.89 up here nor his 3.34
 * down there.
 *
 * So the club's own level is filtered for, and the level is named in the
 * context besides — the prospects travelling alongside carry minor-league
 * lines by their nature, and the model should not have to infer which is which.
 */

const CALLUP = 8200;
const YEAR = 2030;

beforeAll(() => {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Split', 'Season', 25, 1, 12, 1, 1, 71, ?, ?, 0, 0, 0, 0)`
  ).run(CALLUP, IDS.mlbTeam, IDS.mlbTeam);

  const line = db.prepare(
    `INSERT INTO players_career_pitching_stats
       (player_id, year, team_id, league_id, level_id, split_id, outs, er, ra, ha, bb, k,
        hra, hp, bf, g, gs, w, l, s, hld, war)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 0, ?, 0, 0, 0, 20, 0, 0, 0, 0, 0, 1.0)`
  );
  // 30 innings up here at a 6.00 ERA, 30 down there at 1.50 — nothing about
  // either is a 3.75, which is what summing them produces
  line.run(CALLUP, YEAR, IDS.mlbTeam, IDS.league, 1, 90, 20, 30);
  line.run(CALLUP, YEAR, IDS.aaaTeam, IDS.league, 2, 90, 5, 40);
});

describe('the season lines Storylines is given', () => {
  const context = () => assembleContext(IDS.mlbTeam) as {
    statsLevel: string;
    pitchingLeaders: { level: string; players: Array<Record<string, number | string>> };
    battingLeaders: { level: string; players: unknown[] };
  };

  it('says which level the numbers are', () => {
    const c = context();
    expect(c.statsLevel).toBe('MLB');
    expect(c.pitchingLeaders.level).toBe('MLB');
    expect(c.battingLeaders.level).toBe('MLB');
  });

  it('does not blend a call-up’s two levels into one line', () => {
    const him = context().pitchingLeaders.players.find((p) => p.name === 'Split Season');
    expect(him, 'the split-season pitcher is missing from the leaders').toBeDefined();
    // 30 innings and a 6.00, not 60 innings and a 3.75
    expect(Number(him!.ip)).toBeCloseTo(30, 1);
    expect(Number(him!.era)).toBeCloseTo(6.0, 1);
  });

  it('reports the innings actually thrown at that level', () => {
    const him = context().pitchingLeaders.players.find((p) => p.name === 'Split Season')!;
    expect(Number(him.ip)).toBeLessThan(60);
  });
});
