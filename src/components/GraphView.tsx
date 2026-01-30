import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { GraphNode, GraphEdge, HealthStatus, ExternalApi } from '../types/electron';
import { DatabaseViewer } from './DatabaseViewer';

interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  isContainerView?: boolean;
  onDatabaseClick?: (node: GraphNode) => void;
}

interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  indexInLayer: number;
}

interface LayoutNode {
  node: GraphNode;
  layer: number;
  order: number; // Position within layer (0, 1, 2, ...)
  groupId: string;
}

// Color scheme for different service types
const SERVICE_COLORS: Record<string, { color: string; label: string }> = {
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

const getServiceColor = (type: string) => {
  return SERVICE_COLORS[type]?.color || '#6B7280';
};

// Health status colors and labels
const HEALTH_COLORS: Record<HealthStatus, { color: string; label: string; glow: string }> = {
  green: { color: '#22C55E', label: 'Active', glow: '0 0 8px #22C55E60' },
  yellow: { color: '#EAB308', label: 'Idle', glow: '0 0 8px #EAB30860' },
  red: { color: '#EF4444', label: 'Down', glow: '0 0 8px #EF444460' },
};

const getHealthInfo = (status: HealthStatus) => {
  return HEALTH_COLORS[status] || HEALTH_COLORS.yellow;
};

const getTypeBadge = (type: string) => {
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

const EXTERNAL_API_CACHE_TTL_MS = 60000;
const externalApiCache = new Map<string, { timestamp: number; apis: ExternalApi[] }>();
const externalApiInFlight = new Set<string>();

// Extract a normalized base name for grouping related services
const getBaseName = (name: string): string => {
  let base = name.toLowerCase().trim();
  base = base.replace(/[-_]?(server|api|service|app|client|worker|main|dev|prod|test)$/i, '');
  base = base.replace(/[-_]?\d+$/, '');
  base = base.replace(/[-_]+$/, '');
  return base || name.toLowerCase();
};

// Type priority for initial ordering (lower = higher in graph)
const getTypePriority = (type: string): number => {
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

  // Handle any unvisited connected nodes (in case of disconnected subgraphs within connected set)
  connectedNodes.forEach(node => {
    if (!visited.has(node.id)) {
      layers.set(node.id, 0);
    }
  });

  return layers;
};

// Build adjacency lists for the graph
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

// Barycenter method: compute average position of connected nodes in adjacent layer
const computeBarycenter = (
  _nodeId: string,
  adjacentNodeIds: Set<string> | undefined,
  nodeOrders: Map<string, number>
): number => {
  if (!adjacentNodeIds || adjacentNodeIds.size === 0) return Infinity;

  let sum = 0;
  let count = 0;
  adjacentNodeIds.forEach(adjId => {
    const order = nodeOrders.get(adjId);
    if (order !== undefined) {
      sum += order;
      count++;
    }
  });

  return count > 0 ? sum / count : Infinity;
};

// Hierarchical layout algorithm using topological ordering + barycenter refinement
const computeHierarchicalLayout = (
  nodes: GraphNode[],
  edges: GraphEdge[]
): { connected: LayoutNode[]; standalone: LayoutNode[] } => {
  if (nodes.length === 0) return { connected: [], standalone: [] };

  // Step 1: Separate connected and standalone nodes
  const { connected: connectedIds, standalone: standaloneIds } = findConnectedNodes(nodes, edges);
  const connectedNodes = nodes.filter(n => connectedIds.has(n.id));
  const standaloneNodes = nodes.filter(n => standaloneIds.has(n.id));

  // Step 2: Compute topological layers for connected nodes based on actual edges
  const topologicalLayers = computeTopologicalLayers(nodes, edges, connectedIds);

  const { outgoing, incoming } = buildAdjacencyLists(edges);

  // Step 3: Group connected nodes by layer
  const nodesByLayer = new Map<number, GraphNode[]>();
  connectedNodes.forEach(node => {
    const layer = topologicalLayers.get(node.id) || 0;
    if (!nodesByLayer.has(layer)) nodesByLayer.set(layer, []);
    nodesByLayer.get(layer)!.push(node);
  });

  // Step 4: Initial ordering within each layer - group by base name, sort by type priority
  const layerOrders = new Map<string, number>();

  nodesByLayer.forEach((layerNodes) => {
    // Group by base name
    const groups = new Map<string, GraphNode[]>();
    layerNodes.forEach(node => {
      const baseName = getBaseName(node.name);
      if (!groups.has(baseName)) groups.set(baseName, []);
      groups.get(baseName)!.push(node);
    });

    // Sort groups: multi-node groups first, then by type priority, then alphabetically
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      // Multi-node groups first
      if (a[1].length !== b[1].length) return b[1].length - a[1].length;
      // Then by lowest type priority in group
      const aMinPriority = Math.min(...a[1].map(n => getTypePriority(n.type)));
      const bMinPriority = Math.min(...b[1].map(n => getTypePriority(n.type)));
      if (aMinPriority !== bMinPriority) return aMinPriority - bMinPriority;
      // Then alphabetically
      return a[0].localeCompare(b[0]);
    });

    // Flatten and assign initial order
    let order = 0;
    sortedGroups.forEach(([, groupNodes]) => {
      groupNodes.sort((a, b) => {
        // Sort by type priority first, then alphabetically
        const priorityDiff = getTypePriority(a.type) - getTypePriority(b.type);
        if (priorityDiff !== 0) return priorityDiff;
        return a.name.localeCompare(b.name);
      });
      groupNodes.forEach(node => {
        layerOrders.set(node.id, order++);
      });
    });
  });

  // Step 5: Barycenter refinement - multiple passes to minimize crossings
  const sortedLayers = Array.from(nodesByLayer.keys()).sort((a, b) => a - b);
  const NUM_ITERATIONS = 6; // More iterations for better crossing minimization

  for (let iter = 0; iter < NUM_ITERATIONS; iter++) {
    // Forward pass: order based on connections from upper layers
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

      // Sort by barycenter, keeping groups together
      barycenters.sort((a, b) => {
        // If same group, keep original relative order
        if (a.groupId === b.groupId) return a.originalOrder - b.originalOrder;
        // Otherwise sort by barycenter
        if (a.bc === Infinity && b.bc === Infinity) return a.originalOrder - b.originalOrder;
        if (a.bc === Infinity) return 1;
        if (b.bc === Infinity) return -1;
        return a.bc - b.bc;
      });

      barycenters.forEach((item, idx) => {
        layerOrders.set(item.node.id, idx);
      });
    }

    // Backward pass: order based on connections to lower layers
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
        if (a.groupId === b.groupId) return a.originalOrder - b.originalOrder;
        if (a.bc === Infinity && b.bc === Infinity) return a.originalOrder - b.originalOrder;
        if (a.bc === Infinity) return 1;
        if (b.bc === Infinity) return -1;
        return a.bc - b.bc;
      });

      barycenters.forEach((item, idx) => {
        layerOrders.set(item.node.id, idx);
      });
    }
  }

  // Build connected layout result
  const connectedResult: LayoutNode[] = connectedNodes.map(node => ({
    node,
    layer: topologicalLayers.get(node.id) || 0,
    order: layerOrders.get(node.id) || 0,
    groupId: getBaseName(node.name),
  }));

  // Build standalone layout result - group by type
  const standaloneByType = new Map<string, GraphNode[]>();
  standaloneNodes.forEach(node => {
    const type = node.type;
    if (!standaloneByType.has(type)) standaloneByType.set(type, []);
    standaloneByType.get(type)!.push(node);
  });

  // Sort standalone types by priority and assign orders
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
        layer: -1, // Special layer for standalone
        order: standaloneOrder++,
        groupId: getBaseName(node.name),
      });
    });
  });

  return { connected: connectedResult, standalone: standaloneResult };
};

