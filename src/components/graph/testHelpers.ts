import type { GraphNode, GraphEdge, HealthStatus } from "../../../types/electron";

let nodeCounter = 0;

/**
 * Factory for creating test GraphNode instances with sensible defaults.
 */
export function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  const id = overrides.id ?? `node-${++nodeCounter}`;
  return {
    id,
    pid: overrides.pid ?? 1000 + nodeCounter,
    name: overrides.name ?? id,
    command: overrides.command ?? `/${id}`,
    type: overrides.type ?? "backend",
    cpu: overrides.cpu ?? 1.2,
    memory: overrides.memory ?? 50,
    user: overrides.user ?? "dev",
    ports: overrides.ports ?? [{ port: 3000 + nodeCounter, host: "127.0.0.1", description: null }],
    healthStatus: overrides.healthStatus ?? ("green" as HealthStatus),
    lastSeen: overrides.lastSeen ?? Date.now(),
    ...(overrides.isDockerContainer !== undefined ? { isDockerContainer: overrides.isDockerContainer } : {}),
    ...(overrides.projectPath !== undefined ? { projectPath: overrides.projectPath } : {}),
    ...(overrides.routes !== undefined ? { routes: overrides.routes } : {}),
    ...(overrides.externalApis !== undefined ? { externalApis: overrides.externalApis } : {}),
  };
}

let edgeCounter = 0;

/**
 * Factory for creating test GraphEdge instances.
 */
export function makeEdge(source: string, target: string, overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: overrides.id ?? `edge-${++edgeCounter}`,
    source,
    target,
    sourcePort: overrides.sourcePort ?? 3000,
    targetPort: overrides.targetPort ?? 5432,
    protocol: overrides.protocol ?? "tcp",
    ...(overrides.confidence !== undefined ? { confidence: overrides.confidence } : {}),
  };
}

/**
 * Reset counters between tests.
 */
export function resetCounters() {
  nodeCounter = 0;
  edgeCounter = 0;
}
