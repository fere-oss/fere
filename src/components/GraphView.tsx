import { useEffect, useRef, useState, useCallback } from 'react';
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

  // Organize nodes by layer
  const frontend = localNodes.filter(n => n.type === 'frontend');
  const backend = localNodes.filter(n => n.type === 'backend' || n.type === 'webserver');
  const runtime = localNodes.filter(n => n.type === 'nodejs' || n.type === 'python');
  const database = localNodes.filter(n => n.type === 'database' || n.type === 'cache');
  const other = localNodes.filter(n =>
    !['frontend', 'backend', 'webserver', 'nodejs', 'python', 'database', 'cache'].includes(n.type)
  );

  // Combine backend and runtime for display
  const backendLayer = [...backend, ...runtime];

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
          positions.set(node.id, {
            x: (rect.left - canvasRect.left + rect.width / 2) / zoom,
            y: (rect.top - canvasRect.top + rect.height / 2) / zoom,
            width: rect.width / zoom,
            height: rect.height / zoom,
          });
        }
      });

      setNodePositions(positions);
    };

    const timer = setTimeout(updatePositions, 150);
    return () => clearTimeout(timer);
  }, [localNodes, zoom]);

  // Generate curved path for connection
  const getConnectionPath = (fromId: string, toId: string) => {
    const from = nodePositions.get(fromId);
    const to = nodePositions.get(toId);

    if (!from || !to) return '';

    const startX = from.x;
    const startY = from.y + from.height / 2 + 8;
    const endX = to.x;
    const endY = to.y - to.height / 2 - 8;

    // Control point for bezier curve
    const midY = (startY + endY) / 2;

    return `M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`;
  };

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
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
            >
              <polygon points="0 0, 8 4, 0 8" fill="#0078D4" />
            </marker>
          </defs>

          {connections.map((conn, i) => {
            const path = getConnectionPath(conn.from, conn.to);
            if (!path) return null;
            return (
              <path
                key={i}
                d={path}
                stroke="#0078D4"
                strokeWidth="2"
                fill="none"
                markerEnd="url(#arrowhead)"
                opacity="0.6"
                strokeDasharray="none"
              />
            );
          })}
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
