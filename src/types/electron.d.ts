// Process types
export interface Process {
  pid: number;
  user: string;
  cpu: number;
  memory: number;
  vsz: number;
  rss: number;
  tty: string;
  status: string;
  startTime: string;
  cpuTime: string;
  command: string;
  name: string;
}

// Docker types
export interface DockerPort {
  hostIp: string | null;
  hostPort: number | null;
  containerPort: number;
  protocol: string;
  type: 'mapped' | 'exposed';
}

export interface DockerNetwork {
  name: string;
  networkId: string;
  ipAddress: string;
  gateway: string;
  macAddress: string;
  aliases: string[];
}

export interface DockerMount {
  type: 'bind' | 'volume' | 'tmpfs';
  source: string;
  destination: string;
  mode: string;
  readWrite: boolean;
  name: string | null;
}

export interface DockerHealthCheck {
  start: string;
  end: string;
  exitCode: number;
  output: string;
}

export interface DockerHealth {
  status: 'healthy' | 'unhealthy' | 'starting' | 'running' | 'paused' | 'restarting' | 'exited' | 'dead' | 'unknown';
  failingStreak?: number;
  exitCode?: number;
  checks: DockerHealthCheck[];
}

export interface DockerContainer {
  id: string;
  name: string;
  image: string;
  command: string;
  created: string;
  status: string;
  state: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created';
  ports: DockerPort[];
  networks: DockerNetwork[];
  mounts: DockerMount[];
  health: DockerHealth;
  labels: Record<string, string>;
  cpu: number;
  memory: number;
  memoryUsage?: string;
}

export interface DockerNetworkInfo {
  id: string;
  name: string;
  driver: string;
  scope: string;
  internal: boolean;
  attachable: boolean;
  containers: {
    id: string;
    name: string;
    ipv4Address: string;
    ipv6Address: string;
    macAddress: string;
  }[];
}

export interface DockerContainerConnection {
  sourceContainerId: string;
  targetContainerId: string;
  networkName: string;
  networkId: string;
}

// Container Logs types
export interface ContainerLogData {
  line: string;
  timestamp: string | null;
  stream: 'stdout' | 'stderr';
  containerId: string;
  streamId: string;
}

export interface ContainerLogError {
  streamId: string;
  containerId: string;
  error: string;
}

export interface ContainerLogClose {
  streamId: string;
  containerId: string;
  exitCode: number;
}

export interface ContainerLogOptions {
  tail?: number;
  timestamps?: boolean;
  follow?: boolean;
}

export interface ContainerLogStreamResult {
  success: boolean;
  streamId?: string;
  error?: string;
}

export interface ContainerLogStopResult {
  success: boolean;
  count?: number;
  error?: string;
}

export interface DockerSnapshot {
  containers: DockerContainer[];
  networks: DockerNetworkInfo[];
  containerConnections: DockerContainerConnection[];
  isAvailable: boolean;
}

export interface DatabaseTablesResult {
  tables: string[];
  dbType?: 'postgresql' | 'mysql' | 'mongodb' | 'elasticsearch';
  database?: string;
  error?: string;
}

export interface TableDataResult {
  columns: string[];
  rows: Record<string, unknown>[];
  dbType?: 'postgresql' | 'mysql' | 'mongodb' | 'elasticsearch';
  tableName?: string;
  error?: string;
}

export interface QueryResult {
  columns?: string[];
  rows?: Record<string, unknown>[];
  rowCount?: number;
  output?: string;
  dbType?: 'postgresql' | 'mysql' | 'mongodb' | 'elasticsearch';
  error?: string;
}

export interface ColumnDefinition {
  name: string;
  type: string;
  primaryKey?: boolean;
  notNull?: boolean;
  unique?: boolean;
  defaultValue?: string;
}

export interface CreateTableResult {
  success: boolean;
  message?: string;
  query?: string;
  note?: string;
  error?: string;
}

export interface Service {
  id: string;
  pid: number;
  name: string;
  command: string;
  type: 'database' | 'cache' | 'webserver' | 'container' | 'frontend' | 'backend' | 'nodejs' | 'python' | 'service' | 'external' | 'broker' | 'realtime' | 'worker' | 'client';
  user: string;
  tty?: string | null;
  project?: string | null;
  projectPath?: string | null;
  repoPath?: string | null;
  cpu: number;
  memory: number;
  ports: {
    port: number;
    host: string;
    description: string | null;
  }[];
  routes?: ApiRoute[];
  externalApis?: ExternalApi[];
}

// Port types
export interface Port {
  port: number;
  host: string;
  pid: number;
  process: string;
  user: string;
  protocol: string;
  fd: string;
}

