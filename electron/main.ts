import { app, BrowserWindow, dialog, shell, Menu } from 'electron';
import path from 'node:path';

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
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Open external links in the real browser, never inside the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  try {
    // Lazy import so the env vars above are set first
    const { startServer } = await import('../server/index.js');
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

  app.whenReady().then(() => {
    buildMenu();
    void createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
