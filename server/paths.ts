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

/**
 * The locations we scan, with a human label and whether each exists here.
 * Shown to the user when auto-detection finds nothing, so they know where we
 * looked before being asked to browse for the folder themselves.
 */
export function searchLocations(): Array<{ label: string; path: string; exists: boolean }> {
  const home = os.homedir();
  const mac = [
    ['OOTP 27 (Mac App Store version)', 'Library/Containers/com.ootpdevelopments.ootp27macqlm/Data/Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games'],
    ['OOTP 27 (direct download)', 'Library/Application Support/Out of the Park Developments/OOTP Baseball 27/saved_games'],
    ['OneDrive-synced saves', 'Library/CloudStorage/OneDrive-Personal/ootp/saved_games'],
  ];
  const win = [
    ['OOTP 27 (Documents)', 'Documents/Out of the Park Developments/OOTP Baseball 27/saved_games'],
    ['OOTP 27 (OneDrive Documents)', 'OneDrive/Documents/Out of the Park Developments/OOTP Baseball 27/saved_games'],
  ];
  const list = process.platform === 'win32' ? win : process.platform === 'darwin' ? mac : [...mac, ...win];
  return list.map(([label, rel]) => {
    const full = path.join(home, rel);
    return { label, path: full, exists: fs.existsSync(full) };
  });
}

const hasCsvFiles = (dir: string): number => {
  try {
    return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv')).length;
  } catch {
    return 0;
  }
};

export interface ResolveResult {
  ok: boolean;
  csvDir?: string;
  saveName?: string;
  csvCount?: number;
  /** Saves found inside the chosen folder, when it holds several. */
  saves?: SaveInfo[];
  error?: string;
}

/**
 * Turns whatever folder the user picked into a usable CSV export directory.
 * Accepts the csv folder itself, a `<save>.lg` folder, or a `saved_games`
 * folder holding many saves — people reasonably pick any of the three.
 */
export function resolveChosenFolder(input: string): ResolveResult {
  const dir = path.resolve(input.trim().replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(dir)) return { ok: false, error: `That folder does not exist:\n${dir}` };
  if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'That is a file, not a folder.' };

  // 1. The folder already holds the CSV export
  const direct = hasCsvFiles(dir);
  if (direct > 0) {
    const saveName = path.basename(path.resolve(dir, '..', '..')).replace(/\.lg$/i, '');
    return { ok: true, csvDir: dir, csvCount: direct, saveName: saveName || path.basename(dir) };
  }

  // 2. A <save>.lg folder — the export lives at import_export/csv inside it
  const inner = path.join(dir, 'import_export', 'csv');
  const innerCount = hasCsvFiles(inner);
  if (innerCount > 0) {
    return { ok: true, csvDir: inner, csvCount: innerCount, saveName: path.basename(dir).replace(/\.lg$/i, '') };
  }

  // 3. A folder containing saves — let the user pick which one
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return { ok: false, error: 'That folder could not be read (permissions?).' };
  }
  const saves: SaveInfo[] = [];
  for (const entry of entries) {
    const lg = path.join(dir, entry);
    // `.lg` on its own is a stray directory, not a save
    if (!entry.toLowerCase().endsWith('.lg') || entry === '.lg') continue;
    try {
      if (!fs.statSync(lg).isDirectory()) continue;
    } catch {
      continue;
    }
    saves.push(describeSave(lg));
  }
  if (saves.length > 0) return { ok: false, saves, error: 'Pick which save to use.' };

  if (fs.existsSync(inner)) {
    return {
      ok: false,
      error:
        'Found this save, but it has no CSV export yet.\n\n' +
        'In OOTP: Database Tools → Global Actions → Export data to CSV files, then try again.',
    };
  }
  return {
    ok: false,
    error:
      'No OOTP data found in that folder.\n\n' +
      'Choose the save folder (it ends in .lg), the folder holding your saves, ' +
      'or the import_export/csv folder itself.',
  };
}

/** Reads the CSV export state for one `<save>.lg` directory. */
function describeSave(lgPath: string): SaveInfo {
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
  return { name: path.basename(lgPath).replace(/\.lg$/i, ''), lgPath, csvDir, csvCount, csvLastModified };
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
