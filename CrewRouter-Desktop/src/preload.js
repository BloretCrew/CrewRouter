'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crewrouterDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  chooseMode: (mode) => ipcRenderer.invoke('desktop:choose-mode', mode),
  setupLocalProfile: (displayName) => ipcRenderer.invoke('desktop:setup-local-profile', displayName),
  connectRemote: (url) => ipcRenderer.invoke('desktop:connect-remote', url),
  connectCustomRemote: (url) => ipcRenderer.invoke('desktop:connect-custom-remote', url),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  listProfiles: () => ipcRenderer.invoke('desktop:list-profiles'),
  switchProfile: (id) => ipcRenderer.invoke('desktop:switch-profile', id),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  openSettings: () => ipcRenderer.invoke('desktop:open-settings'),
  getDesktopSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  saveDesktopSettings: (settings) => ipcRenderer.invoke('desktop:save-settings', settings),
  renameProfile: (id, name) => ipcRenderer.invoke('desktop:rename-profile', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('desktop:delete-profile', id),
  stopLocal: () => ipcRenderer.invoke('desktop:stop-local'),
  getDiagnostics: () => ipcRenderer.invoke('desktop:get-diagnostics'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:status', listener);
    return () => ipcRenderer.removeListener('desktop:status', listener);
  }
}));
