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
  }, [localNodes, zoom, nodeLayerMap]);

  // Calculate all edge routes with proper spacing to avoid overlaps
  const edgeRoutes = useMemo(() => {
    if (nodePositions.size === 0) return [];

    // Group edges by source-target layer pairs for bundling
    const edgeGroups = new Map<string, typeof connections>();
    connections.forEach(conn => {
      const fromPos = nodePositions.get(conn.from);
      const toPos = nodePositions.get(conn.to);
      if (!fromPos || !toPos) return;

      const key = `${fromPos.layer}-${toPos.layer}`;
      if (!edgeGroups.has(key)) {
        edgeGroups.set(key, []);
      }
      edgeGroups.get(key)!.push(conn);
    });

    const routes: { from: string; to: string; path: string }[] = [];

    edgeGroups.forEach((groupEdges) => {
      const edgeCount = groupEdges.length;

      groupEdges.forEach((conn, edgeIndex) => {
        const from = nodePositions.get(conn.from);
        const to = nodePositions.get(conn.to);
        if (!from || !to) return;

        // Determine if going down (normal) or up (reverse connection)
        const goingDown = from.layer < to.layer || (from.layer === to.layer && from.y < to.y);

        // Start and end points with padding
        const verticalPadding = 12;
        const startX = from.x;
        const startY = goingDown ? from.y + from.height / 2 + verticalPadding : from.y - from.height / 2 - verticalPadding;
        const endX = to.x;
        const endY = goingDown ? to.y - to.height / 2 - verticalPadding : to.y + to.height / 2 + verticalPadding;

        // Calculate horizontal offset for edge bundling (spread edges apart)
        const bundleSpacing = 16;
        const bundleOffset = edgeCount > 1 ? (edgeIndex - (edgeCount - 1) / 2) * bundleSpacing : 0;

        // For same-layer connections or when nodes are far apart horizontally
        const horizontalDiff = Math.abs(endX - startX);
        const verticalDiff = Math.abs(endY - startY);

        let path: string;

        if (from.layer === to.layer) {
          // Same layer connection - route around (loop above the nodes)
          const loopHeight = 40 + edgeIndex * 12;
          const midY = Math.min(from.y, to.y) - from.height / 2 - loopHeight;

          path = `M ${startX} ${from.y - from.height / 2 - verticalPadding}
                  L ${startX} ${midY}
                  L ${endX} ${midY}
                  L ${endX} ${to.y - to.height / 2 - verticalPadding}`;
        } else if (horizontalDiff < 20) {
          // Nearly vertical - simple straight line with slight curve
          const midY = (startY + endY) / 2;
          path = `M ${startX} ${startY}
                  C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
        } else {
          // Orthogonal routing with rounded corners
          // Calculate the corridor Y position (midpoint between layers)
          const corridorY = (startY + endY) / 2 + bundleOffset;

          // Use quadratic bezier for smooth corners
          const cornerRadius = Math.min(20, horizontalDiff / 4, verticalDiff / 4);

          // Direction of horizontal movement
          const goingRight = endX > startX;
          const hDir = goingRight ? 1 : -1;
          const vDir = goingDown ? 1 : -1;

          // Points for the path with rounded corners
          const p1 = { x: startX, y: startY }; // Start
          const p2 = { x: startX, y: corridorY - vDir * cornerRadius }; // Before first corner
          const p3 = { x: startX + hDir * cornerRadius, y: corridorY }; // After first corner
          const p4 = { x: endX - hDir * cornerRadius, y: corridorY }; // Before second corner
          const p5 = { x: endX, y: corridorY + vDir * cornerRadius }; // After second corner
          const p6 = { x: endX, y: endY }; // End

          path = `M ${p1.x} ${p1.y}
                  L ${p2.x} ${p2.y}
                  Q ${startX} ${corridorY}, ${p3.x} ${p3.y}
                  L ${p4.x} ${p4.y}
                  Q ${endX} ${corridorY}, ${p5.x} ${p5.y}
                  L ${p6.x} ${p6.y}`;
        }

        routes.push({ from: conn.from, to: conn.to, path });
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
                stroke="#0078D4"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity="0.6"
              />
            </marker>
          </defs>

          {edgeRoutes.map((route, i) => (
            <path
              key={`${route.from}-${route.to}-${i}`}
              d={route.path}
              stroke="#0078D4"
              strokeWidth="1.5"
              fill="none"
              markerEnd="url(#arrowhead)"
              opacity="0.5"
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
