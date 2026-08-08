import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { api, runImport } from './api.js';
import { APP_ROOT, loadConfig } from './config.js';
import { startWatcher } from './watcher.js';
import { tableExists } from './db.js';
import { snapshotDates, takeSnapshot } from './history.js';
import { loadSettings } from './settings.js';

/** Import on boot if needed, then watch for fresh OOTP exports. */
function bootstrapData(): void {
  const config = loadConfig();
  if (!config.csvDir || !fs.existsSync(config.csvDir)) return;
  if (!tableExists('players')) runImport(config.csvDir);
  if (loadSettings().autoImport) startWatcher(config.csvDir);
  try {
    // Ensure development tracking has a baseline for already-imported data
    if (tableExists('players') && snapshotDates().length === 0) takeSnapshot();
  } catch (err) {
    console.error('[history] baseline snapshot failed:', err);
  }
}

/**
 * Starts the API (and, when built, the frontend) and resolves with the port.
 * Pass port 0 to let the OS pick a free one — the desktop app does this so it
 * never collides with another copy or an unrelated service.
 */
export function startServer(port = 5178): Promise<number> {
  const app = express();
  app.use(express.json());
  app.use('/api', api);

  const dist = path.join(APP_ROOT, 'dist');
  if (fs.existsSync(dist)) {
    app.use(express.static(dist));
    app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, '127.0.0.1');
    server.once('error', reject);
    server.once('listening', () => {
      const actual = (server.address() as AddressInfo).port;
      // The chat tools read the app's own endpoints so the assistant sees
      // exactly what the UI shows, rather than a second implementation.
      process.env.OOTP_FO_PORT = String(actual);
      console.log(`[server] http://localhost:${actual}`);
      bootstrapData();
      resolve(actual);
    });
  });
}

// Running directly (npm run dev / npm start) rather than embedded in Electron
if (!process.env.OOTP_FO_EMBEDDED) {
  startServer(Number(process.env.PORT) || 5178).catch((err) => {
    console.error('[server] failed to start:', err);
    process.exit(1);
  });
}