// Group layout nodes for rendering
interface RenderGroup {
  groupName: string;
  nodes: GraphNode[];
  isGroup: boolean;
  groupType?: string; // For container type grouping
}

// Container type grouping categories with display order
const CONTAINER_TYPE_ORDER: Record<string, number> = {
  frontend: 0,
  webserver: 1,
  backend: 2,
  nodejs: 3,
  python: 4,
  broker: 5,
  realtime: 6,
  worker: 7,
  cache: 8,
  database: 9,
  search: 10,
  service: 11,
};

// Group containers by their type (database, cache, backend, etc.)
const groupContainersByType = (nodes: GraphNode[]): RenderGroup[] => {
  const typeGroups = new Map<string, GraphNode[]>();

  nodes.forEach(node => {
    const type = node.type || 'service';
    if (!typeGroups.has(type)) {
      typeGroups.set(type, []);
    }
    typeGroups.get(type)!.push(node);
  });

  // Sort groups by the predefined order
  const sortedTypes = Array.from(typeGroups.keys()).sort((a, b) => {
    const orderA = CONTAINER_TYPE_ORDER[a] ?? 99;
    const orderB = CONTAINER_TYPE_ORDER[b] ?? 99;
    return orderA - orderB;
  });

  return sortedTypes.map(type => ({
    groupName: SERVICE_COLORS[type]?.label || type.charAt(0).toUpperCase() + type.slice(1),
    nodes: typeGroups.get(type)!.sort((a, b) => a.name.localeCompare(b.name)),
    isGroup: true,
    groupType: type,
  }));
};

// Container project structure - groups containers by project, then by type within each project
interface ContainerProject {
  projectName: string;
  typeGroups: RenderGroup[];
  totalContainers: number;
}

// Extract project name from container name (Docker Compose naming: project_service_1)
const extractProjectName = (containerName: string): string => {
  // Try to extract from Docker Compose naming convention
  const parts = containerName.split(/[-_]/);
  if (parts.length >= 2) {
    // Usually format is: project-service or project_service_1
    return parts[0];
  }
  return 'docker';
};

// Group containers by project first, then by type within each project
const groupContainersByProject = (nodes: GraphNode[]): ContainerProject[] => {
  // First, group by project
  const projectMap = new Map<string, GraphNode[]>();

  nodes.forEach(node => {
    const projectName = extractProjectName(node.name);
    if (!projectMap.has(projectName)) {
      projectMap.set(projectName, []);
    }
    projectMap.get(projectName)!.push(node);
  });

  // For each project, group by type
  const projects: ContainerProject[] = [];

  projectMap.forEach((projectNodes, projectName) => {
    const typeGroups = groupContainersByType(projectNodes);
    projects.push({
      projectName,
      typeGroups,
      totalContainers: projectNodes.length,
    });
  });

  // Sort projects by name
  return projects.sort((a, b) => a.projectName.localeCompare(b.projectName));
};

const groupLayoutNodes = (layoutNodes: LayoutNode[], layer: number): RenderGroup[] => {
  // Filter nodes for this layer and sort by order
  const layerNodes = layoutNodes
    .filter(ln => ln.layer === layer)
    .sort((a, b) => a.order - b.order);

  // Group by groupId to keep grouping stable across refreshes.
  const groupMap = new Map<string, RenderGroup>();
  const groupOrder: string[] = [];

  layerNodes.forEach(ln => {
    const groupId = ln.groupId.toLowerCase();
    if (!groupMap.has(groupId)) {
      groupOrder.push(groupId);
      groupMap.set(groupId, {
        groupName: ln.groupId.charAt(0).toUpperCase() + ln.groupId.slice(1),
        nodes: [],
        isGroup: false,
      });
    }
    groupMap.get(groupId)!.nodes.push(ln.node);
  });

  return groupOrder.map(groupId => {
    const group = groupMap.get(groupId)!;
    if (group.nodes.length > 1) group.isGroup = true;
    return group;
  });
};

