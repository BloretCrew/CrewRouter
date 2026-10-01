'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const openLauncher = () => invoke('desktop:open-launcher');

contextBridge.exposeInMainWorld('crewrouterDesktop', Object.freeze({
  getStatus: () => invoke('desktop:get-status'),
  openLauncher,
  openOobe: openLauncher,
  startLocal: (displayName) => invoke('desktop:start-local', displayName),
  connectCustomRemote: (url) => invoke('desktop:connect-custom-remote', url),
  openOfficialLogin: () => invoke('desktop:open-official-login'),
  reopenOfficialLogin: () => invoke('desktop:reopen-official-login'),
  cancelPending: () => invoke('desktop:cancel-pending'),
  clearError: () => invoke('desktop:clear-error'),
  retry: () => invoke('desktop:retry'),
  openExternal: (url) => invoke('desktop:open-external', url),
  listProfiles: () => invoke('desktop:list-profiles'),
  switchProfile: (id) => invoke('desktop:switch-profile', id),
  renameProfile: (id, name) => invoke('desktop:rename-profile', id, name),
  deleteProfile: (id) => invoke('desktop:delete-profile', id),
  getDesktopSettings: () => invoke('desktop:get-settings'),
  saveDesktopSettings: (settings) => invoke('desktop:save-settings', settings),
  restartLocal: () => invoke('desktop:restart-local'),
  stopLocal: () => invoke('desktop:stop-local'),
  openLogs: () => invoke('desktop:open-logs'),
  getDiagnostics: () => invoke('desktop:get-diagnostics'),
  quit: () => invoke('desktop:quit'),
  restartApp: () => invoke('desktop:restart-app'),
  onStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:status', listener);
    return () => ipcRenderer.removeListener('desktop:status', listener);
  }
}));
