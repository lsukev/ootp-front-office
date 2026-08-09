import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { initUpdater } from './updater.js';

/**
 * Desktop shell. The Express server runs inside this process on a random free
 * port; the window just loads it. That keeps one implementation of the app for
 * both `npm run dev` in a browser and the packaged desktop build.
 */

// Writable state must live outside the app bundle, which is read-only once
// packaged. Set before importing the server so its module-level paths resolve.
process.env.OOTP_FO_DATA_DIR ??= app.getPath('userData');
process.env.OOTP_FO_APP_ROOT ??= app.isPackaged
  ? process.resourcesPath
  : path.resolve(__dirname, '..');
process.env.OOTP_FO_EMBEDDED = '1';

let mainWindow: BrowserWindow | null = null;

/** Where the embedded server ended up, so the window can be reloaded later. */
let serverUrl: string | null = null;
let lastRecoveryAt = 0;
let lastLoadFinishedAt = 0;

/**
 * Puts the UI back after the renderer has gone away.
 *
 * macOS is free to kill a background renderer while the machine sleeps, and
 * Electron does not reload it for you: the WebContents survives, the window
 * keeps painting its backgroundColor, and the user comes back to a blank pane
 * with no error and no way to recover short of quitting the app. The main
 * process and the embedded server are both untouched, which is why nothing
 * looks wrong from the outside.
 */
function recoverWindow(reason: string): void {
  if (!mainWindow || mainWindow.isDestroyed() || !serverUrl) return;
  // If the page itself is what fails, reloading in a tight loop helps nobody
  const now = Date.now();
  if (now - lastRecoveryAt < 5000) return;
  lastRecoveryAt = now;
  console.warn(`[window] reloading after ${reason}`);
  mainWindow.webContents.loadURL(serverUrl).catch((err: unknown) => {
    console.error('[window] reload failed:', err);
  });
}

/**
 * True when the renderer is not showing the app — either it stopped answering
 * or the root element never got its content back.
 */
async function windowIsBlank(): Promise<boolean> {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  if (mainWindow.webContents.isLoading()) return false;
  // React mounts a moment after the load event, and calling a freshly loaded
  // page blank would start a reload loop on a slow machine
  if (Date.now() - lastLoadFinishedAt < 4000) return false;
  try {
    return !(await mainWindow.webContents.executeJavaScript(
      "!!document.getElementById('root') && document.getElementById('root').childElementCount > 0",
      true
    ));
  } catch {
    // A renderer that cannot run a one-line script is gone
    return true;
  }
}

