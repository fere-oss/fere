const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Process monitoring
  getProcesses: () => ipcRenderer.invoke('get-processes'),
  getPorts: () => ipcRenderer.invoke('get-ports'),
  getConnections: () => ipcRenderer.invoke('get-connections'),

  // Process control
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),

  // Platform info
  platform: process.platform,
});
