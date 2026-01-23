import type { GraphNode, Port } from '../types/electron';

interface ServiceSidebarProps {
  nodes: GraphNode[];
  ports: Port[];
  loading: boolean;
}

const getServiceColor = (type: string) => {
  switch (type) {
    case 'database':
      return '#76B900'; // NVIDIA Green
    case 'nodejs':
      return '#5E9B00'; // Deep green
    case 'python':
      return '#9AD100'; // Bright green
    case 'cache':
      return '#FFB707'; // Amber
    case 'container':
    case 'external':
      return '#EC679B'; // Pink
    case 'frontend':
    case 'backend':
    case 'webserver':
      return '#0078D4'; // Microsoft Blue
    case 'broker':
      return '#D96C00'; // Deep amber
    case 'realtime':
      return '#1AA6A6'; // Teal
    case 'worker':
      return '#6B7280'; // Neutral gray
    case 'client':
      return '#5C7AEA'; // Muted blue
    case 'service':
      return '#F03603'; // Red
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
    broker: 'Broker',
    realtime: 'Realtime',
    worker: 'Worker',
    client: 'Client',
    service: 'Service',
    external: 'External',
  };
  return labels[type] || 'Service';
};

export function ServiceSidebar({ nodes, ports, loading }: ServiceSidebarProps) {
  const allPorts = Array.from(new Set(ports.map(p => p.port))).sort((a, b) => a - b);

  return (
    <div className="service-sidebar">
      {/* Services List */}
      <div className="sidebar-card services-card">
        <div className="sidebar-card-header">
          <h2 className="sidebar-card-title">Running Services</h2>
          <p className="sidebar-card-subtitle">{nodes.length} active</p>
        </div>

        <div className="sidebar-card-content">
          {loading ? (
            <div className="sidebar-loading">Scanning...</div>
          ) : nodes.length === 0 ? (
            <div className="sidebar-empty">
              <p>No services detected</p>
              <span>Start a dev server to see it here</span>
            </div>
          ) : (
            nodes.map(node => {
              const accentColor = getServiceColor(node.type);
              const mainPort = node.ports[0]?.port;

              return (
                <div key={node.id} className="service-item">
                  <div className="service-item-header">
                    <div className="service-item-info">
                      <div className="service-item-title-row">
                        <div
                          className="service-status-dot"
                          style={{
                            backgroundColor: accentColor,
                            boxShadow: `0 0 6px ${accentColor}40`
                          }}
                        />
                        <h3 className="service-item-name">{node.name}</h3>
                      </div>
                      <span
                        className="service-type-badge"
                        style={{
                          backgroundColor: `${accentColor}12`,
                          color: accentColor,
                        }}
                      >
                        {getTypeBadge(node.type)}
                      </span>
                    </div>
                    {mainPort && (
                      <div
                        className="service-port-badge"
                        style={{ color: accentColor }}
                      >
                        :{mainPort}
                      </div>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="service-stats">
                    <div className="service-stat">
                      <div className="service-stat-label">CPU</div>
                      <div className="service-stat-value">{node.cpu.toFixed(1)}%</div>
                    </div>
                    <div className="service-stat">
                      <div className="service-stat-label">Memory</div>
                      <div className="service-stat-value">{node.memory.toFixed(1)}%</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Ports List */}
      <div className="sidebar-card ports-card">
        <h3 className="ports-card-title">Active Ports</h3>
        <div className="ports-list">
          {loading ? (
            <span className="sidebar-loading-small">...</span>
          ) : allPorts.length === 0 ? (
            <span className="ports-empty">No ports in use</span>
          ) : (
            allPorts.map(port => (
              <div key={port} className="port-chip">
                :{port}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
