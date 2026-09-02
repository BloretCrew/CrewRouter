'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crewrouterDesktop', Object.freeze({
  getStatus: () => ipcRenderer.invoke('desktop:get-status'),
  chooseMode: (mode) => ipcRenderer.invoke('desktop:choose-mode', mode),
  setupLocalProfile: (displayName) => ipcRenderer.invoke('desktop:setup-local-profile', displayName),
  connectRemote: () => ipcRenderer.invoke('desktop:connect-remote'),
  connectCustomRemote: (url) => ipcRenderer.invoke('desktop:connect-custom-remote', url),
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url),
  listProfiles: () => ipcRenderer.invoke('desktop:list-profiles'),
  switchProfile: (id) => ipcRenderer.invoke('desktop:switch-profile', id),
  restartLocal: () => ipcRenderer.invoke('desktop:restart-local'),
  quit: () => ipcRenderer.invoke('desktop:quit'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:status', listener);
    return () => ipcRenderer.removeListener('desktop:status', listener);
  }
}));
