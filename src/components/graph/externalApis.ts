import type { GraphNode, ExternalApi } from "../../types/electron";

export const EXTERNAL_API_CACHE_TTL_MS = 60000;
export const externalApiCache = new Map<string, { timestamp: number; apis: ExternalApi[] }>();
export const externalApiInFlight = new Set<string>();
const externalApiCacheListeners = new Set<() => void>();
const EXTERNAL_API_NODE_TYPES = new Set([
  "frontend",
  "backend",
  "webserver",
  "nodejs",
  "python",
  "worker",
  "realtime",
  "client",
]);

function notifyExternalApiCacheUpdate() {
  externalApiCacheListeners.forEach((listener) => listener());
}

export function setExternalApiCacheEntry(projectPath: string, apis: ExternalApi[]) {
  externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
  notifyExternalApiCacheUpdate();
}

export function subscribeExternalApiCacheUpdates(listener: () => void) {
  externalApiCacheListeners.add(listener);
  return () => {
    externalApiCacheListeners.delete(listener);
  };
}

export function supportsExternalApiScan(
  node: Pick<GraphNode, "type" | "projectPath" | "isDockerContainer">,
): boolean {
  return Boolean(
    node.projectPath && !node.isDockerContainer && EXTERNAL_API_NODE_TYPES.has(node.type),
  );
}
