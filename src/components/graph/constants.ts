import type { HealthStatus } from '../../types/electron';

// Color scheme for different service types
export const SERVICE_COLORS: Record<string, { color: string; label: string }> = {
  frontend: { color: '#0078D4', label: 'Frontend' },      // Microsoft Blue
  backend: { color: '#0078D4', label: 'Backend' },        // Microsoft Blue
  webserver: { color: '#0078D4', label: 'Web Server' },   // Microsoft Blue
  database: { color: '#76B900', label: 'Database' },      // NVIDIA Green
  cache: { color: '#FFB707', label: 'Cache' },            // Amber
  nodejs: { color: '#5E9B00', label: 'Node.js' },         // Deep green
  python: { color: '#9AD100', label: 'Python' },          // Bright green
  container: { color: '#EC679B', label: 'Container' },    // Pink
  broker: { color: '#D96C00', label: 'Broker' },          // Deep amber
  realtime: { color: '#1AA6A6', label: 'Realtime' },      // Teal
  worker: { color: '#6B7280', label: 'Worker' },          // Neutral gray
  client: { color: '#5C7AEA', label: 'Client' },          // Muted blue
  service: { color: '#F03603', label: 'System Service' }, // Red
  external: { color: '#EC679B', label: 'External' },      // Pink
};

export const getServiceColor = (type: string) => {
  return SERVICE_COLORS[type]?.color || '#6B7280';
};

// Health status colors and labels
export const HEALTH_COLORS: Record<HealthStatus, { color: string; label: string; glow: string; description: string }> = {
  green: { color: '#22C55E', label: 'Active', glow: '0 0 8px #22C55E60', description: 'Responding to connections normally' },
  yellow: { color: '#EAB308', label: 'Idle', glow: '0 0 8px #EAB30860', description: 'Running but no recent connections' },
  red: { color: '#EF4444', label: 'Down', glow: '0 0 8px #EF444460', description: 'Process exited or not responding' },
};

export const getHealthInfo = (status: HealthStatus) => {
  return HEALTH_COLORS[status] || HEALTH_COLORS.yellow;
};

export const getTypeBadge = (type: string) => {
  const labels: Record<string, string> = {
    frontend: 'Frontend',
    backend: 'Backend',
    database: 'Database',
    cache: 'Cache',
    nodejs: 'Node.js',
    python: 'Python',
    webserver: 'Web Server',
    container: 'Container',
    broker: 'Broker',
    realtime: 'Realtime',
    worker: 'Worker',
    client: 'Client',
    service: 'Service',
    external: 'External',
  };
  return labels[type] || 'Service';
};

// Extract a normalized base name for grouping related services
export const getBaseName = (name: string): string => {
  let base = name.toLowerCase().trim();
  const envPrefixPattern = /^(?:fere[-_])?(?:test|demo|dev|prod|staging|stage|qa|local)[-_]+/i;
  while (envPrefixPattern.test(base)) {
    base = base.replace(envPrefixPattern, '');
  }
  base = base.replace(/[-_]?(server|api|service|app|client|worker|main|dev|prod|test)$/i, '');
  base = base.replace(/[-_]?\d+$/, '');
  base = base.replace(/[-_]+$/, '');
  return base || name.toLowerCase();
};

// Type priority for initial ordering (lower = higher in graph)
export const getTypePriority = (type: string): number => {
  switch (type) {
    case 'frontend': return 0;
    case 'backend':
    case 'webserver':
    case 'nodejs': return 1;
    case 'python':
    case 'broker':
    case 'realtime':
    case 'client':
    case 'worker': return 2;
    case 'database':
    case 'cache': return 3;
    default: return 4;
  }
};
