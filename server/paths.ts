import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SaveInfo {
  name: string;
  lgPath: string;
  csvDir: string;
  csvCount: number;
  csvLastModified: string | null;
}

/** Known locations for OOTP 27 saved_games folders, per platform. */
function saveGameRoots(): string[] {
  const home = os.homedir();
  const roots = [
    // Mac App Store (sandboxed) build
    path.join(
      home,
      'Library/Containers/com.ootpdevelopments.ootp27macqlm/Data/Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games'
    ),
    // Direct Mac build
    path.join(home, 'Library/Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games'),
    // Windows
    path.join(home, 'Documents/Out of the Park Developments/OOTP Baseball 27/saved_games'),
    // OneDrive-synced installs
    path.join(home, 'Library/CloudStorage/OneDrive-Personal/ootp/saved_games'),
    path.join(home, 'OneDrive/Documents/Out of the Park Developments/OOTP Baseball 27/saved_games'),
  ];
  return roots.filter((r) => fs.existsSync(r));
}

export function detectSaves(): SaveInfo[] {
  const saves: SaveInfo[] = [];
  for (const root of saveGameRoots()) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.lg') || entry === '.lg') continue;
      const lgPath = path.join(root, entry);
      if (!fs.statSync(lgPath).isDirectory()) continue;
      const csvDir = path.join(lgPath, 'import_export', 'csv');
      let csvCount = 0;
      let csvLastModified: string | null = null;
      if (fs.existsSync(csvDir)) {
        const csvs = fs.readdirSync(csvDir).filter((f) => f.endsWith('.csv'));
        csvCount = csvs.length;
        let latest = 0;
        for (const f of csvs) {
          const mtime = fs.statSync(path.join(csvDir, f)).mtimeMs;
          if (mtime > latest) latest = mtime;
        }
        if (latest > 0) csvLastModified = new Date(latest).toISOString();
      }
      saves.push({ name: entry.replace(/\.lg$/, ''), lgPath, csvDir, csvCount, csvLastModified });
    }
  }
  return saves;
}
