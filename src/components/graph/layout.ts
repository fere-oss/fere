import type { GraphNode, GraphEdge } from '../../types/electron';
import type { LayoutNode } from './types';
import { getBaseName, getTypePriority } from './constants';

// Find all nodes that are connected (have at least one edge)
const findConnectedNodes = (
  nodes: GraphNode[],
  edges: GraphEdge[]
): { connected: Set<string>; standalone: Set<string> } => {
  const connected = new Set<string>();
  edges.forEach(edge => {
    connected.add(edge.source);
    connected.add(edge.target);
  });

  const nodeIds = new Set(nodes.map(n => n.id));
  const standalone = new Set<string>();
  nodeIds.forEach(id => {
    if (!connected.has(id)) standalone.add(id);
  });

  return { connected, standalone };
};

// Topological sort using Kahn's algorithm to assign layers based on actual dependencies
const computeTopologicalLayers = (
  nodes: GraphNode[],
  edges: GraphEdge[],
  connectedNodeIds: Set<string>
): Map<string, number> => {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const connectedNodes = nodes.filter(n => connectedNodeIds.has(n.id));

  if (connectedNodes.length === 0) return new Map();

  // Build adjacency lists
  const outgoing = new Map<string, Set<string>>();
  const incoming = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  connectedNodes.forEach(node => {
    outgoing.set(node.id, new Set());
    incoming.set(node.id, new Set());
    inDegree.set(node.id, 0);
  });

  edges.forEach(edge => {
    if (connectedNodeIds.has(edge.source) && connectedNodeIds.has(edge.target)) {
      outgoing.get(edge.source)?.add(edge.target);
      incoming.get(edge.target)?.add(edge.source);
      inDegree.set(edge.target, (inDegree.get(edge.target) || 0) + 1);
    }
  });

  // Find root nodes (no incoming edges) - these go at top
  // Prioritize by type (frontends first)
  const roots = connectedNodes
    .filter(n => (inDegree.get(n.id) || 0) === 0)
    .sort((a, b) => getTypePriority(a.type) - getTypePriority(b.type));

  // If no roots found (cycle), pick the node with lowest type priority
  if (roots.length === 0) {
    const sorted = [...connectedNodes].sort((a, b) =>
      getTypePriority(a.type) - getTypePriority(b.type)
    );
    roots.push(sorted[0]);
  }

  // BFS to assign layers
  const layers = new Map<string, number>();
  const queue: { node: GraphNode; layer: number }[] = roots.map(n => ({ node: n, layer: 0 }));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { node, layer } = queue.shift()!;

    if (visited.has(node.id)) {
      // Update to max layer if revisited
      if (layer > (layers.get(node.id) || 0)) {
        layers.set(node.id, layer);
      }
      continue;
    }

    visited.add(node.id);
    layers.set(node.id, layer);

    // Add children
    const children = outgoing.get(node.id) || new Set();
    children.forEach(childId => {
      const childNode = nodeMap.get(childId);
      if (childNode) {
        queue.push({ node: childNode, layer: layer + 1 });
      }
    });
  }

  return layers;
};

const buildAdjacencyLists = (edges: GraphEdge[]) => {
  const outgoing = new Map<string, Set<string>>(); // node -> nodes it connects TO
  const incoming = new Map<string, Set<string>>(); // node -> nodes that connect TO it

  edges.forEach(edge => {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, new Set());
    if (!incoming.has(edge.target)) incoming.set(edge.target, new Set());
    outgoing.get(edge.source)!.add(edge.target);
    incoming.get(edge.target)!.add(edge.source);
  });

  return { outgoing, incoming };
};

const computeBarycenter = (
  nodeId: string,
  adjacents: Set<string> | undefined,
  nodeOrders: Map<string, number>
): number => {
  if (!adjacents || adjacents.size === 0) return 0;
  let sum = 0;
  let count = 0;
  adjacents.forEach(adjId => {
    const order = nodeOrders.get(adjId);
    if (order !== undefined) {
      sum += order;
      count += 1;
    }
  });
  return count > 0 ? sum / count : 0;
};

