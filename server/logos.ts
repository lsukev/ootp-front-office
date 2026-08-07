import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { db, tableExists } from './db.js';
import { loadConfig } from './config.js';

export const logoRoutes = Router();

/**
 * OOTP writes team logos into the save at
 *   <save>.lg/news/html/images/team_logos/<logo_file_name>
 * Using these instead of fetching from the web keeps the app offline-capable
 * and correct for custom/fictional leagues, which have no logo on the internet.
 */
function logoDir(): string | null {
  const { csvDir } = loadConfig();
  if (!csvDir) return null;
  // csvDir is <save>.lg/import_export/csv — walk up to the save root
  const saveRoot = path.resolve(csvDir, '..', '..');
  const dir = path.join(saveRoot, 'news', 'html', 'images', 'team_logos');
  return fs.existsSync(dir) ? dir : null;
}

/** Guard against a malicious logo_file_name escaping the logo directory. */
function safeJoin(dir: string, name: string): string | null {
  const resolved = path.resolve(dir, name);
  return resolved.startsWith(path.resolve(dir) + path.sep) ? resolved : null;
}

logoRoutes.get('/logo/:teamId', (req, res) => {
  const dir = logoDir();
  if (!dir || !tableExists('teams')) return res.status(404).end();

  const row = db.prepare(`SELECT logo_file_name FROM teams WHERE team_id = ?`).get(Number(req.params.teamId)) as
    | { logo_file_name: string | null }
    | undefined;
  if (!row?.logo_file_name) return res.status(404).end();

  // Optional size variant: OOTP ships <name>_50.png, _110.png, etc.
  const size = String(req.query.size ?? '');
  const base = row.logo_file_name.replace(/\.png$/i, '');
  const candidates = size ? [`${base}_${size}.png`, row.logo_file_name] : [row.logo_file_name];

  for (const candidate of candidates) {
    const file = safeJoin(dir, candidate);
    if (file && fs.existsSync(file)) {
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.sendFile(file);
    }
  }
  res.status(404).end();
});
