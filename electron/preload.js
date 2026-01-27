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
  getExternalApis: (projectPath) => ipcRenderer.invoke('get-external-apis', projectPath),

  // Docker monitoring
  isDockerAvailable: () => ipcRenderer.invoke('is-docker-available'),
  getDockerContainers: () => ipcRenderer.invoke('get-docker-containers'),
  getDockerNetworks: () => ipcRenderer.invoke('get-docker-networks'),
  getDockerSnapshot: () => ipcRenderer.invoke('get-docker-snapshot'),

  // Process control
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),

  // Quick actions
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openTerminal: (path) => ipcRenderer.invoke('open-terminal', path),

  // API testing
  executeHttpRequest: (options) => ipcRenderer.invoke('execute-http-request', options),

  // Platform info
  platform: process.platform,
});
