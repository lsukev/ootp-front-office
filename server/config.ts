import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Two distinct roots:
 *
 *  APP_ROOT  — where bundled read-only assets live (the built frontend). Inside a
 *              packaged desktop app this is within the app bundle and NOT writable.
 *  DATA_DIR  — where everything we write goes (databases, caches, config, .env).
 *              Electron points this at the OS user-data directory; in plain `npm
 *              run dev` it defaults to ./data alongside the source.
 */

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export const APP_ROOT = process.env.OOTP_FO_APP_ROOT
  ? path.resolve(process.env.OOTP_FO_APP_ROOT)
  : path.resolve(moduleDir, '..');

export const DATA_DIR = process.env.OOTP_FO_DATA_DIR
  ? path.resolve(process.env.OOTP_FO_DATA_DIR)
  : path.join(APP_ROOT, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

/** @deprecated Use APP_ROOT for assets or DATA_DIR for writable files. */
export const PROJECT_ROOT = APP_ROOT;

const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
/** Older versions kept config.json in the project root — migrate it once. */
const LEGACY_CONFIG_PATH = path.join(APP_ROOT, 'config.json');

// Minimal .env loader. Checks the writable data directory first so a packaged
// app's user can drop a key beside their data without touching the app bundle.
for (const envPath of [path.join(DATA_DIR, '.env'), path.join(APP_ROOT, '.env')]) {
  try {
    const envText = fs.readFileSync(envPath, 'utf8');
    for (const line of envText.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // no .env at this location — fine
  }
}

export interface AppConfig {
  /** Directory containing the OOTP CSV export files. */
  csvDir: string | null;
  /** Display name of the selected save. */
  saveName: string | null;
}

export function loadConfig(): AppConfig {
  for (const p of [CONFIG_PATH, LEGACY_CONFIG_PATH]) {
    try {
      return { csvDir: null, saveName: null, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch {
      // try the next location
    }
  }
  return { csvDir: null, saveName: null };
}

export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
