import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { GraphNode, GraphEdge } from '../types/electron';

interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
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
  service: { color: '#F03603', label: 'System Service' }, // Red
  external: { color: '#EC679B', label: 'External' },      // Pink
};

const getServiceColor = (type: string) => {
  return SERVICE_COLORS[type]?.color || '#6B7280';
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
    service: 'Service',
    external: 'External',
  };
  return labels[type] || 'Service';
};

// Extract a normalized base name for grouping related services
const getBaseName = (name: string): string => {
  let base = name.toLowerCase().trim();
  base = base.replace(/[-_]?(server|api|service|app|client|worker|main|dev|prod|test)$/i, '');
  base = base.replace(/[-_]?\d+$/, '');
  base = base.replace(/[-_]+$/, '');
  return base || name.toLowerCase();
};

// Assign layer based on node type
const getTypeLayer = (type: string): number => {
  switch (type) {
    case 'frontend':
      return 0;
    case 'backend':
    case 'webserver':
    case 'nodejs':
    case 'python':
      return 1;
    case 'database':
    case 'cache':
      return 2;
    default:
      return 3;
  }
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

// Hierarchical layout algorithm using barycenter method
const computeHierarchicalLayout = (
  nodes: GraphNode[],
  edges: GraphEdge[]
): LayoutNode[] => {
  if (nodes.length === 0) return [];

  const { outgoing, incoming } = buildAdjacencyLists(edges);

  // Step 1: Assign layers based on type
  const nodesByLayer = new Map<number, GraphNode[]>();
  nodes.forEach(node => {
    const layer = getTypeLayer(node.type);
    if (!nodesByLayer.has(layer)) nodesByLayer.set(layer, []);
    nodesByLayer.get(layer)!.push(node);
  });

  // Step 2: Initial ordering within each layer - group by base name, then alphabetically
  const layerOrders = new Map<string, number>(); // nodeId -> order within layer

  nodesByLayer.forEach((layerNodes) => {
    // Group by base name
    const groups = new Map<string, GraphNode[]>();
    layerNodes.forEach(node => {
      const baseName = getBaseName(node.name);
      if (!groups.has(baseName)) groups.set(baseName, []);
      groups.get(baseName)!.push(node);
    });

    // Sort groups: multi-node groups first, then alphabetically
    const sortedGroups = Array.from(groups.entries()).sort((a, b) => {
      if (a[1].length !== b[1].length) return b[1].length - a[1].length;
      return a[0].localeCompare(b[0]);
    });

    // Flatten and assign initial order
    let order = 0;
    sortedGroups.forEach(([, groupNodes]) => {
      groupNodes.sort((a, b) => a.name.localeCompare(b.name));
      groupNodes.forEach(node => {
        layerOrders.set(node.id, order++);
      });
    });
  });

  // Step 3: Barycenter refinement - multiple passes to minimize crossings
  const sortedLayers = Array.from(nodesByLayer.keys()).sort((a, b) => a - b);
  const NUM_ITERATIONS = 4;

  for (let iter = 0; iter < NUM_ITERATIONS; iter++) {
    // Forward pass: order based on connections from upper layers
    for (let i = 1; i < sortedLayers.length; i++) {
      const layer = sortedLayers[i];
      const layerNodes = nodesByLayer.get(layer) || [];

      // Compute barycenter for each node based on incoming connections
      const barycenters: { node: GraphNode; bc: number; originalOrder: number }[] = [];
      layerNodes.forEach(node => {
        const bc = computeBarycenter(node.id, incoming.get(node.id), layerOrders);
        barycenters.push({ node, bc, originalOrder: layerOrders.get(node.id) || 0 });
      });

      // Sort by barycenter, keeping original order for nodes with same/no connections
      barycenters.sort((a, b) => {
        if (a.bc === Infinity && b.bc === Infinity) return a.originalOrder - b.originalOrder;
        if (a.bc === Infinity) return 1;
        if (b.bc === Infinity) return -1;
        return a.bc - b.bc;
      });

      // Update orders
      barycenters.forEach((item, idx) => {
        layerOrders.set(item.node.id, idx);
      });
    }

    // Backward pass: order based on connections to lower layers
    for (let i = sortedLayers.length - 2; i >= 0; i--) {
      const layer = sortedLayers[i];
      const layerNodes = nodesByLayer.get(layer) || [];

      // Compute barycenter for each node based on outgoing connections
      const barycenters: { node: GraphNode; bc: number; originalOrder: number }[] = [];
      layerNodes.forEach(node => {
        const bc = computeBarycenter(node.id, outgoing.get(node.id), layerOrders);
        barycenters.push({ node, bc, originalOrder: layerOrders.get(node.id) || 0 });
      });

      // Sort by barycenter
      barycenters.sort((a, b) => {
        if (a.bc === Infinity && b.bc === Infinity) return a.originalOrder - b.originalOrder;
        if (a.bc === Infinity) return 1;
        if (b.bc === Infinity) return -1;
        return a.bc - b.bc;
      });

      // Update orders
      barycenters.forEach((item, idx) => {
        layerOrders.set(item.node.id, idx);
      });
    }
  }

  // Step 4: Build final layout
  const result: LayoutNode[] = [];
  nodes.forEach(node => {
    const layer = getTypeLayer(node.type);
    result.push({
      node,
      layer,
      order: layerOrders.get(node.id) || 0,
      groupId: getBaseName(node.name),
    });
  });

  return result;
};

// Group layout nodes for rendering
interface RenderGroup {
  groupName: string;
  nodes: GraphNode[];
  isGroup: boolean;
}

const groupLayoutNodes = (layoutNodes: LayoutNode[], layer: number): RenderGroup[] => {
  // Filter nodes for this layer and sort by order
  const layerNodes = layoutNodes
    .filter(ln => ln.layer === layer)
    .sort((a, b) => a.order - b.order);

  // Group consecutive nodes with same groupId
  const groups: RenderGroup[] = [];
  let currentGroup: RenderGroup | null = null;

  layerNodes.forEach(ln => {
    if (currentGroup && currentGroup.groupName.toLowerCase() === ln.groupId.toLowerCase()) {
      currentGroup.nodes.push(ln.node);
      currentGroup.isGroup = true;
    } else {
      if (currentGroup) groups.push(currentGroup);
      currentGroup = {
        groupName: ln.groupId.charAt(0).toUpperCase() + ln.groupId.slice(1),
        nodes: [ln.node],
        isGroup: false,
      };
    }
  });
  if (currentGroup) groups.push(currentGroup);

  return groups;
};

export function GraphView({ nodes, edges }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{ node: GraphNode; x: number; y: number } | null>(null);

  // Filter out external nodes
  const localNodes = useMemo(() => nodes.filter(n => {
    if (n.type === 'external') return false;
    if (n.id.includes('external-')) return false;
    if (/\d+\.\d+\.\d+\.\d+/.test(n.id)) return false;
    return true;
  }), [nodes]);

  // Filter edges to only include connections between local nodes
  const localEdges = useMemo(() => {
    const localNodeIds = new Set(localNodes.map(n => n.id));
    return edges.filter(e => localNodeIds.has(e.source) && localNodeIds.has(e.target));
  }, [localNodes, edges]);

  // Compute hierarchical layout
  const layoutNodes = useMemo(() =>
    computeHierarchicalLayout(localNodes, localEdges),
    [localNodes, localEdges]
  );

  // Group nodes by layer for rendering
  const { frontendGroups, backendGroups, databaseGroups, otherGroups } = useMemo(() => ({
    frontendGroups: groupLayoutNodes(layoutNodes, 0),
    backendGroups: groupLayoutNodes(layoutNodes, 1),
    databaseGroups: groupLayoutNodes(layoutNodes, 2),
    otherGroups: groupLayoutNodes(layoutNodes, 3),
  }), [layoutNodes]);

  // Flatten for layer counts
  const frontend = frontendGroups.flatMap(g => g.nodes);
  const backendLayer = backendGroups.flatMap(g => g.nodes);
  const database = databaseGroups.flatMap(g => g.nodes);
  const other = otherGroups.flatMap(g => g.nodes);

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

  // Zoom handlers
  const handleZoomIn = () => setZoom(z => Math.min(z + 0.2, 2));
  const handleZoomOut = () => setZoom(z => Math.max(z - 0.2, 0.4));
  const handleZoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Pan handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (selectedNode || contextMenu) return;
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }, [pan, selectedNode, contextMenu]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (selectedNode || contextMenu) return;
    if (!isDragging) return;
    setPan({ x: e.clientX - dragStart.x, y: e.clientY - dragStart.y });
  }, [isDragging, dragStart, selectedNode, contextMenu]);

  const handleMouseUp = useCallback(() => setIsDragging(false), []);

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
      const delta = e.deltaY > 0 ? -0.1 : 0.1;
      setZoom(z => Math.max(0.4, Math.min(2, z + delta)));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

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

  // Build layer mapping for nodes
  const nodeLayerMap = useMemo(() => {
    const map = new Map<string, { layer: number; indexInLayer: number }>();
    layoutNodes.forEach(ln => {
      map.set(ln.node.id, { layer: ln.layer, indexInLayer: ln.order });
    });
    return map;
  }, [layoutNodes]);

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

  // Edge routing that avoids node intersections by using side lanes
  const edgeRoutes = useMemo(() => {
    if (nodePositions.size === 0) return [];

    const allNodes = Array.from(nodePositions.entries());

    // Compute layer Y bounds (top/bottom of each layer)
    const layerYBounds = new Map<number, { top: number; bottom: number }>();
    // Compute global X bounds across all nodes
    let globalMinX = Infinity;
    let globalMaxX = -Infinity;

    allNodes.forEach(([, pos]) => {
      const nodeLeft = pos.x - pos.width / 2;
      const nodeRight = pos.x + pos.width / 2;
      const nodeTop = pos.y - pos.height / 2;
      const nodeBottom = pos.y + pos.height / 2;

      globalMinX = Math.min(globalMinX, nodeLeft);
      globalMaxX = Math.max(globalMaxX, nodeRight);

      const existing = layerYBounds.get(pos.layer);
      if (existing) {
        existing.top = Math.min(existing.top, nodeTop);
        existing.bottom = Math.max(existing.bottom, nodeBottom);
      } else {
        layerYBounds.set(pos.layer, { top: nodeTop, bottom: nodeBottom });
      }
    });

    // Define vertical lanes outside all node bounds
    const LANE_MARGIN = 40;
    const leftLaneX = globalMinX - LANE_MARGIN;
    const rightLaneX = globalMaxX + LANE_MARGIN;

    // Compute gap Y positions between consecutive layers
    const sortedLayers = Array.from(layerYBounds.keys()).sort((a, b) => a - b);
    const layerGapY = new Map<string, number>();
    for (let i = 0; i < sortedLayers.length - 1; i++) {
      const upperLayer = sortedLayers[i];
      const lowerLayer = sortedLayers[i + 1];
      const upperBottom = layerYBounds.get(upperLayer)!.bottom;
      const lowerTop = layerYBounds.get(lowerLayer)!.top;
      layerGapY.set(`${upperLayer}-${lowerLayer}`, (upperBottom + lowerTop) / 2);
    }

    // Helper: check if a vertical segment would intersect any node
    const wouldIntersectNode = (
      x: number,
      yStart: number,
      yEnd: number,
      excludeNodeIds: Set<string>
    ): boolean => {
      const yMin = Math.min(yStart, yEnd);
      const yMax = Math.max(yStart, yEnd);

      for (const [nodeId, pos] of allNodes) {
        if (excludeNodeIds.has(nodeId)) continue;

        const nodeLeft = pos.x - pos.width / 2;
        const nodeRight = pos.x + pos.width / 2;
        const nodeTop = pos.y - pos.height / 2;
        const nodeBottom = pos.y + pos.height / 2;

        // Check if vertical line at x intersects this node's bounding box
        if (x >= nodeLeft && x <= nodeRight) {
          // Vertical ranges overlap?
          if (yMax >= nodeTop && yMin <= nodeBottom) {
            return true;
          }
        }
      }
      return false;
    };

    // Helper: pick lane based on edge direction and positions
    const pickLane = (fromX: number, toX: number, edgeIndex: number): number => {
      // If source is left of target, use left lane; otherwise use right lane
      // This keeps edges from crossing over nodes in the middle
      if (fromX < toX) {
        return leftLaneX;
      } else if (fromX > toX) {
        return rightLaneX;
      } else {
        // Vertically aligned - alternate based on edge index
        return edgeIndex % 2 === 0 ? leftLaneX : rightLaneX;
      }
    };

    const routes: {
      from: string;
      to: string;
      path: string;
      label: string;
      labelX: number;
      labelY: number;
    }[] = [];

    connections.forEach((conn, edgeIndex) => {
      const from = nodePositions.get(conn.from);
      const to = nodePositions.get(conn.to);
      if (!from || !to) return;

      const sourceTop = from.y - from.height / 2;
      const sourceBottom = from.y + from.height / 2;
      const targetTop = to.y - to.height / 2;
      const targetBottom = to.y + to.height / 2;

      let path: string;
      let labelX = (from.x + to.x) / 2;
      let labelY = (from.y + to.y) / 2;

      const excludeIds = new Set([conn.from, conn.to]);
      const EXIT_PADDING = 15;
      const ENTRY_PADDING = 15;

      if (from.layer === to.layer) {
        // Same layer - arc above the nodes
        const arcY = Math.min(sourceTop, targetTop) - 40;
        path = `M ${from.x} ${sourceTop} ` +
               `L ${from.x} ${arcY} ` +
               `L ${to.x} ${arcY} ` +
               `L ${to.x} ${targetTop}`;
        labelY = arcY - 6;
      } else {
        const goingDown = from.layer < to.layer;
        const exitY = goingDown ? sourceBottom : sourceTop;
        const entryY = goingDown ? targetTop : targetBottom;

        // Check if direct vertical path would intersect any nodes
        const directPathIntersects = wouldIntersectNode(
          to.x,
          exitY,
          entryY,
          excludeIds
        );

        // Also check if the horizontal segment at gap level would intersect
        const gapKey = goingDown
          ? `${from.layer}-${from.layer + 1}`
          : `${to.layer}-${to.layer + 1}`;
        const gapY = layerGapY.get(gapKey) ?? (exitY + entryY) / 2;

        const horizontalIntersects = (() => {
          const minX = Math.min(from.x, to.x);
          const maxX = Math.max(from.x, to.x);
          for (const [nodeId, pos] of allNodes) {
            if (excludeIds.has(nodeId)) continue;
            const nodeLeft = pos.x - pos.width / 2;
            const nodeRight = pos.x + pos.width / 2;
            const nodeTop = pos.y - pos.height / 2;
            const nodeBottom = pos.y + pos.height / 2;
            // Horizontal line at gapY from minX to maxX
            if (gapY >= nodeTop && gapY <= nodeBottom) {
              if (maxX >= nodeLeft && minX <= nodeRight) {
                return true;
              }
            }
          }
          return false;
        })();

        // Check for intermediate layers (edge spans > 1 layer)
        const hasIntermediateLayers = Math.abs(from.layer - to.layer) > 1;

        // Decide routing strategy
        const needsLaneRouting = directPathIntersects || horizontalIntersects || hasIntermediateLayers;

        if (needsLaneRouting) {
          // Route via side lane to avoid all node intersections
          const laneX = pickLane(from.x, to.x, edgeIndex);

          if (goingDown) {
            // Going DOWN: exit bottom → lane → down → enter top
            const exitSegmentY = sourceBottom + EXIT_PADDING;
            const entrySegmentY = targetTop - ENTRY_PADDING;

            path = `M ${from.x} ${sourceBottom} ` +
                   `L ${from.x} ${exitSegmentY} ` +
                   `L ${laneX} ${exitSegmentY} ` +
                   `L ${laneX} ${entrySegmentY} ` +
                   `L ${to.x} ${entrySegmentY} ` +
                   `L ${to.x} ${targetTop}`;
            labelX = laneX;
            labelY = (exitSegmentY + entrySegmentY) / 2;
          } else {
            // Going UP: exit top → lane → up → enter bottom
            const exitSegmentY = sourceTop - EXIT_PADDING;
            const entrySegmentY = targetBottom + ENTRY_PADDING;

            path = `M ${from.x} ${sourceTop} ` +
                   `L ${from.x} ${exitSegmentY} ` +
                   `L ${laneX} ${exitSegmentY} ` +
                   `L ${laneX} ${entrySegmentY} ` +
                   `L ${to.x} ${entrySegmentY} ` +
                   `L ${to.x} ${targetBottom}`;
            labelX = laneX;
            labelY = (exitSegmentY + entrySegmentY) / 2;
          }
        } else {
          // Direct orthogonal path through gap (no intersections)
          if (goingDown) {
            path = `M ${from.x} ${sourceBottom} ` +
                   `L ${from.x} ${gapY} ` +
                   `L ${to.x} ${gapY} ` +
                   `L ${to.x} ${targetTop}`;
            labelY = gapY - 6;
          } else {
            path = `M ${from.x} ${sourceTop} ` +
                   `L ${from.x} ${gapY} ` +
                   `L ${to.x} ${gapY} ` +
                   `L ${to.x} ${targetBottom}`;
            labelY = gapY - 6;
          }
        }
      }

      const sourcePort = conn.sourcePort ? `:${conn.sourcePort}` : '';
      const targetPort = conn.targetPort ? `:${conn.targetPort}` : '';
      const label = sourcePort || targetPort ? `${sourcePort} → ${targetPort}`.trim() : '';

      routes.push({
        from: conn.from,
        to: conn.to,
        path,
        label,
        labelX,
        labelY,
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
        {/* Connection lines SVG */}
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
            <g key={`${route.from}-${route.to}-${i}`}>
              <path
                d={route.path}
                stroke="currentColor"
                strokeWidth="1.5"
                fill="none"
                markerEnd="url(#arrowhead)"
                className="graph-edge"
              />
              {route.label && (
                <text
                  x={route.labelX}
                  y={route.labelY}
                  textAnchor="middle"
                  className="graph-edge-label"
                >
                  {route.label}
                </text>
              )}
            </g>
          ))}
        </svg>

        {/* Layered nodes */}
        <div className="graph-layers">
          {frontend.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">FRONTEND</div>
              <div className="graph-layer-nodes">
                {frontendGroups.map((group, index) => (
                  <NodeGroupContainer key={`frontend-${group.groupName}-${index}`} group={group} onNodeClick={setSelectedNode} onContextMenu={handleContextMenu} />
                ))}
              </div>
            </div>
          )}

          {backendLayer.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">BACKEND / API</div>
              <div className="graph-layer-nodes">
                {backendGroups.map((group, index) => (
                  <NodeGroupContainer key={`backend-${group.groupName}-${index}`} group={group} onNodeClick={setSelectedNode} onContextMenu={handleContextMenu} />
                ))}
              </div>
            </div>
          )}

          {database.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">DATA LAYER</div>
              <div className="graph-layer-nodes">
                {databaseGroups.map((group, index) => (
                  <NodeGroupContainer key={`database-${group.groupName}-${index}`} group={group} onNodeClick={setSelectedNode} onContextMenu={handleContextMenu} />
                ))}
              </div>
            </div>
          )}

          {other.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">OTHER SERVICES</div>
              <div className="graph-layer-nodes">
                {otherGroups.map((group, index) => (
                  <NodeGroupContainer key={`other-${group.groupName}-${index}`} group={group} onNodeClick={setSelectedNode} onContextMenu={handleContextMenu} />
                ))}
              </div>
            </div>
          )}
        </div>
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

