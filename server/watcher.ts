import chokidar, { type FSWatcher } from 'chokidar';

let watcher: FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
/** When a fresh export was last seen on disk, if it has not been imported yet. */
let pendingSince: string | null = null;

/**
 * Watches the CSV export directory and notes when OOTP writes a fresh export.
 *
 * It deliberately does not import. Importing is synchronous and takes tens of
 * seconds on a full league, so doing it the moment a file changed froze the app
 * without warning, in the middle of whatever the user was reading. The app now
 * offers the refresh and lets them take it when they are ready.
 *
 * Debounced because OOTP writes ~70 files over several seconds.
 */
export function pendingExport(): string | null {
  return pendingSince;
}

/** Called once an import has consumed whatever was on disk. */
export function clearPendingExport(): void {
  pendingSince = null;
}

export function stopWatcher(): void {
  if (debounce) clearTimeout(debounce);
  void watcher?.close();
  watcher = null;
  pendingSince = null;
  console.log('[watch] stopped — new exports will not be detected');
}

export function startWatcher(csvDir: string): void {
  void watcher?.close();
  watcher = chokidar
    .watch(csvDir, { ignoreInitial: true, depth: 0 })
    /*
     * A watcher with no error handler takes the whole server down with it.
     * Observed while OOTP was writing an export: the operating system
     * interrupted the watch on one of seventy files, chokidar emitted 'error',
     * nothing was listening, and the app died mid-session — over a directory
     * whose only purpose is to notice a file has changed. Noticing late is a
     * far smaller problem than that.
     */
    .on('error', (err) => {
      console.error('[watch] stopped watching after an error:', err);
    })
    .on('all', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      pendingSince = new Date().toISOString();
      console.log('[watch] fresh CSV export detected — offering a refresh');
    }, 3000);
  });
  console.log(`[watch] Watching ${csvDir}`);
}
