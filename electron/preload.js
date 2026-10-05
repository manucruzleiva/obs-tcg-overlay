/**
 * Preload script for Electron
 * Exposes safe APIs to the renderer process
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Server controls
  getServerUrl: () => ipcRenderer.invoke('get-server-url'),
  openOverlay: () => ipcRenderer.invoke('open-overlay'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  quitApp: () => ipcRenderer.invoke('quit-app'),

  // Desktop preferences (e.g. keep running in the tray when the window is closed)
  getAppSettings: () => ipcRenderer.invoke('get-app-settings'),
  setAppSetting: (key, value) => ipcRenderer.invoke('set-app-setting', key, value),
  onAppSettingsChanged: (callback) => ipcRenderer.on('app-settings-changed', (event, values) => callback(values)),
  
  // A .oto package opened from the file manager (a double-click) is handed to the page, which offers to install it
  onPackageOpened: (callback) => {
    ipcRenderer.on('package-opened', (event, file) => callback(file));
    ipcRenderer.invoke('take-opened-packages').then((files) => files.forEach(callback));
  },

  // Window controls
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  closeWindow: () => ipcRenderer.send('close-window'),
  
  // Event listeners
  onServerStatus: (callback) => ipcRenderer.on('server-status', callback),
  onOverlayUpdate: (callback) => ipcRenderer.on('overlay-update', callback)
});

// Expose safe Node.js APIs
contextBridge.exposeInMainWorld('nodeAPI', {
  platform: process.platform,
  version: process.version,
  versions: process.versions
});