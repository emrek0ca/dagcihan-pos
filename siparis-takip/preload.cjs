/**
 * Pencere ile ana surec arasindaki KISITLI koprü.
 * Oturum token'i burada YOKTUR; ag istekleri ana surecte yapilir.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siparis', {
  login: (email, password, remember) => ipcRenderer.invoke('login', { email, password, remember }),
  logout: () => ipcRenderer.invoke('logout'),
  state: () => ipcRenderer.invoke('state'),
  refresh: () => ipcRenderer.invoke('refresh'),
  changeStatus: (orderId, status) => ipcRenderer.invoke('changeStatus', { orderId, status }),
  print: (html) => ipcRenderer.invoke('print', { html }),
  hasSavedLogin: () => ipcRenderer.invoke('hasSavedLogin'),
  onState: (handler) => ipcRenderer.on('state', (_event, payload) => handler(payload)),
  onNewOrders: (handler) => ipcRenderer.on('orders:new', (_event, payload) => handler(payload)),
});