// Connection types
export interface Connection {
  pid: number;
  process: string;
  user: string;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  protocol: string;
}

// Health status types
export type HealthStatus = 'green' | 'yellow' | 'red';

// Graph types
export interface GraphNode {
  id: string;
  pid: number;
  name: string;
  command: string;
  type: 'database' | 'cache' | 'webserver' | 'container' | 'frontend' | 'backend' | 'nodejs' | 'python' | 'service' | 'external' | 'broker' | 'realtime' | 'worker' | 'client';
  cpu: number;
  memory: number;
  user: string;
  tty?: string | null;
  project?: string | null;
  projectPath?: string | null;
  repoPath?: string | null;
  description?: string | null;
  ports: {
    port: number;
    host: string;
    description: string | null;
  }[];
  routes?: ApiRoute[];
  externalApis?: ExternalApi[];
  // Health tracking
  healthStatus: HealthStatus;
  lastSeen: number;
  // Docker-specific properties (only present for container nodes)
  isDockerContainer?: boolean;
  containerId?: string;
  containerImage?: string;
  containerState?: 'running' | 'exited' | 'paused' | 'restarting' | 'dead' | 'created';
  containerStatus?: string;
  containerHealth?: DockerHealth;
  containerNetworks?: DockerNetwork[];
  containerMounts?: DockerMount[];
  containerPorts?: DockerPort[];
  memoryUsage?: string;
  // Remote access metadata (SSH/SFTP/SCP session details)
  remoteAccess?: {
    tool: 'ssh' | 'sftp' | 'scp' | 'autossh';
    alias?: string | null;
    user: string | null;
    host: string | null;
    port: number | null;
    source: 'command' | 'connection';
    startTime: string | null;
    tunnels?: Array<{
      mode: 'L' | 'R' | 'D';
      listenHost: string | null;
      listenPort: number | null;
      targetHost: string | null;
      targetPort: number | null;
    }>;
    inboundSessions?: number;
    inboundClients?: string[];
    healthFlags?: {
      missingConnection: boolean;
      staleLikely: boolean;
      duplicateSessions: number;
      notes: string[];
    };
  };
  // Synthetic node for tracked services not currently running
  isGhost?: boolean;
  startCommand?: string;
  startProjectPath?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourcePort: number;
  targetPort: number;
  protocol: string;
  confidence?: number;
}

export interface ConnectionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ApiRoute {
  method: string;
  path: string;
  framework?: string | null;
}

export interface ExternalApi {
  name: string;
  kind: 'provider' | 'host';
  matchedOn: string[];
  hosts?: string[];
}

export interface SystemSnapshot {
  processes: Process[];
  ports: Port[];
  connections: Connection[];
  graph: ConnectionGraph;
  docker?: DockerSnapshot;
  meta?: {
    collectedAt: number;
    processesAgeMs: number | null;
    portsAgeMs: number | null;
    connectionsAgeMs: number | null;
  };
}

export interface EnvironmentSummary {
  totalServices: number;
  totalConnections: number;
  services: {
    name: string;
    ports: number[];
    type: string;
  }[];
  portRange: {
    min: number;
    max: number;
  } | null;
}

// Kill result
export interface KillResult {
  success: boolean;
  error?: string;
  pid?: number;
  command?: string;
}

// HTTP Request options for API testing
export interface HttpRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}

// HTTP Response from API testing
export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  isJson: boolean;
  duration: number;
  size: number;
}

// HTTP Request result
export interface HttpRequestResult {
  success: boolean;
  response?: HttpResponse;
  error?: string;
}

// History Entry for request logging
export interface HistoryEntry {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  response: {
    status: number;
    statusText: string;
    duration: number;
    size: number;
  };
}

// History operation result
export interface HistoryResult {
  success: boolean;
  history?: HistoryEntry[];
  error?: string;
}

// Trace types
export interface TraceHop {
  sourceNodeId: string;
  targetNodeId: string;
  startTime: number;
  endTime: number;
  latency: number;
  connectionType: 'tcp' | 'external';
  inferred: boolean;
}

export interface TraceResult {
  id: string;
  timestamp: number;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  };
  response: {
    status: number;
    statusText: string;
    time: number;
  } | null;
  hops: TraceHop[];
  totalTime: number;
  timedOut: boolean;
  entryNodeId: string | null;
}

export interface TraceRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
}

export interface TraceRequestResult {
  success: boolean;
  trace?: TraceResult;
  error?: string;
}

// Network policy
export type NetworkPolicy = 'local' | 'public';

export interface NetworkPolicyResult {
  success: boolean;
  policy?: NetworkPolicy;
  error?: string;
}

