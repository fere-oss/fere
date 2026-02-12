import type { GraphNode, ExternalApi } from '../../types/electron';

export const EXTERNAL_API_CACHE_TTL_MS = 60000;
export const externalApiCache = new Map<string, { timestamp: number; apis: ExternalApi[] }>();
export const externalApiInFlight = new Set<string>();
const EXTERNAL_API_NODE_TYPES = new Set([
  'frontend',
  'backend',
  'webserver',
  'nodejs',
  'python',
  'worker',
  'realtime',
  'client',
]);

export function supportsExternalApiScan(node: Pick<GraphNode, 'type' | 'projectPath' | 'isDockerContainer'>): boolean {
  return Boolean(node.projectPath && !node.isDockerContainer && EXTERNAL_API_NODE_TYPES.has(node.type));
}
