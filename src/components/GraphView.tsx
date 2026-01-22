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

const getServiceColor = (type: string) => {
  switch (type) {
    case 'database':
    case 'cache':
      return '#76B900'; // NVIDIA Green
    case 'nodejs':
    case 'python':
      return '#76B900'; // NVIDIA Green
    case 'frontend':
    case 'backend':
    case 'webserver':
      return '#0078D4'; // Microsoft Blue
    default:
      return '#525252'; // Neutral gray
  }
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

export function GraphView({ nodes, edges }: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });

  // Filter out external nodes (IPs, non-local services)
  const localNodes = nodes.filter(n => {
    // Keep only local services, filter out external IPs
    if (n.type === 'external') return false;
    if (n.id.includes('external-')) return false;
    // Filter out nodes with IP addresses in their name/id
    if (/\d+\.\d+\.\d+\.\d+/.test(n.id)) return false;
    return true;
  });

  // Filter edges to only include connections between local nodes
  const localNodeIds = new Set(localNodes.map(n => n.id));
  const localEdges = edges.filter(e =>
    localNodeIds.has(e.source) && localNodeIds.has(e.target)
  );

  // Organize nodes by layer (memoized to prevent unnecessary re-renders)
  const { frontend, backendLayer, database, other } = useMemo(() => {
    const frontend = localNodes.filter(n => n.type === 'frontend');
    const backend = localNodes.filter(n => n.type === 'backend' || n.type === 'webserver');
    const runtime = localNodes.filter(n => n.type === 'nodejs' || n.type === 'python');
    const database = localNodes.filter(n => n.type === 'database' || n.type === 'cache');
    const other = localNodes.filter(n =>
      !['frontend', 'backend', 'webserver', 'nodejs', 'python', 'database', 'cache'].includes(n.type)
    );
    return {
      frontend,
      backendLayer: [...backend, ...runtime],
      database,
      other,
    };
  }, [localNodes]);

  // Create connection list from edges
  const connections = localEdges.map(edge => ({
    from: edge.source,
    to: edge.target,
  }));

  // Zoom handlers
  const handleZoomIn = () => setZoom(z => Math.min(z + 0.2, 2));
  const handleZoomOut = () => setZoom(z => Math.max(z - 0.2, 0.4));
  const handleZoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Pan handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // Only left click
    setIsDragging(true);
    setDragStart({ x: e.clientX - pan.x, y: e.clientY - pan.y });
  }, [pan]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    setPan({
      x: e.clientX - dragStart.x,
      y: e.clientY - dragStart.y,
    });
  }, [isDragging, dragStart]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.1 : 0.1;
    setZoom(z => Math.max(0.4, Math.min(2, z + delta)));
  }, []);

  // Build layer mapping for nodes
  const nodeLayerMap = useMemo(() => {
    const map = new Map<string, { layer: number; indexInLayer: number }>();

    const layers = [
      { nodes: frontend, layer: 0 },
      { nodes: backendLayer, layer: 1 },
      { nodes: database, layer: 2 },
      { nodes: other, layer: 3 },
    ];

    layers.forEach(({ nodes: layerNodes, layer }) => {
      layerNodes.forEach((node, index) => {
        map.set(node.id, { layer, indexInLayer: index });
      });
    });

    return map;
  }, [frontend, backendLayer, database, other]);

  // Calculate node positions after render - zoom independent
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
          // Normalize positions by dividing by zoom to get consistent coordinates
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

  // Calculate edge routes - route through layer gaps, never through nodes
  const edgeRoutes = useMemo(() => {
    if (nodePositions.size === 0) return [];

    const allNodes = Array.from(nodePositions.entries());
    const padding = 15; // Minimum clearance from node edges

    // Compute bounding box for each layer
    const layerBounds = new Map<number, { top: number; bottom: number; left: number; right: number }>();
    allNodes.forEach(([, pos]) => {
      const nodeTop = pos.y - pos.height / 2;
      const nodeBottom = pos.y + pos.height / 2;
      const nodeLeft = pos.x - pos.width / 2;
      const nodeRight = pos.x + pos.width / 2;

      const existing = layerBounds.get(pos.layer);
      if (existing) {
        existing.top = Math.min(existing.top, nodeTop);
        existing.bottom = Math.max(existing.bottom, nodeBottom);
        existing.left = Math.min(existing.left, nodeLeft);
        existing.right = Math.max(existing.right, nodeRight);
      } else {
        layerBounds.set(pos.layer, { top: nodeTop, bottom: nodeBottom, left: nodeLeft, right: nodeRight });
      }
    });

    // Find global boundaries for side lanes
    let globalLeft = Infinity;
    let globalRight = -Infinity;
    nodePositions.forEach((pos) => {
      globalLeft = Math.min(globalLeft, pos.x - pos.width / 2);
      globalRight = Math.max(globalRight, pos.x + pos.width / 2);
    });
    const sideMargin = 40;

    // Compute gaps between adjacent layers (safe horizontal corridors)
    const sortedLayers = Array.from(layerBounds.keys()).sort((a, b) => a - b);
    const layerGaps = new Map<string, number>(); // "layer1-layer2" -> Y coordinate of gap center
    for (let i = 0; i < sortedLayers.length - 1; i++) {
      const upperLayer = sortedLayers[i];
      const lowerLayer = sortedLayers[i + 1];
      const upperBounds = layerBounds.get(upperLayer)!;
      const lowerBounds = layerBounds.get(lowerLayer)!;
      // Gap is between bottom of upper layer and top of lower layer
      const gapY = (upperBounds.bottom + lowerBounds.top) / 2;
      layerGaps.set(`${upperLayer}-${lowerLayer}`, gapY);
    }

    // Check if a horizontal segment at Y collides with any node
    const horizontalSegmentBlocked = (y: number, x1: number, x2: number, excludeIds: string[]): boolean => {
      const minX = Math.min(x1, x2);
      const maxX = Math.max(x1, x2);
      return allNodes.some(([id, pos]) => {
        if (excludeIds.includes(id)) return false;
        const nodeLeft = pos.x - pos.width / 2 - padding;
        const nodeRight = pos.x + pos.width / 2 + padding;
        const nodeTop = pos.y - pos.height / 2 - padding;
        const nodeBottom = pos.y + pos.height / 2 + padding;
        return y > nodeTop && y < nodeBottom && maxX > nodeLeft && minX < nodeRight;
      });
    };

    // Check if a vertical segment at X collides with any node
    const verticalSegmentBlocked = (x: number, y1: number, y2: number, excludeIds: string[]): boolean => {
      const minY = Math.min(y1, y2);
      const maxY = Math.max(y1, y2);
      return allNodes.some(([id, pos]) => {
        if (excludeIds.includes(id)) return false;
        const nodeLeft = pos.x - pos.width / 2 - padding;
        const nodeRight = pos.x + pos.width / 2 + padding;
        const nodeTop = pos.y - pos.height / 2 - padding;
        const nodeBottom = pos.y + pos.height / 2 + padding;
        return x > nodeLeft && x < nodeRight && maxY > nodeTop && minY < nodeBottom;
      });
    };

    // Find a safe gap Y between two layers for horizontal routing
    const findGapY = (fromLayer: number, toLayer: number): number | null => {
      const minLayer = Math.min(fromLayer, toLayer);
      const maxLayer = Math.max(fromLayer, toLayer);
      // Look for an existing gap between these layers
      for (let layer = minLayer; layer < maxLayer; layer++) {
        const gapKey = `${layer}-${layer + 1}`;
        const gapY = layerGaps.get(gapKey);
        if (gapY !== undefined) return gapY;
      }
      return null;
    };

    // Find a safe X lane (left or right of all nodes)
    let leftLaneIndex = 0;
    let rightLaneIndex = 0;
    const getLeftLane = () => globalLeft - sideMargin - (leftLaneIndex++ * 12);
    const getRightLane = () => globalRight + sideMargin + (rightLaneIndex++ * 12);

    const routes: { from: string; to: string; path: string }[] = [];

    connections.forEach((conn) => {
      const from = nodePositions.get(conn.from);
      const to = nodePositions.get(conn.to);
      if (!from || !to) return;

      const excludeIds = [conn.from, conn.to];
      const sourceBottom = from.y + from.height / 2;
      const sourceTop = from.y - from.height / 2;
      const targetTop = to.y - to.height / 2;
      const targetBottom = to.y + to.height / 2;

      let path: string;

      if (from.layer === to.layer) {
        // Same layer - route above the layer
        const layerTop = layerBounds.get(from.layer)?.top ?? Math.min(sourceTop, targetTop);
        const routeY = layerTop - padding - 25;
        path = `M ${from.x} ${sourceTop} L ${from.x} ${routeY} L ${to.x} ${routeY} L ${to.x} ${targetTop}`;
      } else if (from.layer < to.layer) {
        // Going DOWN (source is above target)
        const gapY = findGapY(from.layer, to.layer) ?? (sourceBottom + targetTop) / 2;

        if (Math.abs(from.x - to.x) < 5) {
          // Nearly vertically aligned - check if straight path is clear
          if (!verticalSegmentBlocked(from.x, sourceBottom, targetTop, excludeIds)) {
            path = `M ${from.x} ${sourceBottom} L ${to.x} ${targetTop}`;
          } else {
            // Need to route around - go to side lane
            const laneX = from.x <= (globalLeft + globalRight) / 2 ? getLeftLane() : getRightLane();
            path = `M ${from.x} ${sourceBottom} L ${from.x} ${gapY} L ${laneX} ${gapY} L ${laneX} ${targetTop - padding} L ${to.x} ${targetTop - padding} L ${to.x} ${targetTop}`;
          }
        } else {
          // Check if simple step path through gap is clear
          const verticalDownClear = !verticalSegmentBlocked(from.x, sourceBottom, gapY, excludeIds);
          const horizontalClear = !horizontalSegmentBlocked(gapY, from.x, to.x, excludeIds);
          const verticalToClear = !verticalSegmentBlocked(to.x, gapY, targetTop, excludeIds);

          if (verticalDownClear && horizontalClear && verticalToClear) {
            // Direct step path is clear
            path = `M ${from.x} ${sourceBottom} L ${from.x} ${gapY} L ${to.x} ${gapY} L ${to.x} ${targetTop}`;
          } else {
            // Route around via side lane
            const goLeft = from.x > to.x;
            const laneX = goLeft ? getLeftLane() : getRightLane();
            path = `M ${from.x} ${sourceBottom} L ${from.x} ${gapY} L ${laneX} ${gapY} L ${laneX} ${targetTop - padding} L ${to.x} ${targetTop - padding} L ${to.x} ${targetTop}`;
          }
        }
      } else {
        // Going UP (source is below target)
        const gapY = findGapY(to.layer, from.layer) ?? (sourceTop + targetBottom) / 2;

        if (Math.abs(from.x - to.x) < 5) {
          // Nearly vertically aligned - check if straight path is clear
          if (!verticalSegmentBlocked(from.x, sourceTop, targetBottom, excludeIds)) {
            path = `M ${from.x} ${sourceTop} L ${to.x} ${targetBottom}`;
          } else {
            // Need to route around - go to side lane
            const laneX = from.x <= (globalLeft + globalRight) / 2 ? getLeftLane() : getRightLane();
            path = `M ${from.x} ${sourceTop} L ${from.x} ${gapY} L ${laneX} ${gapY} L ${laneX} ${targetBottom + padding} L ${to.x} ${targetBottom + padding} L ${to.x} ${targetBottom}`;
          }
        } else {
          // Check if simple step path through gap is clear
          const verticalUpClear = !verticalSegmentBlocked(from.x, sourceTop, gapY, excludeIds);
          const horizontalClear = !horizontalSegmentBlocked(gapY, from.x, to.x, excludeIds);
          const verticalToClear = !verticalSegmentBlocked(to.x, gapY, targetBottom, excludeIds);

          if (verticalUpClear && horizontalClear && verticalToClear) {
            // Direct step path is clear
            path = `M ${from.x} ${sourceTop} L ${from.x} ${gapY} L ${to.x} ${gapY} L ${to.x} ${targetBottom}`;
          } else {
            // Route around via side lane
            const goLeft = from.x > to.x;
            const laneX = goLeft ? getLeftLane() : getRightLane();
            path = `M ${from.x} ${sourceTop} L ${from.x} ${gapY} L ${laneX} ${gapY} L ${laneX} ${targetBottom + padding} L ${to.x} ${targetBottom + padding} L ${to.x} ${targetBottom}`;
          }
        }
      }

      routes.push({ from: conn.from, to: conn.to, path });
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
      onWheel={handleWheel}
      style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
    >
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
                stroke="#000000"
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
              stroke="#000000"
              strokeWidth="1.5"
              fill="none"
              markerEnd="url(#arrowhead)"
              opacity="0.4"
              className="graph-edge"
            />
          ))}
        </svg>

        {/* Layered nodes */}
        <div className="graph-layers">
          {/* Frontend Layer */}
          {frontend.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">FRONTEND</div>
              <div className="graph-layer-nodes">
                {frontend.map(node => (
                  <ServiceNode key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {/* Backend / Runtime Layer */}
          {backendLayer.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">BACKEND / API</div>
              <div className="graph-layer-nodes">
                {backendLayer.map(node => (
                  <ServiceNode key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {/* Database Layer */}
          {database.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">DATA LAYER</div>
              <div className="graph-layer-nodes">
                {database.map(node => (
                  <ServiceNode key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}

          {/* Other Services */}
          {other.length > 0 && (
            <div className="graph-layer">
              <div className="graph-layer-label">OTHER SERVICES</div>
              <div className="graph-layer-nodes">
                {other.map(node => (
                  <ServiceNode key={node.id} node={node} />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Service Node Component
function ServiceNode({ node }: { node: GraphNode }) {
  const accentColor = getServiceColor(node.type);
  const mainPort = node.ports[0]?.port;
  const routes = node.routes || [];
  const visibleRoutes = routes.slice(0, 3);

  return (
    <div data-node-id={node.id} className="service-node">
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
