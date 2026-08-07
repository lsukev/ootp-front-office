import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the UI and the desktop shell. Deliberately tiny:
 * one method that opens the OS folder picker and returns the chosen path.
 * Everything else the UI needs already comes from the local HTTP API.
 */
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  selectFolder: (defaultPath?: string): Promise<string | null> =>
    ipcRenderer.invoke('select-folder', defaultPath),
  openPath: (target: string): Promise<void> => ipcRenderer.invoke('open-path', target),

  // Auto-update. `onUpdateState` returns its own unsubscribe so a React effect
  // can clean up without the renderer ever touching ipcRenderer directly.
  update: {
    state: () => ipcRenderer.invoke('update:state'),
    check: () => ipcRenderer.invoke('update:check'),
    download: () => ipcRenderer.invoke('update:download'),
    install: () => ipcRenderer.invoke('update:install'),
    openReleases: () => ipcRenderer.invoke('update:open-releases'),
    onState: (handler: (state: unknown) => void): (() => void) => {
      const listener = (_event: unknown, state: unknown): void => handler(state);
      ipcRenderer.on('update:state', listener);
      return () => ipcRenderer.removeListener('update:state', listener);
    },
  },
});