// Node Group Container
function NodeGroupContainer({ group, onNodeClick, onContextMenu }: {
  group: RenderGroup;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
}) {
  if (!group.isGroup) {
    return <ServiceNode node={group.nodes[0]} onClick={onNodeClick} onContextMenu={onContextMenu} />;
  }

  return (
    <div className="node-group">
      <div className="node-group-label">{group.groupName}</div>
      <div className="node-group-nodes">
        {group.nodes.map(node => (
          <ServiceNode key={node.id} node={node} onClick={onNodeClick} onContextMenu={onContextMenu} />
        ))}
      </div>
    </div>
  );
}

// Service Node Component
function ServiceNode({ node, onClick, onContextMenu }: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
}) {
  const accentColor = getServiceColor(node.type);
  const mainPort = node.ports[0]?.port;
  const routes = node.routes || [];
  const visibleRoutes = routes.slice(0, 3);
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
      style={{ '--node-color': accentColor } as React.CSSProperties}
    >
      <div className="service-node-header">
        <div
          className="service-node-dot"
          style={{
            backgroundColor: accentColor,
            boxShadow: `0 0 8px ${accentColor}40`,
          }}
        />
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
      {projectLabel && (
        <div className="service-node-project">{projectLabel}</div>
      )}

      <div className="service-node-port">
        <span className="service-node-port-host">localhost</span>
        <span className="service-node-port-number" style={{ color: accentColor }}>
          :{mainPort || '?'}
        </span>
      </div>

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
  const routes = node.routes || [];

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
          {/* Description Section (if available) */}
          {node.description && (
            <div className="node-detail-section">
              <h3 className="node-detail-section-title">About</h3>
              <p className="node-detail-description">{node.description}</p>
            </div>
          )}

          {/* Process Info Section */}
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
