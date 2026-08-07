import chokidar, { type FSWatcher } from 'chokidar';

let watcher: FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

/**
 * Watch the CSV export directory and re-import when OOTP writes a fresh
 * export. Debounced because OOTP writes ~60 files over several seconds.
 */
export function stopWatcher(): void {
  if (debounce) clearTimeout(debounce);
  void watcher?.close();
  watcher = null;
  console.log('[watch] stopped — auto re-import is off');
}

export function startWatcher(csvDir: string): void {
  void watcher?.close();
  // Imported lazily at call time to avoid a circular import with api.ts
  watcher = chokidar
    .watch(csvDir, { ignoreInitial: true, depth: 0 })
    .on('all', () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const { runImport } = await import('./api.js');
        console.log('[watch] CSV export changed — re-importing');
        runImport(csvDir);
      }, 3000);
    });
  console.log(`[watch] Watching ${csvDir}`);
}