export function GraphView({ nodes, edges, isContainerView = false, onDatabaseClick }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [displayNodes, setDisplayNodes] = useState<GraphNode[]>(nodes);
  const [displayEdges, setDisplayEdges] = useState<GraphEdge[]>(edges);
  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());
  const [zoom, setZoom] = useState(0.6);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ node: GraphNode; x: number; y: number } | null>(null);

  // Handle node click - navigate to database page for database containers, otherwise show detail panel
  const handleNodeClick = useCallback((node: GraphNode) => {
    if (isContainerView && node.isDockerContainer && node.type === 'database' && onDatabaseClick) {
      onDatabaseClick(node);
    } else {
      setSelectedNode(node);
    }
  }, [isContainerView, onDatabaseClick]);

  const orderCacheRef = useRef<Map<number, string[]>>(new Map());
  const groupOrderCacheRef = useRef<Map<number, string[]>>(new Map());
  const [, setExternalApiVersion] = useState(0);
  const [animationKey, setAnimationKey] = useState(0);

  // Create a stable key based on node IDs to trigger re-animation only on actual changes
  const nodeSetKey = useMemo(() => {
    return nodes.map(n => n.id).sort().join(',');
  }, [nodes]);

  const edgeSetKey = useMemo(() => {
    return edges.map(e => `${e.source}-${e.target}`).sort().join(',');
  }, [edges]);

  // Keep refs to latest nodes/edges for use in effect without causing re-runs
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Track previous keys to detect actual changes
  const prevNodeSetKeyRef = useRef<string | null>(null);
  const prevEdgeSetKeyRef = useRef<string | null>(null);
  const isInitialRenderRef = useRef(true);

  useEffect(() => {
    const nodesChanged = prevNodeSetKeyRef.current !== nodeSetKey;
    const edgesChanged = prevEdgeSetKeyRef.current !== edgeSetKey;

    // Skip if nothing changed
    if (!nodesChanged && !edgesChanged) {
      return;
    }

    // Update refs
    prevNodeSetKeyRef.current = nodeSetKey;
    prevEdgeSetKeyRef.current = edgeSetKey;

    // Only trigger animation if not initial render (tab switch)
    if (!isInitialRenderRef.current && nodesChanged) {
      setAnimationKey(k => k + 1);
    }

    // On initial render or when content changes, update immediately
    if (isInitialRenderRef.current) {
      isInitialRenderRef.current = false;
      setDisplayNodes(nodesRef.current);
      setDisplayEdges(edgesRef.current);
    } else {
      // Small delay for tab switches to allow animation setup
      const timer = setTimeout(() => {
        setDisplayNodes(nodesRef.current);
        setDisplayEdges(edgesRef.current);
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [nodeSetKey, edgeSetKey]);

  // Filter out external nodes
  const localNodes = useMemo(() => displayNodes.filter(n => {
    if (n.type === 'external') return false;
    if (n.id.includes('external-')) return false;
    if (/\d+\.\d+\.\d+\.\d+/.test(n.id)) return false;
    return true;
  }), [displayNodes]);

  // Filter edges to only include connections between local nodes
  const localEdges = useMemo(() => {
    const localNodeIds = new Set(localNodes.map(n => n.id));
    return displayEdges.filter(e => localNodeIds.has(e.source) && localNodeIds.has(e.target));
  }, [localNodes, displayEdges]);

  // Create a stable key for project paths to prevent unnecessary external API fetches
  const projectPathsKey = useMemo(() => {
    return Array.from(
      new Set(localNodes.map(node => node.projectPath).filter(Boolean))
    ).sort().join(',');
  }, [localNodes]);

  // Keep ref to localNodes for use in effect
  const localNodesRef = useRef(localNodes);
  localNodesRef.current = localNodes;

  useEffect(() => {
    if (!window.electronAPI?.getExternalApis) return;
    if (!projectPathsKey) return;

    const projectPaths = projectPathsKey.split(',').filter(Boolean);
    if (projectPaths.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        for (const projectPath of projectPaths) {
          if (cancelled) return;
          const cached = externalApiCache.get(projectPath);
          if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) continue;
          if (externalApiInFlight.has(projectPath)) continue;
          externalApiInFlight.add(projectPath);
          try {
            const apis = await window.electronAPI.getExternalApis(projectPath);
            if (cancelled) return;
            externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
            setExternalApiVersion(version => version + 1);
          } catch (error) {
            if (cancelled) return;
          } finally {
            externalApiInFlight.delete(projectPath);
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectPathsKey]);

  // Compute hierarchical layout (returns connected and standalone nodes separately)
  const { connected: connectedLayout, standalone: standaloneLayout } = useMemo(() =>
    computeHierarchicalLayout(localNodes, localEdges),
    [localNodes, localEdges]
  );

  // Stabilize connected node ordering to prevent jitter
  const stableConnectedLayout = useMemo(() => {
    const byLayer = new Map<number, LayoutNode[]>();
    connectedLayout.forEach(node => {
      if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
      byLayer.get(node.layer)!.push(node);
    });

    const stableOrders = new Map<string, number>();
    byLayer.forEach((layerNodes, layer) => {
      const groups = new Map<string, LayoutNode[]>();
      layerNodes.forEach(node => {
        if (!groups.has(node.groupId)) groups.set(node.groupId, []);
        groups.get(node.groupId)!.push(node);
      });

      const groupIds = Array.from(groups.keys());
      const groupOrderSeed = [...groupIds].sort((a, b) => {
        const aOrder = Math.min(...groups.get(a)!.map(n => n.order));
        const bOrder = Math.min(...groups.get(b)!.map(n => n.order));
        return aOrder - bOrder;
      });

      const cachedGroupOrder = groupOrderCacheRef.current.get(layer);
      const groupSet = new Set(groupIds);
      const sameGroupSet =
        cachedGroupOrder &&
        cachedGroupOrder.length === groupIds.length &&
        cachedGroupOrder.every(id => groupSet.has(id));
      const finalGroupOrder = sameGroupSet ? cachedGroupOrder : groupOrderSeed;
      groupOrderCacheRef.current.set(layer, finalGroupOrder);

      const cachedNodeOrder = orderCacheRef.current.get(layer) || [];
      const cachedIndex = new Map(cachedNodeOrder.map((id, idx) => [id, idx]));
      const finalNodeOrder: string[] = [];

      finalGroupOrder.forEach(groupId => {
        const nodes = groups.get(groupId) || [];
        nodes.sort((a, b) => {
          const aIdx = cachedIndex.get(a.node.id);
          const bIdx = cachedIndex.get(b.node.id);
          if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
          if (aIdx !== undefined) return -1;
          if (bIdx !== undefined) return 1;
          if (a.order !== b.order) return a.order - b.order;
          return a.node.id.localeCompare(b.node.id);
        });
        nodes.forEach(node => finalNodeOrder.push(node.node.id));
      });

      orderCacheRef.current.set(layer, finalNodeOrder);
      finalNodeOrder.forEach((id, index) => {
        stableOrders.set(id, index);
      });
    });

    return connectedLayout.map(node => ({
      ...node,
      order: stableOrders.get(node.node.id) ?? node.order,
    }));
  }, [connectedLayout]);

  // Get unique layers and sort them for connected topology
  const sortedLayers = useMemo(() => {
    const layers = new Set(stableConnectedLayout.map(ln => ln.layer));
    return Array.from(layers).sort((a, b) => a - b);
  }, [stableConnectedLayout]);

  // Group nodes by layer for rendering (dynamic layers based on topology)
  const layerGroups = useMemo(() => {
    const groups: Map<number, RenderGroup[]> = new Map();
    sortedLayers.forEach(layer => {
      groups.set(layer, groupLayoutNodes(stableConnectedLayout, layer));
    });
    return groups;
  }, [stableConnectedLayout, sortedLayers]);

  // Group standalone nodes for rendering
  const standaloneGroups = useMemo(() => {
    if (standaloneLayout.length === 0) return [];

    // Group by type for standalone services
    const byType = new Map<string, GraphNode[]>();
    standaloneLayout.forEach(ln => {
      const type = ln.node.type;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(ln.node);
    });

    const result: RenderGroup[] = [];
    byType.forEach((nodes, type) => {
      result.push({
        groupName: SERVICE_COLORS[type]?.label || type,
        nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
        isGroup: nodes.length > 1,
      });
    });

    return result.sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [standaloneLayout]);

  // Container projects for container view mode (grouped by project, then by type)
  const containerProjects = useMemo(() => {
    if (!isContainerView) return [];
    return groupContainersByProject(localNodes);
  }, [isContainerView, localNodes]);

  // Get layer label based on layer index and content
  const getLayerLabel = useCallback((layer: number, nodes: GraphNode[]): string => {
    // Analyze node types in this layer
    const types = new Set(nodes.map(n => n.type));

    if (layer === 0) {
      if (types.has('frontend')) return 'FRONTEND';
      return 'ENTRY POINTS';
    }

    if (types.has('database') || types.has('cache')) {
      if (types.size === 1 && types.has('database')) return 'DATABASE';
      if (types.size === 1 && types.has('cache')) return 'CACHE';
      return 'DATA LAYER';
    }

    if (types.has('backend') || types.has('webserver') || types.has('nodejs') || types.has('python')) {
      return `TIER ${layer}`;
    }

    if (types.has('broker') || types.has('realtime')) {
      return 'MESSAGING';
    }

    if (types.has('worker') || types.has('client')) {
      return 'WORKERS';
    }

    return `TIER ${layer}`;
  }, []);

  // Create connection list from edges
  const connections = useMemo(() =>
    localEdges.map(edge => ({
      from: edge.source,
      to: edge.target,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
    })),
    [localEdges]
  );

  const zoomStep = 0.05;
  const clampZoom = useCallback((value: number) => Math.max(0.4, Math.min(2, value)), []);

  // Zoom handlers
  const handleZoomIn = () => setZoom(z => clampZoom(z + zoomStep));
  const handleZoomOut = () => setZoom(z => clampZoom(z - zoomStep));
  const handleZoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Pan handlers with requestAnimationFrame for smooth movement
  const rafRef = useRef<number | null>(null);
  const panRef = useRef(pan);
  panRef.current = pan;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (selectedNode || contextMenu) return;
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y });
  }, [selectedNode, contextMenu]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (selectedNode || contextMenu) return;
    if (!isDragging) return;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      setPan({ x: newX, y: newY });
    });
  }, [isDragging, dragStart, selectedNode, contextMenu]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.closest('.node-detail-panel') || target.closest('.context-menu')) {
          return;
        }
      }
      e.preventDefault();
      const direction = e.deltaY > 0 ? -1 : 1;
      setZoom(z => clampZoom(z + direction * zoomStep));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [clampZoom]);

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, node: GraphNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ node, x: e.clientX, y: e.clientY });
  }, []);

  // Close context menu on Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  // Build layer mapping for nodes (both connected and standalone)
  const nodeLayerMap = useMemo(() => {
    const map = new Map<string, { layer: number; indexInLayer: number }>();
    stableConnectedLayout.forEach(ln => {
      map.set(ln.node.id, { layer: ln.layer, indexInLayer: ln.order });
    });
    // Standalone nodes get a special layer (-1)
    standaloneLayout.forEach(ln => {
      map.set(ln.node.id, { layer: -1, indexInLayer: ln.order });
    });
    return map;
  }, [stableConnectedLayout, standaloneLayout]);

  // Calculate node positions after render
  useEffect(() => {
    if (!canvasRef.current) return;

    const updatePositions = () => {
      const positions = new Map<string, NodePosition>();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const canvasRect = canvas.getBoundingClientRect();

      localNodes.forEach(node => {
        const element = canvas.querySelector(`[data-node-id="${node.id}"]`);
        if (element) {
          const rect = element.getBoundingClientRect();
          const layerInfo = nodeLayerMap.get(node.id) || { layer: 0, indexInLayer: 0 };
          positions.set(node.id, {
            x: (rect.left - canvasRect.left + rect.width / 2) / zoom,
            y: (rect.top - canvasRect.top + rect.height / 2) / zoom,
            width: rect.width / zoom,
            height: rect.height / zoom,
            layer: layerInfo.layer,
            indexInLayer: layerInfo.indexInLayer,
          });
        }
      });

      setNodePositions(positions);
    };

    const timer = setTimeout(updatePositions, 150);
    return () => clearTimeout(timer);
  }, [localNodes, nodeLayerMap, zoom]);

  // Edge routing with simple smooth bezier curves
  const edgeRoutes = useMemo(() => {
    if (nodePositions.size === 0) return [];

    const routes: {
      from: string;
      to: string;
      path: string;
    }[] = [];

    connections.forEach((conn) => {
      const from = nodePositions.get(conn.from);
      const to = nodePositions.get(conn.to);
      if (!from || !to) return;

      const sourceBottom = from.y + from.height / 2;
      const sourceTop = from.y - from.height / 2;
      const targetTop = to.y - to.height / 2;
      const targetBottom = to.y + to.height / 2;

      let path: string;

      if (from.layer === to.layer) {
        // Same layer - smooth arc above the nodes
        const arcY = Math.min(sourceTop, targetTop) - 40;
        const midX = (from.x + to.x) / 2;
        path = `M ${from.x} ${sourceTop} Q ${midX} ${arcY}, ${to.x} ${targetTop}`;
      } else {
        // Different layers - use simple cubic bezier S-curve
        const goingDown = from.layer < to.layer;
        const startY = goingDown ? sourceBottom : sourceTop;
        const endY = goingDown ? targetTop : targetBottom;

        // Calculate control points for smooth S-curve
        const verticalDist = Math.abs(endY - startY);
        const controlOffset = Math.min(verticalDist * 0.4, 60);

        // Simple vertical bezier curve
        path = `M ${from.x} ${startY} C ${from.x} ${startY + (goingDown ? controlOffset : -controlOffset)}, ${to.x} ${endY + (goingDown ? -controlOffset : controlOffset)}, ${to.x} ${endY}`;
      }

      routes.push({
        from: conn.from,
        to: conn.to,
        path,
      });
    });

    return routes;
  }, [nodePositions, connections]);

  if (localNodes.length === 0) {
    return (
      <div className="graph-view" ref={containerRef}>
        <div className="graph-empty">
          <p>No services running</p>
          <span>Start a dev server to see the connection graph</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="graph-view"
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: selectedNode || contextMenu ? 'default' : isDragging ? 'grabbing' : 'grab' }}
    >
      {/* Legend */}
      <div className="graph-legend">
        <div className="graph-legend-title">Service Types</div>
        {Array.from(new Set(localNodes.map(n => n.type)))
          .filter(type => SERVICE_COLORS[type])
          .map(type => (
            <div key={type} className="graph-legend-item">
              <div
                className="graph-legend-dot"
                style={{ backgroundColor: SERVICE_COLORS[type].color }}
              />
              <span>{SERVICE_COLORS[type].label}</span>
            </div>
          ))}
      </div>

      {/* Zoom Controls */}
      <div className="graph-controls">
        <button className="graph-control-btn" onClick={handleZoomIn} title="Zoom In">+</button>
        <button className="graph-control-btn" onClick={handleZoomReset} title="Reset">⟲</button>
        <button className="graph-control-btn" onClick={handleZoomOut} title="Zoom Out">−</button>
        <span className="graph-zoom-level">{Math.round(zoom * 100)}%</span>
      </div>

      {/* Zoomable/Pannable Canvas */}
      <div
        className="graph-canvas"
        ref={canvasRef}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      >
        {/* Connection lines SVG - only show in graph view, not container view */}
        {!isContainerView && (
          <svg className="graph-connections">
            <defs>
              <marker
                id="arrowhead"
                markerWidth="10"
                markerHeight="10"
                refX="9"
                refY="5"
                orient="auto"
                markerUnits="userSpaceOnUse"
              >
                <path
                  d="M 0 1 L 8 5 L 0 9"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </marker>
            </defs>

            {edgeRoutes.map((route, i) => (
              <path
                key={`${route.from}-${route.to}-${i}`}
                d={route.path}
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                markerEnd="url(#arrowhead)"
                className="graph-edge"
              />
            ))}
          </svg>
        )}

        {/* Container View: Project containers with type groups inside */}
        {isContainerView ? (
          <div className="container-projects-view" key={`containers-${animationKey}`}>
            {containerProjects.map((project, projectIdx) => (
              <ProjectContainer
                key={`project-${project.projectName}`}
                project={project}
                onNodeClick={handleNodeClick}
                onContextMenu={handleContextMenu}
                animationDelay={projectIdx * 150}
              />
            ))}
          </div>
        ) : (
          /* Regular Service Map: Layered nodes based on topology */
          <div className="graph-layers" key={`layers-${animationKey}`}>
            {sortedLayers.map((layer, layerIdx) => {
              const groups = layerGroups.get(layer) || [];
              const allNodes = groups.flatMap(g => g.nodes);
              if (allNodes.length === 0) return null;

              // Calculate base animation index for this layer
              let nodeIndex = layerIdx * 2;

              return (
                <div key={`layer-${layer}`} className="graph-layer" style={{ animationDelay: `${layerIdx * 80}ms` }}>
                  <div className="graph-layer-label">{getLayerLabel(layer, allNodes)}</div>
                  <div className="graph-layer-nodes">
                    {groups.map((group, index) => {
                      const currentIndex = nodeIndex;
                      nodeIndex += group.nodes.length;
                      return (
                        <NodeGroupContainer
                          key={`layer${layer}-${group.groupName}-${index}`}
                          group={group}
                          onNodeClick={handleNodeClick}
                          onContextMenu={handleContextMenu}
                          baseIndex={currentIndex}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Standalone Services Section */}
            {standaloneGroups.length > 0 && (
              <div className="graph-layer graph-layer-standalone" style={{ animationDelay: `${sortedLayers.length * 80 + 50}ms` }}>
                <div className="graph-layer-label">STANDALONE SERVICES</div>
                <div className="graph-layer-nodes">
                  {standaloneGroups.map((group, index) => {
                    const baseIndex = sortedLayers.length * 2 + index * 2;
                    return (
                      <NodeGroupContainer
                        key={`standalone-${group.groupName}-${index}`}
                        group={group}
                        onNodeClick={handleNodeClick}
                        onContextMenu={handleContextMenu}
                        baseIndex={baseIndex}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          node={contextMenu.node}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Node Detail Panel */}
      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          edges={localEdges}
          allNodes={localNodes}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}

// Project Container - Big box containing all containers for a Docker project
function ProjectContainer({ project, onNodeClick, onContextMenu, animationDelay = 0 }: {
  project: ContainerProject;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationDelay?: number;
}) {
  return (
    <div
      className="project-container"
      style={{ animationDelay: `${animationDelay}ms` } as React.CSSProperties}
    >
      {/* Project Header */}
      <div className="project-container-header">
        <svg className="project-docker-icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
          <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
        </svg>
        <span className="project-container-name">{project.projectName.toUpperCase()}</span>
        <span className="project-container-count">{project.totalContainers} containers</span>
      </div>

      {/* Type Groups Grid */}
      <div className="project-type-groups">
        {project.typeGroups.map((group, groupIdx) => (
          <TypeGroupBox
            key={`${project.projectName}-${group.groupType || group.groupName}`}
            group={group}
            onNodeClick={onNodeClick}
            onContextMenu={onContextMenu}
            animationDelay={animationDelay + groupIdx * 80}
          />
        ))}
      </div>
    </div>
  );
}

// Type Group Box - Smaller box inside project container for each service type
function TypeGroupBox({ group, onNodeClick, onContextMenu, animationDelay = 0 }: {
  group: RenderGroup;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationDelay?: number;
}) {
  const typeColor = group.groupType ? getServiceColor(group.groupType) : '#6B7280';
  const nodeCount = group.nodes.length;

  return (
    <div
      className="type-group-box"
      style={{
        '--type-color': typeColor,
        animationDelay: `${animationDelay}ms`,
      } as React.CSSProperties}
    >
      <div className="type-group-header">
        <div
          className="type-group-indicator"
          style={{ backgroundColor: typeColor }}
        />
        <span className="type-group-label">{group.groupName}</span>
        {nodeCount > 1 && <span className="type-group-count">{nodeCount}</span>}
      </div>
      <div className="type-group-nodes">
        {group.nodes.map((node, idx) => (
          <CompactServiceNode
            key={node.id}
            node={node}
            onClick={onNodeClick}
            onContextMenu={onContextMenu}
            animationIndex={idx}
          />
        ))}
      </div>
    </div>
  );
}

// Compact Service Node for container view - enhanced styling with blue theme
function CompactServiceNode({ node, onClick, onContextMenu, animationIndex = 0 }: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationIndex?: number;
}) {
  const healthInfo = getHealthInfo(node.healthStatus);
  const mainPort = node.ports[0]?.port;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(node);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, node);
  };

  return (
    <div
      data-node-id={node.id}
      className="compact-service-node"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={{
        animationDelay: `${animationIndex * 40}ms`,
      } as React.CSSProperties}
    >
      {/* Header with status and type badge */}
      <div className="compact-node-header">
        <div className="compact-node-status">
          <div
            className="compact-node-health"
            style={{
              backgroundColor: healthInfo.color,
              boxShadow: healthInfo.glow,
            }}
          />
          <span
            className="compact-node-health-label"
            style={{ color: healthInfo.color }}
          >
            {healthInfo.label}
          </span>
        </div>
        <span className="compact-node-badge">
          {getTypeBadge(node.type)}
        </span>
      </div>

      {/* Container name */}
      <h4 className="compact-node-name">{node.name}</h4>

      {/* Docker image */}
      {node.containerImage && (
        <div className="compact-node-image" title={node.containerImage}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
            <circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          <span>{node.containerImage.split('/').pop()?.split(':')[0]}</span>
        </div>
      )}

      {/* Port info */}
      {mainPort && (
        <div className="compact-node-port">
          <span className="compact-port-host">localhost</span>
          <span className="compact-port-number">:{mainPort}</span>
        </div>
      )}

      {/* Networks */}
      {node.containerNetworks && node.containerNetworks.length > 0 && (
        <div className="compact-node-networks">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="2" y1="12" x2="22" y2="12"/>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
          <span className="compact-networks-list">
            {node.containerNetworks.slice(0, 2).map(n => n.name).join(', ')}
            {node.containerNetworks.length > 2 && ` +${node.containerNetworks.length - 2}`}
          </span>
        </div>
      )}
    </div>
  );
}

// Node Group Container
function NodeGroupContainer({ group, onNodeClick, onContextMenu, baseIndex = 0 }: {
  group: RenderGroup;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  baseIndex?: number;
}) {
  if (!group.isGroup) {
    return <ServiceNode node={group.nodes[0]} onClick={onNodeClick} onContextMenu={onContextMenu} animationIndex={baseIndex} />;
  }

  const groupCount = group.nodes.length;
  const columnCount = Math.max(2, Math.ceil(Math.sqrt(groupCount)));
  const groupStyle = {
    ['--group-columns' as string]: columnCount,
    ['--group-span' as string]: columnCount,
    animationDelay: `${baseIndex * 50}ms`,
  } as React.CSSProperties;

  return (
    <div className="node-group" style={groupStyle}>
      <div className="node-group-label">{group.groupName}</div>
      <div className="node-group-nodes">
        {group.nodes.map((node, idx) => (
          <ServiceNode key={node.id} node={node} onClick={onNodeClick} onContextMenu={onContextMenu} animationIndex={baseIndex + idx} />
        ))}
      </div>
    </div>
  );
}

// Service Node Component
function ServiceNode({ node, onClick, onContextMenu, animationIndex = 0 }: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationIndex?: number;
}) {
  const accentColor = getServiceColor(node.type);
  const healthInfo = getHealthInfo(node.healthStatus);
  const mainPort = node.ports[0]?.port;
  const routes = node.routes || [];
  const visibleRoutes = routes.slice(0, 3);
  // Don't show external APIs for Docker containers - they're isolated and shouldn't scan project code
  const externalApis = (node.projectPath && !node.isDockerContainer)
    ? (externalApiCache.get(node.projectPath)?.apis || [])
    : [];
  const visibleApis = externalApis.slice(0, 3);
  const projectLabel = node.projectPath ? node.projectPath.split('/').pop() : null;

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent pan/drag from triggering
    onClick(node);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, node);
  };

  return (
    <div
      data-node-id={node.id}
      className="service-node"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={{
        '--node-color': accentColor,
        animationDelay: `${animationIndex * 50}ms`,
      } as React.CSSProperties}
    >
      <div className="service-node-header">
        <div className="service-node-status-row">
          <div
            className="service-node-health-dot"
            style={{
              backgroundColor: healthInfo.color,
              boxShadow: healthInfo.glow,
            }}
            title={healthInfo.label}
          />
          <span
            className="service-node-health-label"
            style={{ color: healthInfo.color }}
          >
            {healthInfo.label}
          </span>
          {node.isDockerContainer && (
            <span className="service-node-docker-badge" title="Docker Container">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
              </svg>
            </span>
          )}
        </div>
        <span
          className="service-node-badge"
          style={{
            backgroundColor: `${accentColor}15`,
            color: accentColor,
          }}
        >
          {getTypeBadge(node.type)}
        </span>
      </div>

      <h3 className="service-node-name">{node.name}</h3>
      {node.isDockerContainer && node.containerImage && (
        <div className="service-node-docker-image" title={node.containerImage}>
          {node.containerImage.split('/').pop()?.split(':')[0] || node.containerImage}
        </div>
      )}
      {!node.isDockerContainer && projectLabel && (
        <div className="service-node-project">{projectLabel}</div>
      )}

      <div className="service-node-port">
        <span className="service-node-port-host">localhost</span>
        <span className="service-node-port-number" style={{ color: accentColor }}>
          :{mainPort || '?'}
        </span>
      </div>

      {/* Docker container networks */}
      {node.isDockerContainer && node.containerNetworks && node.containerNetworks.length > 0 && (
        <div className="service-node-docker-networks">
          <span className="service-node-docker-networks-label">Networks:</span>
          <span className="service-node-docker-networks-list">
            {node.containerNetworks.slice(0, 2).map(n => n.name).join(', ')}
            {node.containerNetworks.length > 2 && ` +${node.containerNetworks.length - 2}`}
          </span>
        </div>
      )}

      {routes.length > 0 && (
        <div className="service-node-routes">
          <div className="service-node-routes-header">
            <span className="service-node-routes-title">API routes</span>
            <span className="service-node-routes-count">{routes.length}</span>
          </div>
          <div className="service-node-routes-list">
            {visibleRoutes.map(route => (
              <div key={`${route.method}-${route.path}`} className="service-route">
                <span className={`route-method route-${route.method.toLowerCase()}`}>
                  {route.method}
                </span>
                <span className="route-path">{route.path}</span>
              </div>
            ))}
            {routes.length > visibleRoutes.length && (
              <div className="service-route-more">
                +{routes.length - visibleRoutes.length} more
              </div>
            )}
          </div>
        </div>
      )}

      {externalApis.length > 0 && (
        <div className="service-node-apis">
          <div className="service-node-apis-header">
            <span className="service-node-apis-title">External APIs</span>
            <span className="service-node-apis-count">{externalApis.length}</span>
          </div>
          <div className="service-node-apis-list">
            {visibleApis.map(api => (
              <div key={api.name} className="service-api">
                {api.name}
              </div>
            ))}
            {externalApis.length > visibleApis.length && (
              <div className="service-api-more">
                +{externalApis.length - visibleApis.length} more
              </div>
            )}
          </div>
        </div>
      )}

    </div>
  );
}

// Node Detail Panel Component
interface NodeDetailPanelProps {
  node: GraphNode;
  edges: GraphEdge[];
  allNodes: GraphNode[];
  onClose: () => void;
}

function NodeDetailPanel({ node, edges, allNodes, onClose }: NodeDetailPanelProps) {
  const accentColor = getServiceColor(node.type);
  const healthInfo = getHealthInfo(node.healthStatus);
  const routes = node.routes || [];
  const [externalApis, setExternalApis] = useState<ExternalApi[]>([]);
  const [externalApiLoading, setExternalApiLoading] = useState(false);
  const [externalApiError, setExternalApiError] = useState<string | null>(null);

  // Format last seen time
  const formatLastSeen = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 1000) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  };

  // Find connections to/from this node
  const incomingEdges = edges.filter(e => e.target === node.id);
  const outgoingEdges = edges.filter(e => e.source === node.id);

  // Get connected node names
  const getNodeName = (id: string) => allNodes.find(n => n.id === id)?.name || id;

  // Handle click outside to close
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Stop wheel events from propagating to the graph (prevents zoom while scrolling)
  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
  };

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  useEffect(() => {
    let active = true;
    const projectPath = node.projectPath;

    // Don't show external APIs for Docker containers - they're isolated and shouldn't scan project code
    if (!projectPath || node.isDockerContainer) {
      setExternalApis([]);
      setExternalApiLoading(false);
      setExternalApiError(null);
      return () => {
        active = false;
      };
    }

    const cached = externalApiCache.get(projectPath);
    if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) {
      setExternalApis(cached.apis);
      setExternalApiLoading(false);
      setExternalApiError(null);
      return () => {
        active = false;
      };
    }

    setExternalApiLoading(true);
    setExternalApiError(null);

    (async () => {
      try {
        if (!window.electronAPI?.getExternalApis) {
          throw new Error('External API scan unavailable');
        }
        const apis = await window.electronAPI.getExternalApis(projectPath);
        if (!active) return;
        externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
        setExternalApis(apis);
        setExternalApiLoading(false);
      } catch (error) {
        if (!active) return;
        setExternalApis([]);
        setExternalApiLoading(false);
        setExternalApiError(error instanceof Error ? error.message : 'Failed to load external APIs');
      }
    })();

    return () => {
      active = false;
    };
  }, [node.projectPath, node.isDockerContainer]);

  return (
    <div className="node-detail-backdrop" onClick={handleBackdropClick} onWheel={handleWheel}>
      <div
        className="node-detail-panel"
        onMouseDown={e => e.stopPropagation()}
        onWheel={e => e.stopPropagation()}
        onMouseDownCapture={e => e.stopPropagation()}
        onWheelCapture={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="node-detail-header">
          <div className="node-detail-title-row">
            <div
              className="node-detail-dot"
              style={{
                backgroundColor: accentColor,
                boxShadow: `0 0 12px ${accentColor}50`,
              }}
            />
            <div className="node-detail-title-info">
              <h2 className="node-detail-name">{node.name}</h2>
              <span
                className="node-detail-badge"
                style={{
                  backgroundColor: `${accentColor}15`,
                  color: accentColor,
                }}
              >
                {getTypeBadge(node.type)}
              </span>
            </div>
          </div>
          <button className="node-detail-close" onClick={onClose}>×</button>
        </div>

        {/* Content */}
        <div className="node-detail-content">
          {/* Health Status Section */}
          <div className="node-detail-section">
            <h3 className="node-detail-section-title">Health Status</h3>
            <div className="node-detail-health">
              <div className="node-detail-health-indicator">
                <div
                  className="node-detail-health-dot"
                  style={{
                    backgroundColor: healthInfo.color,
                    boxShadow: healthInfo.glow,
                  }}
                />
                <span
                  className="node-detail-health-label"
                  style={{ color: healthInfo.color }}
                >
                  {healthInfo.label}
                </span>
              </div>
              <div className="node-detail-health-meta">
                <span className="node-detail-label">Last seen</span>
                <span className="node-detail-value">{formatLastSeen(node.lastSeen)}</span>
              </div>
            </div>
          </div>

          {/* Description Section (if available) */}
          {node.description && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">About</h3>
              <p className="node-detail-description">{node.description}</p>
            </div>
          )}

          {/* Process Info Section (for non-Docker nodes) */}
          {!node.isDockerContainer && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">Process Information</h3>
              <div className="node-detail-grid">
                <div className="node-detail-item">
                  <span className="node-detail-label">PID</span>
                  <span className="node-detail-value mono">{node.pid}</span>
                </div>
                <div className="node-detail-item">
                  <span className="node-detail-label">User</span>
                  <span className="node-detail-value">{node.user}</span>
                </div>
                <div className="node-detail-item">
                  <span className="node-detail-label">CPU</span>
                  <span className="node-detail-value mono">{node.cpu.toFixed(1)}%</span>
                </div>
                <div className="node-detail-item">
                  <span className="node-detail-label">Memory</span>
                  <span className="node-detail-value mono">{node.memory.toFixed(1)}%</span>
                </div>
              </div>
            </div>
          )}

          {/* Docker Container Info Section */}
          {node.isDockerContainer && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
                  <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
                </svg>
                Container Information
              </h3>
              <div className="node-detail-grid">
                <div className="node-detail-item">
                  <span className="node-detail-label">Container ID</span>
                  <span className="node-detail-value mono">{node.containerId?.substring(0, 12)}</span>
                </div>
                <div className="node-detail-item">
                  <span className="node-detail-label">State</span>
                  <span className={`node-detail-value docker-state docker-state-${node.containerState}`}>
                    {node.containerState}
                  </span>
                </div>
                <div className="node-detail-item">
                  <span className="node-detail-label">CPU</span>
                  <span className="node-detail-value mono">{node.cpu.toFixed(1)}%</span>
                </div>
                <div className="node-detail-item">
                  <span className="node-detail-label">Memory</span>
                  <span className="node-detail-value mono">
                    {node.memoryUsage || `${node.memory.toFixed(1)}%`}
                  </span>
                </div>
              </div>
              <div className="node-detail-item full-width" style={{ marginTop: '8px' }}>
                <span className="node-detail-label">Image</span>
                <span className="node-detail-value mono small">{node.containerImage}</span>
              </div>
              {node.containerStatus && (
                <div className="node-detail-item full-width" style={{ marginTop: '4px' }}>
                  <span className="node-detail-label">Status</span>
                  <span className="node-detail-value small">{node.containerStatus}</span>
                </div>
              )}
            </div>
          )}

          {/* Database Viewer for database containers */}
          {node.isDockerContainer && node.type === 'database' && node.containerId && node.containerImage && (
            <DatabaseViewer
              containerId={node.containerId}
              containerImage={node.containerImage}
            />
          )}

          {/* Docker Container Health Section */}
          {node.isDockerContainer && node.containerHealth && node.containerHealth.status !== 'unknown' && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">Container Health</h3>
              <div className="node-detail-docker-health">
                <div className={`docker-health-status docker-health-${node.containerHealth.status}`}>
                  {node.containerHealth.status}
                </div>
                {node.containerHealth.failingStreak !== undefined && node.containerHealth.failingStreak > 0 && (
                  <div className="docker-health-failing">
                    Failing streak: {node.containerHealth.failingStreak}
                  </div>
                )}
                {node.containerHealth.checks && node.containerHealth.checks.length > 0 && (
                  <div className="docker-health-checks">
                    <span className="docker-health-checks-label">Recent checks:</span>
                    {node.containerHealth.checks.map((check, idx) => (
                      <div key={idx} className={`docker-health-check ${check.exitCode === 0 ? 'success' : 'failure'}`}>
                        <span className="docker-health-check-code">Exit: {check.exitCode}</span>
                        {check.output && (
                          <span className="docker-health-check-output">{check.output.substring(0, 50)}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Docker Networks Section */}
          {node.isDockerContainer && node.containerNetworks && node.containerNetworks.length > 0 && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                Networks <span className="node-detail-count">{node.containerNetworks.length}</span>
              </h3>
              <div className="node-detail-docker-networks">
                {node.containerNetworks.map((network, idx) => (
                  <div key={idx} className="docker-network-item">
                    <div className="docker-network-name">{network.name}</div>
                    <div className="docker-network-details">
                      {network.ipAddress && (
                        <span className="docker-network-ip">IP: {network.ipAddress}</span>
                      )}
                      {network.gateway && (
                        <span className="docker-network-gateway">Gateway: {network.gateway}</span>
                      )}
                    </div>
                    {network.aliases && network.aliases.length > 0 && (
                      <div className="docker-network-aliases">
                        Aliases: {network.aliases.join(', ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Docker Mounts/Volumes Section */}
          {node.isDockerContainer && node.containerMounts && node.containerMounts.length > 0 && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                Volumes & Mounts <span className="node-detail-count">{node.containerMounts.length}</span>
              </h3>
              <div className="node-detail-docker-mounts">
                {node.containerMounts.map((mount, idx) => (
                  <div key={idx} className="docker-mount-item">
                    <div className="docker-mount-header">
                      <span className={`docker-mount-type docker-mount-type-${mount.type}`}>
                        {mount.type}
                      </span>
                      {!mount.readWrite && (
                        <span className="docker-mount-readonly">read-only</span>
                      )}
                    </div>
                    <div className="docker-mount-paths">
                      <div className="docker-mount-source" title={mount.source}>
                        {mount.name || mount.source.split('/').slice(-2).join('/')}
                      </div>
                      <span className="docker-mount-arrow">→</span>
                      <div className="docker-mount-dest" title={mount.destination}>
                        {mount.destination}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Docker Container Ports Section */}
          {node.isDockerContainer && node.containerPorts && node.containerPorts.length > 0 && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                Container Ports <span className="node-detail-count">{node.containerPorts.length}</span>
              </h3>
              <div className="node-detail-docker-ports">
                {node.containerPorts.map((port, idx) => (
                  <div key={idx} className="docker-port-item">
                    {port.type === 'mapped' ? (
                      <>
                        <span className="docker-port-host">
                          {port.hostIp}:{port.hostPort}
                        </span>
                        <span className="docker-port-arrow">→</span>
                        <span className="docker-port-container">
                          {port.containerPort}/{port.protocol}
                        </span>
                      </>
                    ) : (
                      <span className="docker-port-exposed">
                        {port.containerPort}/{port.protocol} (exposed)
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Command Section */}
          <div className="node-detail-section">
            <h3 className="node-detail-section-title">Command</h3>
            <div className="node-detail-command">{node.command}</div>
          </div>

          {/* Project Info (if available) */}
          {(node.project || node.projectPath) && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">Project</h3>
              <div className="node-detail-grid">
                {node.project && (
                  <div className="node-detail-item full-width">
                    <span className="node-detail-label">Name</span>
                    <span className="node-detail-value">{node.project}</span>
                  </div>
                )}
                {node.projectPath && (
                  <div className="node-detail-item full-width">
                    <span className="node-detail-label">Path</span>
                    <span className="node-detail-value mono small">{node.projectPath}</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Ports Section */}
          {node.ports.length > 0 && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                Ports <span className="node-detail-count">{node.ports.length}</span>
              </h3>
              <div className="node-detail-ports">
                {node.ports.map((port, idx) => (
                  <div key={idx} className="node-detail-port">
                    <span className="node-detail-port-number" style={{ color: accentColor }}>
                      :{port.port}
                    </span>
                    <span className="node-detail-port-host">{port.host}</span>
                    {port.description && (
                      <span className="node-detail-port-desc">{port.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* API Routes Section */}
          {routes.length > 0 && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                API Routes <span className="node-detail-count">{routes.length}</span>
              </h3>
              <div className="node-detail-routes">
                {routes.map((route, idx) => (
                  <div key={idx} className="node-detail-route">
                    <span className={`route-method route-${route.method.toLowerCase()}`}>
                      {route.method}
                    </span>
                    <span className="node-detail-route-path">{route.path}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* External APIs Section */}
          {(externalApiLoading || externalApiError || externalApis.length > 0) && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">
                External APIs
                {externalApis.length > 0 && (
                  <span className="node-detail-count">{externalApis.length}</span>
                )}
              </h3>
              {externalApiLoading && (
                <div className="node-detail-apis">
                  <div className="node-detail-api">Scanning project for APIs…</div>
                </div>
              )}
              {externalApiError && !externalApiLoading && (
                <div className="node-detail-apis">
                  <div className="node-detail-api">{externalApiError}</div>
                </div>
              )}
              {!externalApiLoading && !externalApiError && (
                <div className="node-detail-apis">
                  {externalApis.map((api, idx) => (
                    <div key={`${api.name}-${idx}`} className="node-detail-api">
                      <span className="node-detail-api-name">{api.name}</span>
                      {api.hosts && api.hosts.length > 0 && (
                        <span className="node-detail-api-hosts">{api.hosts.join(', ')}</span>
                      )}
                      {api.matchedOn.length > 0 && (
                        <span className="node-detail-api-meta">{api.matchedOn.join(' · ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Connections Section */}
          {(incomingEdges.length > 0 || outgoingEdges.length > 0) && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">Connections</h3>
              <div className="node-detail-connections">
                {incomingEdges.length > 0 && (
                  <div className="node-detail-connection-group">
                    <span className="node-detail-connection-label">Incoming</span>
                    {incomingEdges.map((edge, idx) => (
                      <div key={idx} className="node-detail-connection">
                        <span className="connection-arrow">←</span>
                        <span className="connection-node">{getNodeName(edge.source)}</span>
                        <span className="connection-port">:{edge.sourcePort} → :{edge.targetPort}</span>
                      </div>
                    ))}
                  </div>
                )}
                {outgoingEdges.length > 0 && (
                  <div className="node-detail-connection-group">
                    <span className="node-detail-connection-label">Outgoing</span>
                    {outgoingEdges.map((edge, idx) => (
                      <div key={idx} className="node-detail-connection">
                        <span className="connection-arrow">→</span>
                        <span className="connection-node">{getNodeName(edge.target)}</span>
                        <span className="connection-port">:{edge.sourcePort} → :{edge.targetPort}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Context Menu Component
interface ContextMenuProps {
  node: GraphNode;
  x: number;
  y: number;
  onClose: () => void;
}

function ContextMenu({ node, x, y, onClose }: ContextMenuProps) {
  const hasPort = node.ports.length > 0;
  const hasProjectPath = !!node.projectPath;
  const isExternal = node.type === 'external';
  const mainPort = node.ports[0]?.port;

  // Adjust position to prevent overflow off screen
  const menuStyle: React.CSSProperties = {
    position: 'fixed',
    left: Math.min(x, window.innerWidth - 200),
    top: Math.min(y, window.innerHeight - 250),
    zIndex: 201,
  };

  const handleAction = (action: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    console.log('Context menu action clicked:', action, { hasPort, mainPort, hasProjectPath, projectPath: node.projectPath, pid: node.pid });

    const performAction = async () => {
      try {
        switch (action) {
          case 'open-browser':
            if (hasPort) {
              console.log('Opening browser:', `http://localhost:${mainPort}`);
              const result = await window.electronAPI.openUrl(`http://localhost:${mainPort}`);
              console.log('Open browser result:', result);
            }
            break;
          case 'open-terminal':
            if (hasProjectPath) {
              console.log('Opening terminal:', node.projectPath);
              const result = await window.electronAPI.openTerminal(node.projectPath!);
              console.log('Open terminal result:', result);
            }
            break;
          case 'restart':
            if (!isExternal) {
              console.log('Killing process:', node.pid);
              const result = await window.electronAPI.killProcess(node.pid);
              console.log('Kill process result:', result);
            }
            break;
          case 'copy-port':
            if (hasPort) {
              console.log('Copying port:', mainPort);
              await navigator.clipboard.writeText(String(mainPort));
              console.log('Port copied');
            }
            break;
          case 'copy-pid':
            console.log('Copying PID:', node.pid);
            await navigator.clipboard.writeText(String(node.pid));
            console.log('PID copied');
            break;
        }
      } catch (error) {
        console.error('Context menu action failed:', error);
      }
    };

    performAction();
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onClose();
  };

  return (
    <>
      <div className="context-menu-backdrop" onClick={handleBackdropClick} />
      <div className="context-menu" style={menuStyle}>
        {hasPort && (
          <div
            className="context-menu-item"
            onClick={handleAction('open-browser')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M3.5 10h13M10 3.5c2.2 2 2.2 11 0 13M10 3.5c-2.2 2-2.2 11 0 13" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
            <span>Open in Browser</span>
          </div>
        )}
        {hasProjectPath && (
          <div
            className="context-menu-item"
            onClick={handleAction('open-terminal')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect x="2.5" y="4" width="15" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <path d="M6 8l3 2-3 2M10 12h4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>Open in Terminal</span>
          </div>
        )}
        {!isExternal && (
          <div
            className="context-menu-item"
            onClick={handleAction('restart')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <path d="M4 10a6 6 0 1 0 2-4.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                <path d="M5 4v3h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span>Kill Process</span>
          </div>
        )}
        {(hasPort || hasProjectPath || !isExternal) && (
          <div className="context-menu-divider" />
        )}
        {hasPort && (
          <div
            className="context-menu-item"
            onClick={handleAction('copy-port')}
          >
            <span className="context-menu-icon" aria-hidden="true">
              <svg viewBox="0 0 20 20" width="14" height="14">
                <rect x="6" y="5" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                <rect x="3" y="3" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              </svg>
            </span>
            <span>Copy Port ({mainPort})</span>
          </div>
        )}
        <div
          className="context-menu-item"
          onClick={handleAction('copy-pid')}
        >
          <span className="context-menu-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20" width="14" height="14">
              <rect x="6" y="5" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
              <rect x="3" y="3" width="10" height="12" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
            </svg>
          </span>
          <span>Copy PID ({node.pid})</span>
        </div>
      </div>
    </>
  );
}
