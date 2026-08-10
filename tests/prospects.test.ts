import { describe, expect, it } from 'vitest';
import request from './request';
import { IDS } from './fixture';

/**
 * OOTP stores a drafted amateur's school season in the same career table as his
 * professional one, filed under no league at all. Counting it credits a new
 * draftee with what he did to schoolboys — a full season of plate appearances
 * and a WAR no minor leaguer touches — which is enough to clear the promotion
 * gates the day he signs.
 */
describe('a just-signed high-school draftee', () => {
  it('is not flagged for promotion on his school numbers', async () => {
    const d = await request(`/api/prospects/${IDS.mlbTeam}`);
    const all = [...d.batters, ...d.pitchers] as Array<{ player_id: number; signal: string | null }>;
    const him = all.find((p) => p.player_id === IDS.draftee);
    // He has no professional line at all, so he should not be rated yet —
    // and certainly not told to pack for the majors
    expect(him?.signal ?? null).toBeNull();
  });

  it('keeps his school season off his card, which is a professional record', async () => {
    const card = await request(`/api/player/${IDS.draftee}`);
    expect(card.battingYears ?? []).toHaveLength(0);
  });
});