// Alert preferences
export interface AlertPreferences {
  alertsEnabled: boolean;
  categoryToggles: {
    down: boolean;
    recovery: boolean;
    degraded: boolean;
    container: boolean;
  };
}

// Alert event (in-app history)
export interface AlertEvent {
  id: string;
  timestamp: number;
  type: 'down' | 'recovery' | 'degraded' | 'container-stopped' | 'container-running';
  category: 'down' | 'recovery' | 'degraded' | 'container';
  serviceName: string;
  serviceType: string;
  nodeId: string;
  details: string;
  notified: boolean;
}

export interface AlertHistoryResult {
  success: boolean;
  events: AlertEvent[];
  error?: string;
}

// Snapshot delta types (event-driven pipeline)
export interface SnapshotDelta {
  type: 'full' | 'delta' | 'metrics';
  seq: number;
  timestamp: number;
  // For type 'full': same shape as SystemSnapshot
  processes?: Process[] | {
    added: Process[];
    removed: number[];
    modified: (Partial<Process> & { pid: number })[];
  };
  ports?: Port[] | {
    added: Port[];
    removed: string[];
  };
  connections?: Connection[] | {
    added: Connection[];
    removed: string[];
  };
  graph?: ConnectionGraph | {
    nodes?: {
      added: GraphNode[];
      removed: string[];
      modified: (Partial<GraphNode> & { id: string })[];
    };
    edges?: {
      added: GraphEdge[];
      removed: string[];
    };
  };
  docker?: DockerSnapshot | null;
  meta?: {
    collectedAt: number;
    processesAgeMs: number | null;
    portsAgeMs: number | null;
    connectionsAgeMs: number | null;
  };
}

// Share / Gist publishing types
export interface ShareMetadata {
  tabName: string;
  timestamp: number;
  nodeCount: number;
  edgeCount: number;
}

export interface PublishGraphOptions {
  graphData: ConnectionGraph;
  metadata: ShareMetadata;
}

export interface PublishGraphResult {
  url?: string;
  gistId?: string;
  publishedAt?: number;
  error?: string;
}

export interface ShareSettings {
  hasToken: boolean;
  shareUrl: string | null;
  publishedAt: number | null;
}

export type DebugProgress =
  | { type: 'thinking'; iteration: number }
  | { type: 'tool_call'; tool: string; input: Record<string, unknown>; iteration: number }
  | {
      type: 'tool_result';
      tool: string;
      input?: Record<string, unknown>;
      summary: string;
      result?: unknown;
      iteration: number;
    }
  | { type: 'diagnosis_delta'; text: string }
  | { type: 'complete'; diagnosis: string }
  | { type: 'error'; error: string };

export type QueryProgress =
  | { type: 'thinking' }
  | { type: 'answer_delta'; text: string }
  | {
      type: 'complete';
      answer: string;
      references?: {
        services?: string[];
        ports?: number[];
        routes?: Array<{ serviceName: string; method: string; path: string }>;
        projects?: string[];
      };
      optimizationSignals?: string[];
    }
  | { type: 'error'; error: string };

// Electron API interface
export interface ElectronAPI {
  // Process monitoring
  getDevProcesses: () => Promise<Process[]>;
  getAllProcesses: () => Promise<Process[]>;
  getListeningPorts: () => Promise<Port[]>;
  getConnections: () => Promise<Connection[]>;

  // Connection graph
  getConnectionGraph: () => Promise<ConnectionGraph>;
  getEnvironmentSummary: () => Promise<EnvironmentSummary>;
  getSystemSnapshot: () => Promise<SystemSnapshot>;
  getExternalApis: (projectPath: string) => Promise<ExternalApi[]>;

  // Docker monitoring
  getDockerContainers: () => Promise<DockerContainer[]>;
  getDockerNetworks: () => Promise<DockerNetworkInfo[]>;
  getDockerSnapshot: () => Promise<DockerSnapshot>;
  isDockerAvailable: () => Promise<boolean>;

  // Database queries
  getDatabaseTables: (containerId: string, containerImage: string) => Promise<DatabaseTablesResult>;
  getTableData: (containerId: string, containerImage: string, tableName: string, limit?: number) => Promise<TableDataResult>;
  executeDatabaseQuery: (containerId: string, containerImage: string, query: string) => Promise<QueryResult>;
  createDatabaseTable: (containerId: string, containerImage: string, tableName: string, columns: ColumnDefinition[]) => Promise<CreateTableResult>;
  connectMongoUri: (uri: string) => Promise<DatabaseTablesResult>;
  getMongoUriCollectionData: (uri: string, collectionName: string, limit?: number) => Promise<TableDataResult>;
  executeMongoUriQuery: (uri: string, command: string) => Promise<QueryResult>;
  connectPostgresUri: (uri: string) => Promise<DatabaseTablesResult>;
  getPostgresUriTableData: (uri: string, tableName: string, limit?: number) => Promise<TableDataResult>;
  executePostgresUriQuery: (uri: string, query: string) => Promise<QueryResult>;
  connectElasticsearchUri: (baseUrl: string) => Promise<DatabaseTablesResult>;
  getElasticsearchUriIndexData: (baseUrl: string, indexName: string, limit?: number) => Promise<TableDataResult>;
  executeElasticsearchUriQuery: (baseUrl: string, query: string) => Promise<QueryResult>;

