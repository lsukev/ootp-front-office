import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DATA_DIR } from './config.js';
import { db, tableExists } from './db.js';

/**
 * Writes the app out as a static website.
 *
 * Everything the pages read is a GET, so an export is just a crawl: fetch each
 * endpoint from the running server, save the body at a path a static host can
 * serve, and drop the built frontend beside it. The crawl deliberately goes
 * through HTTP rather than calling the route handlers directly — that way the
 * exported JSON is byte-identical to what the live app serves, and no endpoint
 * can drift into having two implementations.
 */

export const exportRoutes = Router();

/**
 * Flattens an API URL into a filename a static host will serve. Query strings
 * are folded into the name because a static host ignores them — the same
 * function runs in the browser (see exportPath in src/api.ts) so the two always
 * agree on where a file lives.
 */
export const exportPath = (url: string): string =>
  url.replace(/^\/?api\//, '').replace(/[?&=]/g, '_');

interface ExportResult {
  outDir: string;
  files: number;
  bytes: number;
  players: number;
  warnings: string[];
}

async function fetchApi(port: string, url: string): Promise<{ ok: boolean; buf: Buffer }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/${url.replace(/^\//, '')}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { ok: res.ok, buf };
}

/**
 * Runs a job over every item with a fixed number in flight.
 *
 * A full class is around 2,400 player cards and each one costs roughly 0.4s of
 * database work, so fetching them one at a time turns the export into a
 * twenty-five minute wait. The pool is deliberately modest: the work is all
 * against one local SQLite file, and stampeding it is not faster.
 */
async function pooled<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        await fn(items[next++]);
      }
    })
  );
}

/** Every player_id anywhere in an exported payload, so no card 404s. */
function collectPlayerIds(json: unknown, into: Set<number>): void {
  if (Array.isArray(json)) {
    for (const v of json) collectPlayerIds(v, into);
  } else if (json && typeof json === 'object') {
    for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
      if (k === 'player_id' && typeof v === 'number') into.add(v);
      else collectPlayerIds(v, into);
    }
  }
}

export async function exportSite(orgId: number): Promise<ExportResult> {
  const port = process.env.OOTP_FO_PORT;
  if (!port) throw new Error('Server port unknown');

  const org = db.prepare(`SELECT abbr, name FROM teams WHERE team_id = ?`).get(orgId) as
    | { abbr: string | null; name: string }
    | undefined;
  if (!org) throw new Error('Unknown team');

  const dist = path.join(APP_ROOT, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    throw new Error('The built frontend is missing — run the app from a normal install.');
  }

  const stamp = (db.prepare(`SELECT "current_date" AS d FROM leagues WHERE league_id =
      (SELECT league_id FROM teams WHERE team_id = ?)`).get(orgId) as { d: string } | undefined)?.d;
  const slug = `${(org.abbr ?? org.name).replace(/[^A-Za-z0-9]/g, '')}-${(stamp ?? 'export').replace(/[^0-9]/g, '')}`;
  const outDir = path.join(DATA_DIR, 'site-export', slug);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'api'), { recursive: true });

  const warnings: string[] = [];
  let files = 0;
  let bytes = 0;

  const write = (rel: string, buf: Buffer): void => {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    files += 1;
    bytes += buf.length;
  };

  const payloads: unknown[] = [];
  const grab = async (url: string, collect = true): Promise<void> => {
    const { ok, buf } = await fetchApi(port, url);
    if (!ok) {
      warnings.push(`${url} returned an error and was skipped`);
      return;
    }
    write(path.join('api', exportPath(url)), buf);
    if (!collect) return;
    try {
      payloads.push(JSON.parse(buf.toString('utf8')));
    } catch {
      // Binary (a logo) — nothing to walk for player ids
    }
  };

  // ── Org-wide pages ────────────────────────────────────────────────────
  for (const p of [
    'orgs', `dashboard/${orgId}`, `standings/${orgId}`, `contracts/${orgId}`, `payroll/${orgId}`,
    `depth-chart/${orgId}`, `prospects/${orgId}`, `development/${orgId}`, `draft/${orgId}`,
    `injuries/${orgId}`, `leaderboards/${orgId}`, `roster-crunch/${orgId}`, `staff/${orgId}`,
    `free-agents/${orgId}`, `storylines/${orgId}`, `briefing/${orgId}`, `trade/fits/${orgId}`,
    `next-game/${orgId}`, `pitching/${orgId}`, `schedule/${orgId}`, `trends/${orgId}`,
  ]) {
    await grab(p);
  }

  // Lineup is the one page with options, and a static host drops query strings,
  // so every combination gets its own file
  for (const vs of ['r', 'l']) {
    for (const style of ['saber', 'trad']) {
      for (const dh of ['auto', 'on', 'off']) {
        await grab(`lineup/${orgId}?vs=${vs}&style=${style}&dh=${dh}`);
      }
    }
  }

  // ── Every team in the organization ────────────────────────────────────
  const teams = db
    .prepare(`SELECT team_id FROM teams WHERE team_id = ? OR parent_team_id = ?`)
    .all(orgId, orgId) as Array<{ team_id: number }>;
  for (const t of teams) {
    await grab(`roster/${t.team_id}`);
    await grab(`pitching/${t.team_id}`);
  }

  // ── Logos for anything that might be shown ────────────────────────────
  const logoTeams = db
    .prepare(
      `SELECT team_id FROM teams WHERE league_id =
         (SELECT league_id FROM teams WHERE team_id = ?) OR parent_team_id = ?`
    )
    .all(orgId, orgId) as Array<{ team_id: number }>;
  await pooled(logoTeams, 8, async (t) => {
    const { ok, buf } = await fetchApi(port, `logo/${t.team_id}`);
    if (ok && buf.length > 0) write(path.join('api', exportPath(`logo/${t.team_id}`)), buf);
  });

  // ── Player cards for everyone named anywhere in the export ────────────
  const ids = new Set<number>();
  for (const p of payloads) collectPlayerIds(p, ids);
  await pooled([...ids], 8, (id) => grab(`player/${id}`, false));

  // ── Status, flagged so the app knows it is a snapshot ─────────────────
  const { buf: statusBuf } = await fetchApi(port, 'status');
  const status = JSON.parse(statusBuf.toString('utf8')) as Record<string, unknown>;
  status.exportedSite = true;
  status.exportedAt = new Date().toISOString();
  write(path.join('api', 'status'), Buffer.from(JSON.stringify(status)));

  // ── The frontend itself ───────────────────────────────────────────────
  for (const entry of fs.readdirSync(dist, { withFileTypes: true, recursive: true }) as fs.Dirent[]) {
    if (!entry.isFile()) continue;
    const from = path.join(entry.parentPath ?? dist, entry.name);
    write(path.relative(dist, from), fs.readFileSync(from));
  }

  return { outDir, files, bytes, players: ids.size, warnings };
}

exportRoutes.post('/export-site/:orgId', async (req, res) => {
  if (!tableExists('players')) return res.status(400).json({ error: 'No data imported yet' });
  try {
    res.json(await exportSite(Number(req.params.orgId)));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
