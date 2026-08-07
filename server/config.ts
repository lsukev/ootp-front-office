import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config.json');

// Minimal .env loader so users can drop ANTHROPIC_API_KEY in a gitignored file
try {
  const envText = fs.readFileSync(path.join(PROJECT_ROOT, '.env'), 'utf8');
  for (const line of envText.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch {
  // no .env file — fine
}

export interface AppConfig {
  /** Directory containing the OOTP CSV export files. */
  csvDir: string | null;
  /** Display name of the selected save. */
  saveName: string | null;
}

export function loadConfig(): AppConfig {
  try {
    return { csvDir: null, saveName: null, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { csvDir: null, saveName: null };
  }
}

export function saveConfig(config: AppConfig): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}
