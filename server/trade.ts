import { Router } from 'express';
import { db, tableExists } from './db.js';
import { contractsByPlayer, mlbPercentiler, valuesByPlayer, type PlayerValue } from './valuation.js';

export const tradeRoutes = Router();

const POSITION_NAMES: Record<number, string> = {
  1: 'P', 2: 'C', 3: '1B', 4: '2B', 5: '3B', 6: 'SS', 7: 'LF', 8: 'CF', 9: 'RF', 10: 'DH',
};
const FIELD_SPOTS = [2, 3, 4, 5, 6, 7, 8, 9];
const teamLabel = `CASE WHEN t.name = t.nickname THEN t.name ELSE t.name || ' ' || t.nickname END`;

interface OrgProfile {
  orgId: number;
  label: string;
  weakest: Array<{ position: number; positionName: string; bestValue: number }>;
  surplus: Array<{ position: number; positionName: string; players: Array<{ player_id: number; name: string; value: number }> }>;
}

let mlbMedianCache: number | null = null;
function mlbMedianValue(values: Map<number, PlayerValue>): number {
  if (mlbMedianCache !== null) return mlbMedianCache;
  const ids = db
    .prepare(
      `SELECT p.player_id FROM players p JOIN teams t ON t.team_id = p.team_id
       WHERE t.level = 1 AND t.allstar_team = 0 AND p.retired = 0`
    )
    .all() as Array<{ player_id: number }>;
  const vals = ids
    .map((r) => values.get(r.player_id)?.overall)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
  mlbMedianCache = vals.length ? vals[Math.floor(vals.length / 2)] : 0;
  return mlbMedianCache;
}

/**
 * Positional strength/surplus for one org's MLB club. Surplus requires a
 * quality backup (within 85% of the starter AND above the MLB median) —
 * two equally weak players at a spot is a hole, not depth.
 */
function orgProfile(orgId: number, values: Map<number, PlayerValue>): OrgProfile | null {
  const team = db.prepare(`SELECT ${teamLabel} AS label FROM teams t WHERE team_id = ?`).get(orgId) as
    | { label: string }
    | undefined;
  if (!team) return null;
  const players = db
    .prepare(
      `SELECT player_id, first_name || ' ' || last_name AS name, position
       FROM players WHERE team_id = ? AND retired = 0 AND position != 1`
    )
    .all(orgId) as Array<{ player_id: number; name: string; position: number }>;

  const byPos = new Map<number, Array<{ player_id: number; name: string; value: number }>>();
  for (const p of players) {
    const v = values.get(p.player_id)?.overall ?? 0;
    if (!byPos.has(p.position)) byPos.set(p.position, []);
    byPos.get(p.position)!.push({ player_id: p.player_id, name: p.name, value: v });
  }
  const strength = FIELD_SPOTS.map((pos) => {
    const ps = (byPos.get(pos) ?? []).sort((a, b) => b.value - a.value);
    return { position: pos, positionName: POSITION_NAMES[pos], best: ps[0]?.value ?? 0, players: ps };
  });
  const weakest = [...strength]
    .sort((a, b) => a.best - b.best)
    .slice(0, 3)
    .map((s) => ({ position: s.position, positionName: s.positionName, bestValue: s.best }));
  const median = mlbMedianValue(values);
  const surplus = strength
    .filter((s) => s.players.length >= 2 && s.players[1].value >= Math.max(s.best * 0.85, median))
    .map((s) => ({ position: s.position, positionName: s.positionName, players: s.players.slice(1, 3) }));
  return { orgId, label: team.label, weakest, surplus };
}

