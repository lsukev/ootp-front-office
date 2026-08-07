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
});
