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
  // Compose ghost node properties
  isComposeGhost?: boolean;
  composeProject?: string;
  composeFile?: string;
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

export interface ExternalApiProvider {
  name: string;
  domains: string[];
}

export type ServiceStatusCode = 'ok' | 'unavailable' | 'permission_denied' | 'timeout' | 'degraded';

export interface ServiceStatus {
  code: ServiceStatusCode;
  message?: string;
}

export interface ServiceStatuses {
  ports: ServiceStatus;
  processes: ServiceStatus;
  docker: ServiceStatus;
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
    status?: ServiceStatuses;
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
  type: 'down' | 'recovery' | 'degraded' | 'container-stopped' | 'container-running' | 'service-discovered' | 'service-gone';
  category: 'down' | 'recovery' | 'degraded' | 'container' | 'discovery';
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

export type ActivityCategory = 'crash' | 'recovery' | 'anomaly' | 'sentinel' | 'discovery' | 'removal' | 'topology' | 'user-action';

export interface ActivityEvent {
  id: string;
  timestamp: number;
  category: ActivityCategory;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  serviceName: string | null;
  serviceId: string | null;
  projectName: string | null;
  relatedEvents: string[];
}

export interface ActivityLogOptions {
  since?: number;
  categories?: ActivityCategory[];
  projectName?: string;
  limit?: number;
}

export interface MetricSample {
  t: number;
  cpu: number;
  mem: number;
}

export interface MetricHistoryEntry {
  samples: MetricSample[];
  projectName: string | null;
}

export interface MetricHistory {
  [serviceName: string]: MetricHistoryEntry;
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
    status?: ServiceStatuses;
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

// Auth types
export interface AuthSession {
  signedIn: boolean;
  provider: 'github' | 'google' | null;
  displayName: string | null;
  avatarUrl: string | null;
  email: string | null;
}

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
  getExternalApiProviders: () => Promise<ExternalApiProvider[]>;
  rescanRoutes: (projectPath: string) => Promise<{ routes: Route[]; scannedAt: number | null }>;

  // Docker monitoring
  getDockerContainers: () => Promise<DockerContainer[]>;
  getDockerNetworks: () => Promise<DockerNetworkInfo[]>;
  getDockerSnapshot: () => Promise<DockerSnapshot>;
  isDockerAvailable: () => Promise<boolean>;
  getContainerLogTail: (containerId: string, tail?: number) => Promise<{ success: boolean; logs: string }>;

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
  restartContainer: (containerId: string) => Promise<KillResult>;
  startProcess: (command: string, cwd: string) => Promise<KillResult>;
  startComposeProject: (composeFilePath: string, services?: string[]) => Promise<KillResult>;

  // Quick actions
  openUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
  openTerminal: (path: string) => Promise<{ success: boolean; error?: string }>;
  copyText: (text: string) => Promise<{ success: boolean; error?: string }>;
  toggleWindowMaximize: () => Promise<{ success: boolean; error?: string }>;

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

  // Auto-Launch
  getAutoLaunch: () => Promise<boolean>;
  setAutoLaunch: (enabled: boolean) => Promise<{ success: boolean; error?: string }>;

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
  getActivityLog: (options?: ActivityLogOptions) => Promise<ActivityEvent[]>;
  getMetricHistory: () => Promise<MetricHistory>;
  onActivityEvent: (callback: (event: ActivityEvent) => void) => () => void;

  // Analytics
  getAnalyticsId: () => Promise<string>;

  // Share / Export
  getShareSettings: () => Promise<ShareSettings>;
  saveGithubToken: (token: string) => Promise<{ success: boolean; error?: string }>;
  exportGraphFile: (options: PublishGraphOptions) => Promise<{ success: boolean; filePath?: string; error?: string }>;
  publishGraph: (options: PublishGraphOptions) => Promise<PublishGraphResult>;
  updateSharedGraph: (options: PublishGraphOptions) => Promise<PublishGraphResult>;

  // Open file in editor
  openInEditor: (filePath: string, line?: number) => Promise<{ success: boolean; editor?: string; error?: string }>;

  // Platform info
  platform: string;
  logoDevToken: string | null;

  // OAuth
  authSignInGithub: () => Promise<{ success: boolean; error?: string }>;
  authSignInGoogle: () => Promise<{ success: boolean; error?: string }>;
  authGetSession: () => Promise<AuthSession>;
  authSignOut: () => Promise<{ success: boolean; error?: string }>;
  onAuthSessionChanged: (callback: (session: AuthSession) => void) => () => void;

