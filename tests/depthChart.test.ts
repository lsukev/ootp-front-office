import { describe, expect, it, beforeAll } from 'vitest';
import { db } from '../server/db.js';
import request from './request.js';
import { IDS } from './fixture.js';

/**
 * Who belongs in which column of the depth chart.
 *
 * A user reported sixteen-year-olds from the international complex standing
 * among his major-league pitchers, and they were: OOTP parks a signing nobody
 * has assigned yet on the parent club's team_id with no roster entry at all,
 * and the chart grouped purely on that id. Every one of the thirty clubs in
 * the save being tested against carried a few, ages fifteen to eighteen.
 *
 * Roster membership is the signal, and it is clean — a man actually on a club
 * appears in team_roster, these appear nowhere. They are given a column rather
 * than dropped, because they are real players in the organisation and hiding
 * them would trade a visible fault for an invisible one.
 */

const SIGNED_NOT_ASSIGNED = 8100;

beforeAll(() => {
  // A sixteen-year-old carrying the major-league club's id and on no roster,
  // exactly as the export writes an unassigned international signing
  db.prepare(
    `INSERT INTO players (player_id, first_name, last_name, age, position, role, bats, throws,
                          uniform_number, team_id, organization_id, retired, hidden,
                          draft_eligible, college)
     VALUES (?, 'Complex', 'Kid', 16, 6, 0, 1, 1, 0, ?, ?, 0, 0, 0, 0)`
  ).run(SIGNED_NOT_ASSIGNED, IDS.mlbTeam, IDS.mlbTeam);
});

describe('the depth chart', () => {
  it('keeps a signing nobody has assigned out of the major-league column', async () => {
    const chart = await request(`/api/depth-chart/${IDS.mlbTeam}`);
    const inMlb = chart.players.filter(
      (p: { team_id: number }) => p.team_id === IDS.mlbTeam
    );
    expect(inMlb.some((p: { player_id: number }) => p.player_id === SIGNED_NOT_ASSIGNED)).toBe(false);
  });

  it('does not lose him — he is a real player in the organisation', async () => {
    const chart = await request(`/api/depth-chart/${IDS.mlbTeam}`);
    const him = chart.players.find(
      (p: { player_id: number }) => p.player_id === SIGNED_NOT_ASSIGNED
    );
    expect(him, 'the unassigned signing vanished from the chart entirely').toBeDefined();
    expect(him.team_id).toBe(-1);
  });

  it('gives him a column that says what he is', async () => {
    const chart = await request(`/api/depth-chart/${IDS.mlbTeam}`);
    const column = chart.teams.find((t: { team_id: number }) => t.team_id === -1);
    expect(column).toBeDefined();
    expect(column.label).toMatch(/unassigned/i);
  });

  it('leaves the men who are on the club where they were', async () => {
    const chart = await request(`/api/depth-chart/${IDS.mlbTeam}`);
    const inMlb = chart.players.filter((p: { team_id: number }) => p.team_id === IDS.mlbTeam);
    expect(inMlb.length).toBeGreaterThan(0);
    expect(inMlb.some((p: { player_id: number }) => p.player_id === IDS.starter)).toBe(true);
  });

  it('offers no such column to a club with nobody in that state', async () => {
    // The other club has no unassigned signings, and an empty column is clutter
    const chart = await request(`/api/depth-chart/${IDS.otherMlbTeam}`);
    expect(chart.teams.some((t: { team_id: number }) => t.team_id === -1)).toBe(false);
  });
});
