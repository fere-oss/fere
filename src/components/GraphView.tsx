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

  // Calculate edge routes - routes go around the OUTSIDE, never through nodes
  const edgeRoutes = useMemo(() => {
    if (nodePositions.size === 0) return [];

    // Find the global left and right boundaries of ALL nodes
    let globalLeft = Infinity;
    let globalRight = -Infinity;

    nodePositions.forEach((pos) => {
      const left = pos.x - pos.width / 2;
      const right = pos.x + pos.width / 2;
      globalLeft = Math.min(globalLeft, left);
      globalRight = Math.max(globalRight, right);
    });

    // Side lanes are outside all nodes
    const sideMargin = 50;
    const leftLane = globalLeft - sideMargin;
    const rightLane = globalRight + sideMargin;

    const routes: { from: string; to: string; path: string }[] = [];

    connections.forEach((conn, index) => {
      const from = nodePositions.get(conn.from);
      const to = nodePositions.get(conn.to);
      if (!from || !to) return;

      const sourceBottom = from.y + from.height / 2;
      const sourceTop = from.y - from.height / 2;
      const targetTop = to.y - to.height / 2;
      const targetBottom = to.y + to.height / 2;

      let path: string;

      // Adjacent layers going DOWN (source layer is directly above target layer)
      if (from.layer === to.layer - 1) {
        if (Math.abs(from.x - to.x) < 5) {
          // Vertically aligned - straight line
          path = `M ${from.x} ${sourceBottom} L ${to.x} ${targetTop}`;
        } else {
          // Simple step: down, across, down (gap is guaranteed clear between adjacent layers)
          const gapY = (sourceBottom + targetTop) / 2;
          path = `M ${from.x} ${sourceBottom} L ${from.x} ${gapY} L ${to.x} ${gapY} L ${to.x} ${targetTop}`;
        }
      }
      // Adjacent layers going UP (source layer is directly below target layer)
      else if (from.layer === to.layer + 1) {
        if (Math.abs(from.x - to.x) < 5) {
          // Vertically aligned - straight line
          path = `M ${from.x} ${sourceTop} L ${to.x} ${targetBottom}`;
        } else {
          // Simple step: up, across, up
          const gapY = (sourceTop + targetBottom) / 2;
          path = `M ${from.x} ${sourceTop} L ${from.x} ${gapY} L ${to.x} ${gapY} L ${to.x} ${targetBottom}`;
        }
      }
      // Same layer - route above
      else if (from.layer === to.layer) {
        const routeY = Math.min(sourceTop, targetTop) - 40;
        path = `M ${from.x} ${sourceTop} L ${from.x} ${routeY} L ${to.x} ${routeY} L ${to.x} ${targetTop}`;
      }
      // SKIP layers (non-adjacent) - must route around the OUTSIDE
      else {
        // Choose left or right lane based on position (prefer shorter horizontal distance)
        const useLeftLane = (from.x + to.x) / 2 < (globalLeft + globalRight) / 2;
        const laneX = useLeftLane ? leftLane - (index * 8) : rightLane + (index * 8);

        if (from.layer < to.layer) {
          // Going DOWN but skipping layers - route out the side
          path = `M ${from.x} ${sourceBottom} L ${from.x} ${sourceBottom + 15} L ${laneX} ${sourceBottom + 15} L ${laneX} ${targetTop - 15} L ${to.x} ${targetTop - 15} L ${to.x} ${targetTop}`;
        } else {
          // Going UP but skipping layers - route out the side
          path = `M ${from.x} ${sourceTop} L ${from.x} ${sourceTop - 15} L ${laneX} ${sourceTop - 15} L ${laneX} ${targetBottom + 15} L ${to.x} ${targetBottom + 15} L ${to.x} ${targetBottom}`;
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
