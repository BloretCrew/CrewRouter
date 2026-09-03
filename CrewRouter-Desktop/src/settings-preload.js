'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crewrouterDesktop', Object.freeze({
  getDesktopSettings: () => ipcRenderer.invoke('desktop:get-settings'),
  saveDesktopSettings: (settings) => ipcRenderer.invoke('desktop:save-settings', settings),
  renameProfile: (id, name) => ipcRenderer.invoke('desktop:rename-profile', id, name),
  deleteProfile: (id) => ipcRenderer.invoke('desktop:delete-profile', id),
  stopLocal: () => ipcRenderer.invoke('desktop:stop-local'),
  restartLocal: () => ipcRenderer.invoke('desktop:restart-local'),
  getDiagnostics: () => ipcRenderer.invoke('desktop:get-diagnostics'),
}));
