/**
 * Preload - arayuz ile masaustu kabugu arasindaki DAR koprusu.
 * Renderer'a Node erisimi verilmez; yalnizca asagidaki islemler acilir.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pos', {
  isDesktop: true,
  version: () => ipcRenderer.invoke('app:version'),
  info: () => ipcRenderer.invoke('app:info'),
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  openLogFolder: () => ipcRenderer.invoke('app:open-logs'),
  openDataFolder: () => ipcRenderer.invoke('app:open-data'),
  backupNow: () => ipcRenderer.invoke('app:backup'),
  quit: () => ipcRenderer.invoke('app:quit'),
  relaunch: () => ipcRenderer.invoke('app:relaunch'),
  onNotice: (handler) => {
    ipcRenderer.on('pos:notice', (_event, payload) => handler(payload));
  },
});