// Compute hierarchical layout for connected and standalone nodes
export const computeHierarchicalLayout = (
  nodes: GraphNode[],
  edges: GraphEdge[]
): { connected: LayoutNode[]; standalone: LayoutNode[] } => {
  // Step 1: Find connected vs standalone nodes
  const { connected: connectedIds, standalone: standaloneIds } = findConnectedNodes(nodes, edges);
  const connectedNodes = nodes.filter(n => connectedIds.has(n.id));
  const standaloneNodes = nodes.filter(n => standaloneIds.has(n.id));

  // Step 2: Compute topological layers for connected nodes based on actual edges
  const topologicalLayers = computeTopologicalLayers(nodes, edges, connectedIds);
  const { outgoing, incoming } = buildAdjacencyLists(edges);

  // Step 3: Group nodes by layer
  const nodesByLayer = new Map<number, GraphNode[]>();
  connectedNodes.forEach(node => {
    const layer = topologicalLayers.get(node.id) || 0;
    if (!nodesByLayer.has(layer)) nodesByLayer.set(layer, []);
    nodesByLayer.get(layer)!.push(node);
  });

  // Step 4: Initial ordering within each layer based on type priority and name similarity
  const layerOrders = new Map<string, number>();
  nodesByLayer.forEach((layerNodes, layer) => {
    // Group similar nodes together
    const groups = new Map<string, GraphNode[]>();
    layerNodes.forEach(node => {
      const baseName = getBaseName(node.name);
      if (!groups.has(baseName)) groups.set(baseName, []);
      groups.get(baseName)!.push(node);
    });

    // Sort groups by type priority and group size
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      const aMinPriority = Math.min(...a[1].map(n => getTypePriority(n.type)));
      const bMinPriority = Math.min(...b[1].map(n => getTypePriority(n.type)));
      if (aMinPriority !== bMinPriority) return aMinPriority - bMinPriority;
      return b[1].length - a[1].length; // Larger groups first
    });

    let order = 0;
    sortedGroups.forEach(([, groupNodes]) => {
      groupNodes.sort((a, b) => {
        const priorityDiff = getTypePriority(a.type) - getTypePriority(b.type);
        if (priorityDiff !== 0) return priorityDiff;
        return a.name.localeCompare(b.name);
      });
      groupNodes.forEach(node => {
        layerOrders.set(node.id, order++);
      });
    });
  });

  // Step 5: Minimize edge crossings using barycenter heuristic
  const sortedLayers = Array.from(nodesByLayer.keys()).sort((a, b) => a - b);
  const NUM_ITERATIONS = 6;

  for (let iteration = 0; iteration < NUM_ITERATIONS; iteration++) {
    // Downward pass
    for (let i = 1; i < sortedLayers.length; i++) {
      const layer = sortedLayers[i];
      const layerNodes = nodesByLayer.get(layer) || [];

      const barycenters: { node: GraphNode; bc: number; originalOrder: number; groupId: string }[] = [];
      layerNodes.forEach(node => {
        const bc = computeBarycenter(node.id, incoming.get(node.id), layerOrders);
        barycenters.push({
          node,
          bc,
          originalOrder: layerOrders.get(node.id) || 0,
          groupId: getBaseName(node.name),
        });
      });

      barycenters.sort((a, b) => {
        if (a.bc !== b.bc) return a.bc - b.bc;
        if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId);
        return a.originalOrder - b.originalOrder;
      });

      barycenters.forEach((b, index) => {
        layerOrders.set(b.node.id, index);
      });
    }

    // Upward pass
    for (let i = sortedLayers.length - 2; i >= 0; i--) {
      const layer = sortedLayers[i];
      const layerNodes = nodesByLayer.get(layer) || [];

      const barycenters: { node: GraphNode; bc: number; originalOrder: number; groupId: string }[] = [];
      layerNodes.forEach(node => {
        const bc = computeBarycenter(node.id, outgoing.get(node.id), layerOrders);
        barycenters.push({
          node,
          bc,
          originalOrder: layerOrders.get(node.id) || 0,
          groupId: getBaseName(node.name),
        });
      });

      barycenters.sort((a, b) => {
        if (a.bc !== b.bc) return a.bc - b.bc;
        if (a.groupId !== b.groupId) return a.groupId.localeCompare(b.groupId);
        return a.originalOrder - b.originalOrder;
      });

      barycenters.forEach((b, index) => {
        layerOrders.set(b.node.id, index);
      });
    }
  }

  const connectedResult: LayoutNode[] = connectedNodes.map(node => ({
    node,
    layer: topologicalLayers.get(node.id) || 0,
    order: layerOrders.get(node.id) || 0,
    groupId: getBaseName(node.name),
  }));

  const standaloneByType = new Map<string, GraphNode[]>();
  standaloneNodes.forEach(node => {
    const type = node.type;
    if (!standaloneByType.has(type)) standaloneByType.set(type, []);
    standaloneByType.get(type)!.push(node);
  });

  const sortedTypes = Array.from(standaloneByType.keys()).sort((a, b) =>
    getTypePriority(a) - getTypePriority(b)
  );

  let standaloneOrder = 0;
  const standaloneResult: LayoutNode[] = [];
  sortedTypes.forEach(type => {
    const typeNodes = standaloneByType.get(type)!;
    typeNodes.sort((a, b) => a.name.localeCompare(b.name));
    typeNodes.forEach(node => {
      standaloneResult.push({
        node,
        layer: -1,
        order: standaloneOrder++,
        groupId: getBaseName(node.name),
      });
    });
  });

  return { connected: connectedResult, standalone: standaloneResult };
};
