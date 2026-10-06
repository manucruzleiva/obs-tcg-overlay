/**
 * Preload script of the small window that sets the control panel password (see password.html): the page can only ask to save a password or to
 * close, and the main process does the rest.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('passwordApi', {
  save: (password) => ipcRenderer.invoke('password:save', password),
  cancel: () => ipcRenderer.send('password:cancel')
});