/** True only for http and https, the two schemes safe to hand to the OS. */
function isWebUrl(raw: string): boolean {
  try {
    const scheme = new URL(raw).protocol;
    return scheme === 'http:' || scheme === 'https:';
  } catch {
    return false;
  }
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c231a',
    title: 'OOTP Front Office',
    show: false,
    webPreferences: {
      // The renderer is our own local UI and needs no Node access
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Second safety net: whatever killed the renderer, coming back to the window
  // is when it matters. recoverWindow's own throttle keeps this cheap.
  mainWindow.on('focus', () => {
    void windowIsBlank().then((blank) => {
      if (blank) recoverWindow('blank window on focus');
    });
  });

  // Open external links in the real browser, never inside the app window.
  // Only http and https are handed to the OS: openExternal will happily launch
  // file://, and on Windows any registered protocol handler, so passing it an
  // unfiltered URL turns a stray link in the UI into "run whatever this scheme
  // is wired to". Every link the app actually shows is a web page.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    else console.warn('[shell] refused to open non-web URL:', url);
    return { action: 'deny' };
  });

  // A link without target="_blank" would otherwise navigate this window away
  // from the local UI, leaving a remote page running inside the app shell with
  // the preload bridge attached. The window only ever shows the local server.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url);
    if (target.hostname === '127.0.0.1' || target.hostname === 'localhost') return;
    event.preventDefault();
    if (isWebUrl(url)) void shell.openExternal(url);
  });

  // The renderer dying is not fatal and not visible — without these the window
  // simply goes blank and stays that way
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recoverWindow(`renderer gone (${details.reason})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    // -3 is ABORTED, which is what a superseded navigation reports; ignore it
    if (isMainFrame && code !== -3) recoverWindow(`load failed (${code} ${description})`);
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[window] renderer unresponsive');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    lastLoadFinishedAt = Date.now();
  });

  try {
    // Lazy import so the env vars above are set first
    const { startServer } = await import('../server/index.js');

    // Let the server encrypt the stored API key against the OS keychain
    // (Keychain on macOS, DPAPI on Windows) instead of writing it in plain text.
    //
    // Every call below is deferred. On macOS even isEncryptionAvailable() reads
    // the app's Keychain entry, and macOS prompts for the login password when
    // the requesting binary differs from the one that created the entry — which
    // is every upgrade. Calling it at startup made a fresh install of a new
    // version ask for a Keychain password before showing anything, including
    // for the majority of users who never set an API key at all.
    const { safeStorage } = await import('electron');
    const { setSecretCrypto } = await import('../server/settings.js');
    setSecretCrypto({
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
      label: process.platform === 'darwin' ? 'your macOS Keychain' : 'Windows Credential storage (DPAPI)',
    });

    // Reuse the port from last time.
    //
    // The window's origin includes the port, and localStorage is scoped per
    // origin — so a fresh random port every launch handed the UI a brand new,
    // empty store each time. That is what quietly threw away the conversation
    // with Peter and the chosen stat columns on every restart. Falling back to
    // a free port when the old one is taken keeps two copies from colliding.
    const portFile = path.join(process.env.OOTP_FO_DATA_DIR ?? '', 'port.json');
    let preferred = 0;
    try {
      preferred = Number(JSON.parse(fs.readFileSync(portFile, 'utf8')).port) || 0;
    } catch {
      // First run, or the file was removed
    }

    let port: number;
    try {
      port = await startServer(preferred);
    } catch {
      console.warn(`[server] port ${preferred} unavailable, taking another`);
      port = await startServer(0);
    }
    try {
      fs.writeFileSync(portFile, JSON.stringify({ port }));
    } catch (err) {
      console.warn('[server] could not remember the port:', (err as Error).message);
    }

    serverUrl = `http://127.0.0.1:${port}`;
    await mainWindow.loadURL(serverUrl);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    dialog.showErrorBox(
      'OOTP Front Office could not start',
      `The local server failed to start.\n\n${message}\n\nData folder:\n${process.env.OOTP_FO_DATA_DIR}`
    );
    app.quit();
  }
}

// A minimal menu keeps the standard shortcuts (copy/paste, reload, devtools)
function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
      {
        role: 'help',
        submenu: [
          {
            label: 'Open Data Folder',
            click: () => void shell.openPath(process.env.OOTP_FO_DATA_DIR ?? ''),
          },
          {
            label: 'Project on GitHub',
            click: () => void shell.openExternal('https://github.com/lsukev/ootp-front-office'),
          },
        ],
      },
    ])
  );
}

// Only one copy may run — a second would fight over the same SQLite files
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  // Native folder picker, for when auto-detection can't find the user's save
  ipcMain.handle('select-folder', async (_event, defaultPath?: string) => {
    const result = await dialog.showOpenDialog({
      title: 'Choose your OOTP save or CSV export folder',
      defaultPath: defaultPath && defaultPath.length > 0 ? defaultPath : app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
      message: 'Pick the save folder (ends in .lg), the folder holding your saves, or the csv export folder.',
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });

  // Reveal a folder in Finder/Explorer. Restricted to the app's own data
  // directory so the renderer can't ask the shell to open arbitrary paths.
  ipcMain.handle('open-path', async (_event, target: string) => {
    const dataDir = process.env.OOTP_FO_DATA_DIR ?? '';
    if (!dataDir) return;
    // Anywhere inside the data directory is fine — exports live in a subfolder
    // — but nothing outside it, so the renderer still cannot open the disk.
    const root = path.resolve(dataDir);
    const wanted = path.resolve(target);
    if (wanted !== root && !wanted.startsWith(root + path.sep)) return;
    await shell.openPath(wanted);
  });

  app.whenReady().then(() => {
    buildMenu();
    initUpdater();
    void createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });

    // Waking is when the damage shows up, so check then rather than waiting for
    // the user to notice. render-process-gone does not always fire for a
    // renderer the OS reaped while the machine was asleep — the delay gives
    // loopback networking a moment to come back before the check runs.
    powerMonitor.on('resume', () => {
      setTimeout(() => {
        void windowIsBlank().then((blank) => {
          if (blank) recoverWindow('blank window after wake');
        });
      }, 2000);
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