  // Fere Agent — API Key Management
  setApiKey: (key: string) => Promise<{ success: boolean; error?: string }>;
  getApiKeyStatus: () => Promise<{ hasKey: boolean }>;
  clearApiKey: () => Promise<{ success: boolean; error?: string }>;

  // Fere Agent
  agentUsage: () => Promise<{ used: number; limit: number; remaining: number; mode?: string }>;
  agentScan: (nodeIds?: string[]) => Promise<{ success: boolean; findings: AgentFinding[]; error?: string }>;
  agentApplyFix: (action: AgentFixAction) => Promise<{ success: boolean; error?: string }>;
  openInClaudeCode: (finding: { id: string; service: string; summary: string; severity: AgentSeverity; detail?: string; impact?: string | null; affectedServices?: string[] }) => Promise<{ success: boolean; briefPath: string; projectPath: string; error?: string }>;
  agentChat: (
    messages: { role: 'user' | 'assistant'; content: string }[],
    nodeIds?: string[],
    tabLabel?: string | null,
    options?: { autopilotEnabled?: boolean },
    graphEdges?: GraphEdge[]
  ) => Promise<{ success: boolean; content?: string; error?: string }>;
  onChatToken: (callback: (token: string) => void) => void;
  offChatToken: () => void;
  onChatStep: (callback: (step: ChatStep) => void) => void;
  offChatStep: () => void;
  onFixProposal: (callback: (proposal: FixProposal) => void) => void;
  offFixProposal: () => void;
  onProactiveFinding: (callback: (findings: AgentFinding[]) => void) => void;
  offProactiveFinding: () => void;
  onFindingResolved: (callback: (ids: string[]) => void) => void;
  offFindingResolved: () => void;
  onFindingWorsened: (callback: (findings: AgentFinding[]) => void) => void;
  offFindingWorsened: () => void;
  setNativeTheme?: (theme: "light" | "dark") => Promise<void>;

  // Service Blueprint
  saveBlueprint: (opts: { snapshot: SystemSnapshot; projectPath: string; label?: string }) => Promise<{ success: boolean }>;
  loadBlueprint: (projectPath: string) => Promise<Blueprint | null>;
  deleteBlueprint: (projectPath: string) => Promise<void>;
  checkBlueprint: (opts: { projectPath: string; snapshot: SystemSnapshot }) => Promise<BlueprintCheckResult>;
}

// Blueprint types
export interface BlueprintService {
  name: string;
  type: string;
  ports: number[];
}

export interface BlueprintContainer {
  name: string;
  image: string;
  imageTag: string;
  ports: number[];
}

export interface Blueprint {
  version: 1;
  savedAt: number;
  repoPath: string;
  label: string;
  services: BlueprintService[];
  containers: BlueprintContainer[];
  requiredEnvKeys: string[];
  dependencyOrder: string[];
}

export type GapStatus = 'ok' | 'missing' | 'wrong-version' | 'wrong-port' | 'not-running';

export interface BlueprintGapItem {
  name: string;
  status: GapStatus;
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface BlueprintCheckResult {
  completionPct: number;
  services: BlueprintGapItem[];
  containers: BlueprintGapItem[];
  envKeys: BlueprintGapItem[];
  missingCount: number;
  wrongCount: number;
  okCount: number;
}


export interface ChatStep {
  type: 'read_file' | 'list_directory' | 'run_command' | 'docker_logs' | 'docker_exec' | 'docker_control' | 'get_node_details' | 'propose_fix';
  label: string;
  path: string;
  done?: boolean;
}

export interface FixProposal {
  id: string;
  label: string;
  description: string;
  fix_type: 'restart-container' | 'kill-port' | 'launch-in-terminal';
  container_id?: string;
  port?: number;
  pid?: number;
  command?: string;
  cwd?: string;
}

export interface ProactiveFinding {
  id: string;
  severity: AgentSeverity;
  service: string;
  summary: string;
  detail: string;
}

export type AgentSeverity = 'critical' | 'warning' | 'suggestion';

export interface AgentFixAction {
  type: 'kill-port' | 'restart-container' | 'copy-only' | 'write-file';
  port?: number;
  pid?: number;
  containerId?: string;
  preview?: string;
  label?: string;
  filePath?: string;
  content?: string;
}

export type AgentCategory = 'health' | 'connectivity' | 'config' | 'security' | 'dependency';

export interface AgentFinding {
  id: string;
  severity: AgentSeverity;
  category: AgentCategory;
  service: string;
  summary: string;
  detail: string;
  impact: string | null;
  affectedServices: string[];
  fix: AgentFixAction | null;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
