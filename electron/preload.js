const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  // Process monitoring
  getDevProcesses: () => ipcRenderer.invoke('get-dev-processes'),
  getAllProcesses: () => ipcRenderer.invoke('get-all-processes'),
  getListeningPorts: () => ipcRenderer.invoke('get-listening-ports'),
  getConnections: () => ipcRenderer.invoke('get-connections'),

  // Connection graph
  getConnectionGraph: () => ipcRenderer.invoke('get-connection-graph'),
  getEnvironmentSummary: () => ipcRenderer.invoke('get-environment-summary'),
  getSystemSnapshot: () => ipcRenderer.invoke('get-system-snapshot'),

  // Process control
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),

  // Platform info
  platform: process.platform,
});
