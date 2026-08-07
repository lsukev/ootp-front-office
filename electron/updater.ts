import { app, BrowserWindow, ipcMain, shell } from 'electron';
import type { UpdateInfo } from 'electron-updater';

/**
 * Auto-update against GitHub releases.
 *
 * Deliberately consent-first: the app checks quietly in the background and
 * tells the renderer what it found, but never downloads or restarts on its
 * own. A coach mid-season should not have the app swap itself out from under
 * them, and the download is ~120 MB.
 *
 * The feed URL comes from app-update.yml, which electron-builder bakes into
 * Resources from the `publish` block in electron-builder.yml.
 */

export type UpdateState =
  | { status: 'unsupported'; version: string; reason: string }
  | { status: 'idle'; version: string }
  | { status: 'checking'; version: string }
  | { status: 'current'; version: string; checkedAt: string }
  | { status: 'available'; version: string; newVersion: string; notes: string | null; releaseUrl: string }
  | { status: 'downloading'; version: string; newVersion: string; percent: number }
  | { status: 'ready'; version: string; newVersion: string }
  | { status: 'error'; version: string; message: string };

const RELEASES_URL = 'https://github.com/lsukev/ootp-front-office/releases';

let state: UpdateState;
let checking = false;

const currentVersion = (): string => app.getVersion();

function broadcast(next: UpdateState): void {
  state = next;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', next);
  }
}

/**
 * GitHub release notes are markdown. The updater panel renders plain text, so
 * strip the handful of constructs that actually show up in generated notes
 * rather than pulling in a markdown parser for a sidebar.
 */
function plainNotes(notes: UpdateInfo['releaseNotes']): string | null {
  const raw =
    typeof notes === 'string'
      ? notes
      : Array.isArray(notes)
        ? notes.map((n) => n.note ?? '').join('\n\n')
        : null;
  if (!raw) return null;
  const text = raw
    .replace(/<[^>]+>/g, '')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  return text.length > 0 ? text.slice(0, 4000) : null;
}

export function initUpdater(): void {
  // In dev there is no packaged app to replace, and electron-updater throws
  // rather than no-oping. Surface that as a state the UI can explain.
  if (!app.isPackaged) {
    state = {
      status: 'unsupported',
      version: currentVersion(),
      reason: 'Updates apply to the installed app. This is a development build.',
    };
    registerIpc(null);
    return;
  }

  // Imported lazily so a dev run never loads it
  const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  state = { status: 'idle', version: currentVersion() };

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    checking = false;
    broadcast({
      status: 'available',
      version: currentVersion(),
      newVersion: info.version,
      notes: plainNotes(info.releaseNotes),
      releaseUrl: `${RELEASES_URL}/tag/v${info.version}`,
    });
  });

  autoUpdater.on('update-not-available', () => {
    checking = false;
    broadcast({ status: 'current', version: currentVersion(), checkedAt: new Date().toISOString() });
  });

  autoUpdater.on('download-progress', (p: { percent: number }) => {
    const newVersion = state.status === 'downloading' || state.status === 'available' ? state.newVersion : '';
    broadcast({
      status: 'downloading',
      version: currentVersion(),
      newVersion,
      percent: Math.round(p.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    broadcast({ status: 'ready', version: currentVersion(), newVersion: info.version });
  });

  autoUpdater.on('error', (err: Error) => {
    checking = false;
    // Being offline is the common case and is not worth alarming anyone over
    const message = /net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(err.message)
      ? 'Could not reach GitHub to check for updates. You are probably offline.'
      : err.message;
    broadcast({ status: 'error', version: currentVersion(), message });
  });

  registerIpc(autoUpdater);

  // One quiet check shortly after launch, once the window has settled. Failures
  // land in the `error` state and are only visible if the user goes looking.
  setTimeout(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, 8000);
}

function registerIpc(autoUpdater: typeof import('electron-updater').autoUpdater | null): void {
  ipcMain.handle('update:state', () => state);

  ipcMain.handle('update:check', async () => {
    if (!autoUpdater) return state;
    if (checking) return state;
    checking = true;
    broadcast({ status: 'checking', version: currentVersion() });
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      checking = false;
      broadcast({
        status: 'error',
        version: currentVersion(),
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return state;
  });

  ipcMain.handle('update:download', async () => {
    if (!autoUpdater || state.status !== 'available') return state;
    broadcast({ status: 'downloading', version: currentVersion(), newVersion: state.newVersion, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      broadcast({
        status: 'error',
        version: currentVersion(),
        message: err instanceof Error ? err.message : String(err),
      });
    }
    return state;
  });

  ipcMain.handle('update:install', () => {
    if (!autoUpdater || state.status !== 'ready') return;
    // isSilent=false so the Windows installer UI shows; isForceRunAfter=true so
    // the app comes back up rather than leaving the user staring at a closed window.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
  });

  ipcMain.handle('update:open-releases', () => shell.openExternal(RELEASES_URL));
}
