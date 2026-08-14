import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import { mlbPercentiler, valuesByPlayer } from '../server/valuation.js';
import { IDS } from './fixture.js';

/**
 * Who counts as a major leaguer, when a percentile is being taken.
 *
 * The Value and Talent figures are ranks against a field, so the field is the
 * whole measurement. It was every player carrying a major-league club's id,
 * and OOTP parks a signing nobody has assigned yet on the parent club with no
 * roster entry at all — the same thing that once put sixteen-year-olds from
 * the international complex in the major-league column of the depth chart.
 *
 * In the save this was found in, 29 of the 309 arms being called major-league
 * relievers averaged twenty years old, a stuff rating of 26 and a value of 254
 * against the real men's 841. A yardstick partly made of children reads long:
 * every genuine major leaguer's percentile was too high, worst at the bottom
 * of the league where a replacement-level arm was being told he was ahead of
 * eight per cent of the majors when he was ahead of none of them.
 */

const REAL = 8300;
const UNASSIGNED = 8301;

const addPlayer = (id: number, value: number, rostered: boolean): void => {
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Pool', ?, ?, 6, 0, 1, 1, ?, ?, ?, 0, 0, 0, 0)`
  ).run(id, `Man${id}`, rostered ? 27 : 16, id - 8000, IDS.mlbTeam, IDS.mlbTeam);
  db.prepare(
    `INSERT INTO players_value
       (player_id, overall_value, talent_value, offensive_value, offensive_value_vsl,
        offensive_value_vsr, pitching_value, oa_rating, pot_rating, oa, pot)
     VALUES (?, ?, ?, 100, 100, 100, 0, 50, 50, 50, 50)`
  ).run(id, value, value);
  if (rostered) {
    db.prepare(
      `INSERT INTO players_roster_status
         (player_id, is_active, is_on_dl, is_on_dl60, is_on_secondary,
          mlb_service_years, mlb_service_days, mlb_service_days_this_year)
       VALUES (?, 1, 0, 0, 0, 3.0, ?, 40)`
    ).run(id, 3 * 172);
  }
};

beforeAll(() => {
  // One real major leaguer at the bottom of the pile, and a crowd of
  // unassigned teenagers beneath him, exactly as the export writes them
  addPlayer(REAL, 120, true);
  for (let i = 0; i < 12; i++) addPlayer(UNASSIGNED + i, 10 + i, false);
});

describe('the pool a percentile is taken against', () => {
  it('leaves out players who are on no roster', () => {
    const pct = mlbPercentiler(valuesByPlayer()).overallPct(REAL);
    expect(pct).not.toBeNull();
    /*
     * He is the worst major leaguer in the fixture, so he should be at or very
     * near the floor. With the teenagers counted he sat above all twelve of
     * them and read as comfortably better than a tenth of the league.
     */
    expect(pct as number).toBeLessThan(10);
  });

  it('still ranks a man who is on a roster', () => {
    expect(mlbPercentiler(valuesByPlayer()).overallPct(IDS.starter)).not.toBeNull();
  });
});
