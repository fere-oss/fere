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
  cpu: number;
  memory: number;
  ports: {
    port: number;
    host: string;
    description: string | null;
  }[];
  routes?: ApiRoute[];
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
  description?: string | null;
  ports: {
    port: number;
    host: string;
    description: string | null;
  }[];
  routes?: ApiRoute[];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  sourcePort: number;
  targetPort: number;
  protocol: string;
}

export interface ConnectionGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface ApiRoute {
  method: string;
  path: string;
}

export interface SystemSnapshot {
  processes: Process[];
  ports: Port[];
  connections: Connection[];
  graph: ConnectionGraph;
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

  // Process control
  killProcess: (pid: number) => Promise<KillResult>;

  // Quick actions
  openUrl: (url: string) => Promise<{ success: boolean; error?: string }>;
  openTerminal: (path: string) => Promise<{ success: boolean; error?: string }>;

  // Platform info
  platform: string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
