'use strict';

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  windowMinimize: () => ipcRenderer.send('window-minimize'),
  windowMaximize: () => ipcRenderer.send('window-maximize'),
  windowClose:    () => ipcRenderer.send('window-close'),
  getApiKey: (service: string): Promise<string | null> => ipcRenderer.invoke('get-api-key', service),
  setApiKey: (service: string, key: string): Promise<void> => ipcRenderer.invoke('set-api-key', service, key),
});
