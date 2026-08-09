import { app, BrowserWindow, dialog, ipcMain, shell, Menu } from 'electron';
import path from 'node:path';
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

    const port = await startServer(0);
    await mainWindow.loadURL(`http://127.0.0.1:${port}`);
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
    if (!dataDir || path.resolve(target) !== path.resolve(dataDir)) return;
    await shell.openPath(dataDir);
  });

  app.whenReady().then(() => {
    buildMenu();
    initUpdater();
    void createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
