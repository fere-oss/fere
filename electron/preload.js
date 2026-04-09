const { contextBridge, ipcRenderer } = require('electron');
const rawLogoDevToken = (process.env.REACT_APP_LOGO_DEV_TOKEN || process.env.LOGO_DEV_TOKEN || "").trim();
const logoDevToken = rawLogoDevToken.startsWith("pk_") ? rawLogoDevToken : null;

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
  getExternalApiProviders: () => ipcRenderer.invoke('get-external-api-providers'),
  rescanRoutes: (projectPath) => ipcRenderer.invoke('rescan-routes', projectPath),

  // Docker monitoring
  isDockerAvailable: () => ipcRenderer.invoke('is-docker-available'),
  getDockerContainers: () => ipcRenderer.invoke('get-docker-containers'),
  getDockerNetworks: () => ipcRenderer.invoke('get-docker-networks'),
  getDockerSnapshot: () => ipcRenderer.invoke('get-docker-snapshot'),
  getContainerLogTail: (containerId, tail) => ipcRenderer.invoke('get-container-log-tail', containerId, tail),

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
  toggleWindowMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),

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

  // Auto-Launch
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),

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
  getActivityLog: (options) => ipcRenderer.invoke('get-activity-log', options),
  getMetricHistory: () => ipcRenderer.invoke('get-metric-history'),
  onActivityEvent: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('activity-event', listener);
    return () => ipcRenderer.removeListener('activity-event', listener);
  },

  // Analytics
  getAnalyticsId: () => ipcRenderer.invoke('get-analytics-id'),

  // Share (GitHub Gist)
  getShareSettings: () => ipcRenderer.invoke('get-share-settings'),
  saveGithubToken: (token) => ipcRenderer.invoke('save-github-token', token),
  exportGraphFile: (options) => ipcRenderer.invoke('export-graph-file', options),
  publishGraph: (options) => ipcRenderer.invoke('publish-graph', options),
  updateSharedGraph: (options) => ipcRenderer.invoke('update-shared-graph', options),

  // Open file in editor
  openInEditor: (filePath, line) => ipcRenderer.invoke('open-in-editor', filePath, line),

  // Platform info
  platform: process.platform,
  logoDevToken,

  // OAuth
  authSignInGithub: () => ipcRenderer.invoke('auth:sign-in-github'),
  authSignInGoogle: () => ipcRenderer.invoke('auth:sign-in-google'),
  authGetSession: () => ipcRenderer.invoke('auth:get-session'),
  authSignOut: () => ipcRenderer.invoke('auth:sign-out'),
  onAuthSessionChanged: (callback) => {
    const listener = (event, session) => callback(session);
    ipcRenderer.on('auth:session-changed', listener);
    return () => ipcRenderer.removeListener('auth:session-changed', listener);
  },

  // Fere Agent — API Key Management
  setApiKey: (key) => ipcRenderer.invoke('agent:set-api-key', key),
  getApiKeyStatus: () => ipcRenderer.invoke('agent:get-api-key-status'),
  clearApiKey: () => ipcRenderer.invoke('agent:clear-api-key'),

  // Fere Agent
  agentUsage: () => ipcRenderer.invoke('agent:usage'),
  agentScan: (nodeIds) => ipcRenderer.invoke('agent:scan', nodeIds),
  agentApplyFix: (action) => ipcRenderer.invoke('agent:apply-fix', action),
  openInClaudeCode: (finding) => ipcRenderer.invoke('agent:open-in-claude-code', finding),
  agentChat: (messages, nodeIds, tabLabel, options, graphEdges) =>
    ipcRenderer.invoke('agent:chat', { messages, nodeIds, tabLabel, options, graphEdges }),
  onChatToken: (callback) => ipcRenderer.on('agent:chat-token', (_, token) => callback(token)),
  offChatToken: () => ipcRenderer.removeAllListeners('agent:chat-token'),
  onChatStep: (callback) => ipcRenderer.on('agent:chat-step', (_, step) => callback(step)),
  offChatStep: () => ipcRenderer.removeAllListeners('agent:chat-step'),
  onFixProposal: (callback) => ipcRenderer.on('agent:fix-proposal', (_, proposal) => callback(proposal)),
  offFixProposal: () => ipcRenderer.removeAllListeners('agent:fix-proposal'),
  onProactiveFinding: (callback) => ipcRenderer.on('agent:proactive-finding', (_, findings) => callback(findings)),
  offProactiveFinding: () => ipcRenderer.removeAllListeners('agent:proactive-finding'),
  onFindingResolved: (callback) => ipcRenderer.on('agent:finding-resolved', (_, ids) => callback(ids)),
  offFindingResolved: () => ipcRenderer.removeAllListeners('agent:finding-resolved'),
  onFindingWorsened: (callback) => ipcRenderer.on('agent:finding-worsened', (_, findings) => callback(findings)),
  offFindingWorsened: () => ipcRenderer.removeAllListeners('agent:finding-worsened'),
});