  // Process control
  killProcess: (pid: number) => Promise<KillResult>;
  stopContainer: (containerId: string) => Promise<KillResult>;
  startContainer: (containerId: string) => Promise<KillResult>;
  startProcess: (command: string, cwd: string) => Promise<KillResult>;

  // Quick actions
  openUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
  openTerminal: (path: string) => Promise<{ success: boolean; error?: string }>;
  copyText: (text: string) => Promise<{ success: boolean; error?: string }>;

  // API testing
  executeHttpRequest: (options: HttpRequestOptions) => Promise<HttpRequestResult>;
  executeTracedRequest: (options: TraceRequestOptions) => Promise<TraceRequestResult>;

  // Request History
  loadRequestHistory: () => Promise<HistoryResult>;
  saveRequestHistory: (entry: HistoryEntry) => Promise<{ success: boolean; error?: string }>;
  clearRequestHistory: () => Promise<{ success: boolean; error?: string }>;

  // Network Policy
  getNetworkPolicy: () => Promise<NetworkPolicyResult>;
  setNetworkPolicy: (policy: NetworkPolicy) => Promise<{ success: boolean; error?: string }>;

  // Alert Preferences
  getAlertPreferences: () => Promise<AlertPreferences>;
  setAlertPreferences: (prefs: Partial<AlertPreferences>) => Promise<{ success: boolean; error?: string }>;

  // Alert History
  getAlertHistory: () => Promise<AlertHistoryResult>;
  clearAlertHistory: () => Promise<{ success: boolean; error?: string }>;

  // Container Logs Streaming
  startContainerLogs: (containerId: string, options?: ContainerLogOptions) => Promise<ContainerLogStreamResult>;
  stopContainerLogs: (streamId: string) => Promise<ContainerLogStopResult>;
  stopContainerStreams: (containerId: string) => Promise<ContainerLogStopResult>;
  stopAllContainerLogs: () => Promise<{ success: boolean; error?: string }>;
  onContainerLogData: (callback: (data: ContainerLogData) => void) => () => void;
  onContainerLogError: (callback: (data: ContainerLogError) => void) => () => void;
  onContainerLogClose: (callback: (data: ContainerLogClose) => void) => () => void;

  // Snapshot push channel (event-driven pipeline)
  startSnapshotStream: () => Promise<{ success: boolean; error?: string }>;
  stopSnapshotStream: () => Promise<{ success: boolean }>;
  onSnapshotDelta: (callback: (delta: SnapshotDelta) => void) => () => void;

  // Analytics
  getAnalyticsId: () => Promise<string>;

  // Share (GitHub Gist)
  getShareSettings: () => Promise<ShareSettings>;
  saveGithubToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  publishGraph: (options: PublishGraphOptions) => Promise<PublishGraphResult>;
  updateSharedGraph: (options: PublishGraphOptions) => Promise<PublishGraphResult>;

  // Open file in editor
  openInEditor: (filePath: string, line?: number) => Promise<{ success: boolean; editor?: string; error?: string }>;

  // Debug Agent
  debugSetApiKey: (key: string) => Promise<{ success: boolean; error?: string }>;
  debugGetApiKeyStatus: () => Promise<{ hasKey: boolean }>;
  debugStart: (options: { problem: string }) => Promise<{ success: boolean; error?: string }>;
  debugStop: () => Promise<{ success: boolean }>;
  debugFollowUp: (options: { message: string }) => Promise<{ success: boolean; error?: string }>;
  onDebugProgress: (callback: (progress: DebugProgress) => void) => () => void;

  // Stack Query Agent
  queryStart: (options: { query: string }) => Promise<{ success: boolean; error?: string }>;
  queryStop: () => Promise<{ success: boolean }>;
  onQueryProgress: (callback: (progress: QueryProgress) => void) => () => void;
  explainService: (options: {
    serviceId: string;
    serviceName: string;
  }) => Promise<{
    success: boolean;
    serviceId?: string;
    serviceName?: string;
    explanation?: string;
    error?: string;
  }>;

  // Platform info
  platform: string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
