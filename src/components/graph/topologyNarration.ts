import type { GraphNode, GraphEdge } from '../../types/electron';
import { getTypePriority } from './constants';

/**
 * Build a plain-language narration of the current topology.
 * Examples:
 *   "5 services: Next.js frontend → FastAPI API → PostgreSQL, Redis | Celery worker polls Redis"
 *   "3 services (1 down): Express API → MongoDB | Redis (down)"
 *   "1 service: FastAPI on :8000"
 */
export function buildTopologyNarration(nodes: GraphNode[], edges: GraphEdge[]): string {
  // Filter out external nodes
  const realNodes = nodes.filter(n => n.type !== 'external');
  if (realNodes.length === 0) return '';

  const downCount = realNodes.filter(n => n.healthStatus === 'red' || n.isGhost).length;

  // Single node
  if (realNodes.length === 1) {
    const n = realNodes[0];
    const port = n.ports?.[0]?.port;
    const label = nodeName(n);
    const suffix = downCount > 0 ? ' (down)' : '';
    return port ? `${label} on :${port}${suffix}` : `${label}${suffix}`;
  }

  // Sort nodes by type priority (frontends first, then backends, then infra)
  const sorted = [...realNodes].sort((a, b) => getTypePriority(a.type) - getTypePriority(b.type));

  // Build adjacency from edges
  const outgoing = new Map<string, string[]>();
  const incoming = new Set<string>();
  for (const edge of edges) {
    const src = realNodes.find(n => n.id === edge.source);
    const tgt = realNodes.find(n => n.id === edge.target);
    if (!src || !tgt) continue;
    if (!outgoing.has(src.id)) outgoing.set(src.id, []);
    outgoing.get(src.id)!.push(tgt.id);
    incoming.add(tgt.id);
  }

  // Build prefix
  const svcWord = realNodes.length === 1 ? 'service' : 'services';
  const prefix = downCount > 0
    ? `${realNodes.length} ${svcWord} (${downCount} down)`
    : `${realNodes.length} ${svcWord}`;

  // Find roots: nodes with no incoming edges, prefer by type priority
  const roots = sorted.filter(n => !incoming.has(n.id));
  const entryPoints = roots.length > 0 ? roots : [sorted[0]];

  // Walk chains from entry points
  const visited = new Set<string>();
  const chains: string[] = [];

  for (const root of entryPoints) {
    if (visited.has(root.id)) continue;
    const chain = walkChain(root, outgoing, realNodes, visited);
    if (chain) chains.push(chain);
  }

  // Append any unvisited nodes
  const remaining = sorted.filter(n => !visited.has(n.id));
  if (remaining.length > 0) {
    chains.push(remaining.map(n => nodeLabel(n)).join(', '));
  }

  let narration = `${prefix}: ${chains.join(' · ')}`;

  // Truncate if too long
  if (narration.length > 130) {
    narration = narration.slice(0, 127) + '…';
  }

  return narration;
}

function walkChain(
  node: GraphNode,
  outgoing: Map<string, string[]>,
  allNodes: GraphNode[],
  visited: Set<string>,
): string {
  if (visited.has(node.id)) return '';
  visited.add(node.id);

  const parts: string[] = [nodeLabel(node)];
  const targets = outgoing.get(node.id) || [];

  // Sort targets by type priority so infra comes last
  const targetNodes = targets
    .map(id => allNodes.find(n => n.id === id))
    .filter((n): n is GraphNode => !!n && !visited.has(n.id))
    .sort((a, b) => getTypePriority(a.type) - getTypePriority(b.type));

  if (targetNodes.length === 0) return parts[0];

  // If multiple targets at the same tier, group them
  if (targetNodes.length > 1) {
    // Check if all targets are leaf nodes (no outgoing)
    const allLeaves = targetNodes.every(t => !(outgoing.get(t.id)?.length));
    if (allLeaves) {
      targetNodes.forEach(t => visited.add(t.id));
      parts.push(targetNodes.map(t => nodeLabel(t)).join(', '));
      return parts.join(' → ');
    }
  }

  // Walk the first target as the main chain
  const mainTarget = targetNodes[0];
  const rest = walkChain(mainTarget, outgoing, allNodes, visited);
  if (rest) parts.push(rest);

  // Remaining targets as side branches
  for (let i = 1; i < targetNodes.length; i++) {
    if (!visited.has(targetNodes[i].id)) {
      visited.add(targetNodes[i].id);
      parts.push(nodeLabel(targetNodes[i]));
    }
  }

  return parts.join(' → ');
}

function nodeName(node: GraphNode): string {
  return node.name;
}

function nodeLabel(node: GraphNode): string {
  const name = nodeName(node);
  const isDown = node.healthStatus === 'red' || node.isGhost;
  return isDown ? `${name} (down)` : name;
}