tradeRoutes.get('/trade/fits/:orgId', (req, res) => {
  const orgId = Number(req.params.orgId);
  if (!tableExists('players_value')) return res.status(400).json({ error: 'No data imported yet' });
  const values = valuesByPlayer();
  const mine = orgProfile(orgId, values);
  if (!mine) return res.status(404).json({ error: 'Unknown org' });

  const otherOrgs = (
    db
      .prepare(
        `SELECT team_id FROM teams WHERE level = 1 AND allstar_team = 0 AND team_id != ?`
      )
      .all(orgId) as Array<{ team_id: number }>
  ).map((r) => r.team_id);

  const myWeak = new Set(mine.weakest.map((w) => w.position));
  const mySurplusPos = new Set(mine.surplus.map((s) => s.position));

  const fits = otherOrgs
    .map((id) => orgProfile(id, values))
    .filter((p): p is OrgProfile => p !== null)
    .map((theirs) => {
      // They're weak where I have surplus; they have surplus where I'm weak
      const theyNeed = theirs.weakest.filter((w) => mySurplusPos.has(w.position));
      const theyOffer = theirs.surplus.filter((s) => myWeak.has(s.position));
      return {
        orgId: theirs.orgId,
        label: theirs.label,
        score: theyNeed.length + theyOffer.length,
        theyNeed: theyNeed.map((w) => ({
          positionName: w.positionName,
          myCandidates: mine.surplus.find((s) => s.position === w.position)?.players ?? [],
        })),
        theyOffer: theyOffer.map((s) => ({ positionName: s.positionName, players: s.players })),
      };
    })
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score);

  res.json({ myWeakest: mine.weakest, mySurplus: mine.surplus, fits: fits.slice(0, 10) });
});

tradeRoutes.get('/search-players', (req, res) => {
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2 || !tableExists('players')) return res.json([]);
  const rows = db
    .prepare(
      `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
              ${teamLabel} AS team, t.level
       FROM players p LEFT JOIN teams t ON t.team_id = p.team_id
       WHERE p.retired = 0 AND p.team_id > 0
         AND (p.first_name || ' ' || p.last_name) LIKE ?
       ORDER BY t.level, p.age LIMIT 20`
    )
    .all(`%${q}%`) as Array<Record<string, unknown>>;
  const values = valuesByPlayer();
  res.json(
    rows.map((r) => ({
      ...r,
      positionName: POSITION_NAMES[r.position as number] ?? '?',
      value: values.get(r.player_id as number)?.overall ?? 0,
    }))
  );
});

export interface TradeSideSummary {
  players: Array<{
    player_id: number; name: string; age: number; positionName: string; team: string | null;
    overallPct: number | null; talentPct: number | null; salaryNow: number; yearsAfterThis: number;
  }>;
  totalValue: number;
  totalTalent: number;
  totalSalary: number;
}

export function summarizeSide(ids: number[]): TradeSideSummary {
  const values = valuesByPlayer();
  const { overallPct, talentPct } = mlbPercentiler(values);
  const contracts = contractsByPlayer();
  let totalValue = 0;
  let totalTalent = 0;
  let totalSalary = 0;
  const players = ids
    .map((id) => {
      const p = db
        .prepare(
          `SELECT p.player_id, p.first_name || ' ' || p.last_name AS name, p.age, p.position,
                  ${teamLabel} AS team
           FROM players p LEFT JOIN teams t ON t.team_id = p.team_id WHERE p.player_id = ?`
        )
        .get(id) as Record<string, unknown> | undefined;
      if (!p) return null;
      const v = values.get(id);
      const c = contracts.get(id);
      totalValue += v?.overall ?? 0;
      totalTalent += v?.talent ?? 0;
      totalSalary += c?.salaryNow ?? 0;
      return {
        player_id: id,
        name: p.name as string,
        age: p.age as number,
        positionName: POSITION_NAMES[p.position as number] ?? '?',
        team: (p.team as string) ?? null,
        overallPct: overallPct(id),
        talentPct: talentPct(id),
        salaryNow: c?.salaryNow ?? 0,
        yearsAfterThis: c?.yearsAfterThis ?? 0,
      };
    })
    .filter(Boolean) as TradeSideSummary['players'];
  return { players, totalValue, totalTalent, totalSalary };
}

tradeRoutes.post('/trade/analyze', (req, res) => {
  const { sideA, sideB } = req.body as { sideA: number[]; sideB: number[] };
  if (!Array.isArray(sideA) || !Array.isArray(sideB)) {
    return res.status(400).json({ error: 'sideA and sideB arrays required' });
  }
  const a = summarizeSide(sideA);
  const b = summarizeSide(sideB);
  res.json({
    sideA: a,
    sideB: b,
    valueDiff: a.totalValue - b.totalValue,
    talentDiff: a.totalTalent - b.totalTalent,
    salaryDiff: a.totalSalary - b.totalSalary,
  });
});
