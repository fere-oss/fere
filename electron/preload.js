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

  // Database queries
  getDatabaseTables: (containerId, containerImage) => ipcRenderer.invoke('get-database-tables', containerId, containerImage),
  getTableData: (containerId, containerImage, tableName, limit) => ipcRenderer.invoke('get-table-data', containerId, containerImage, tableName, limit),
  executeDatabaseQuery: (containerId, containerImage, query) => ipcRenderer.invoke('execute-database-query', containerId, containerImage, query),
  createDatabaseTable: (containerId, containerImage, tableName, columns) => ipcRenderer.invoke('create-database-table', containerId, containerImage, tableName, columns),
  connectMongoUri: (uri) => ipcRenderer.invoke('connect-mongo-uri', uri),
  getMongoUriCollectionData: (uri, collectionName, limit) => ipcRenderer.invoke('get-mongo-uri-collection-data', uri, collectionName, limit),
  executeMongoUriQuery: (uri, command) => ipcRenderer.invoke('execute-mongo-uri-query', uri, command),
  connectPostgresUri: (uri) => ipcRenderer.invoke('connect-postgres-uri', uri),
  getPostgresUriTableData: (uri, tableName, limit) => ipcRenderer.invoke('get-postgres-uri-table-data', uri, tableName, limit),
  executePostgresUriQuery: (uri, query) => ipcRenderer.invoke('execute-postgres-uri-query', uri, query),
  connectElasticsearchUri: (baseUrl) => ipcRenderer.invoke('connect-elasticsearch-uri', baseUrl),
  getElasticsearchUriIndexData: (baseUrl, indexName, limit) => ipcRenderer.invoke('get-elasticsearch-uri-index-data', baseUrl, indexName, limit),
  executeElasticsearchUriQuery: (baseUrl, query) => ipcRenderer.invoke('execute-elasticsearch-uri-query', baseUrl, query),

  // Process control
  killProcess: (pid) => ipcRenderer.invoke('kill-process', pid),
  stopContainer: (containerId) => ipcRenderer.invoke('stop-container', containerId),
  startContainer: (containerId) => ipcRenderer.invoke('start-container', containerId),
  restartContainer: (containerId) => ipcRenderer.invoke('restart-container', containerId),
  startComposeProject: (composeFilePath, services) => ipcRenderer.invoke('start-compose-project', composeFilePath, services),
  startProcess: (command, cwd) => ipcRenderer.invoke('start-process', command, cwd),

  // Quick actions
  openUrl: (url) => ipcRenderer.invoke('open-url', url),
  openTerminal: (path) => ipcRenderer.invoke('open-terminal', path),
  copyText: (text) => ipcRenderer.invoke('copy-text', text),

  // API testing
  executeHttpRequest: (options) => ipcRenderer.invoke('execute-http-request', options),
  executeTracedRequest: (options) => ipcRenderer.invoke('execute-traced-request', options),

  // Request History
  loadRequestHistory: () => ipcRenderer.invoke('load-request-history'),
  saveRequestHistory: (entry) => ipcRenderer.invoke('save-request-history', entry),
  clearRequestHistory: () => ipcRenderer.invoke('clear-request-history'),

  // Network Policy
  getNetworkPolicy: () => ipcRenderer.invoke('get-network-policy'),
  setNetworkPolicy: (policy) => ipcRenderer.invoke('set-network-policy', policy),

  // Alert Preferences
  getAlertPreferences: () => ipcRenderer.invoke('get-alert-preferences'),
  setAlertPreferences: (prefs) => ipcRenderer.invoke('set-alert-preferences', prefs),

  // Alert History
  getAlertHistory: () => ipcRenderer.invoke('get-alert-history'),
  clearAlertHistory: () => ipcRenderer.invoke('clear-alert-history'),

  // Container Logs Streaming
  startContainerLogs: (containerId, options) => ipcRenderer.invoke('start-container-logs', containerId, options),
  stopContainerLogs: (streamId) => ipcRenderer.invoke('stop-container-logs', streamId),
  stopContainerStreams: (containerId) => ipcRenderer.invoke('stop-container-streams', containerId),
  stopAllContainerLogs: () => ipcRenderer.invoke('stop-all-container-logs'),

  // Container Logs Event Listeners
  onContainerLogData: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('container-log-data', listener);
    return () => ipcRenderer.removeListener('container-log-data', listener);
  },
  onContainerLogError: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('container-log-error', listener);
    return () => ipcRenderer.removeListener('container-log-error', listener);
  },
  onContainerLogClose: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('container-log-close', listener);
    return () => ipcRenderer.removeListener('container-log-close', listener);
  },

  // Snapshot push channel (event-driven pipeline)
  startSnapshotStream: () => ipcRenderer.invoke('start-snapshot-stream'),
  stopSnapshotStream: () => ipcRenderer.invoke('stop-snapshot-stream'),
  onSnapshotDelta: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('snapshot-delta', listener);
    return () => ipcRenderer.removeListener('snapshot-delta', listener);
  },

  // Analytics
  getAnalyticsId: () => ipcRenderer.invoke('get-analytics-id'),

  // Share (GitHub Gist)
  getShareSettings: () => ipcRenderer.invoke('get-share-settings'),
  saveGithubToken: (token) => ipcRenderer.invoke('save-github-token', token),
  publishGraph: (options) => ipcRenderer.invoke('publish-graph', options),
  updateSharedGraph: (options) => ipcRenderer.invoke('update-shared-graph', options),

  // Open file in editor
  openInEditor: (filePath, line) => ipcRenderer.invoke('open-in-editor', filePath, line),

  // Debug Agent
  debugSetApiKey: (key) => ipcRenderer.invoke('debug-set-api-key', key),
  debugGetApiKeyStatus: () => ipcRenderer.invoke('debug-get-api-key-status'),
  debugStart: (options) => ipcRenderer.invoke('debug-start', options),
  debugStop: () => ipcRenderer.invoke('debug-stop'),
  debugFollowUp: (options) => ipcRenderer.invoke('debug-follow-up', options),
  onDebugProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('debug-progress', listener);
    return () => ipcRenderer.removeListener('debug-progress', listener);
  },

  // Stack Query Agent
  queryStart: (options) => ipcRenderer.invoke('query-start', options),
  queryStop: () => ipcRenderer.invoke('query-stop'),
  onQueryProgress: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('query-progress', listener);
    return () => ipcRenderer.removeListener('query-progress', listener);
  },

  explainService: (options) => ipcRenderer.invoke('explain-service', options),

  // Platform info
  platform: process.platform,
});
