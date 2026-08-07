/**
 * Bundles the Electron main process and the Express server into a single CJS
 * file for packaging.
 *
 * Only our own source is bundled — every runtime dependency stays external so
 * electron-builder ships them from node_modules. That avoids bundling surprises
 * with packages that use dynamic requires, and is required for better-sqlite3,
 * which is a native module that cannot be inlined.
 */
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

await build({
  entryPoints: ['electron/main.ts'],
  outfile: 'build/main.cjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external,
  sourcemap: true,
  logLevel: 'info',
  // The server modules are ESM and read import.meta.url; CJS output has no
  // import.meta, so shim it from __filename.
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: { 'import.meta.url': 'import_meta_url' },
});
