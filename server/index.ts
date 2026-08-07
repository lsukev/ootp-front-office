import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { api, runImport } from './api.js';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { startWatcher } from './watcher.js';
import { tableExists } from './db.js';
import { snapshotDates, takeSnapshot } from './history.js';

const app = express();
app.use(express.json());
app.use('/api', api);

// In production, serve the built frontend
const dist = path.join(PROJECT_ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

const PORT = 5178;
app.listen(PORT, () => {
  console.log(`[server] http://localhost:${PORT}`);
  const config = loadConfig();
  if (config.csvDir && fs.existsSync(config.csvDir)) {
    // Import on boot if we have no data yet, then watch for fresh exports
    if (!tableExists('players')) runImport(config.csvDir);
    startWatcher(config.csvDir);
    // Ensure development tracking has a baseline for already-imported data
    try {
      if (tableExists('players') && snapshotDates().length === 0) takeSnapshot();
    } catch (err) {
      console.error('[history] baseline snapshot failed:', err);
    }
  }
});
