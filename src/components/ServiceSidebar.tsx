import { useState, useCallback } from 'react';
import type { GraphNode, Port } from '../types/electron';

interface ServiceSidebarProps {
  nodes: GraphNode[];
  ports: Port[];
  loading: boolean;
  onTestService?: (nodeId: string) => void;
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

export function ServiceSidebar({ nodes, ports, loading, onTestService }: ServiceSidebarProps) {
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const allPorts = Array.from(new Set(ports.map(p => p.port))).sort((a, b) => a - b);

  const toggleExpanded = useCallback((nodeId: string) => {
    setExpandedNodes(prev => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const handleOpenBrowser = useCallback(async (node: GraphNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const port = node.ports[0];
    if (!port) return;
    const host = port.host === '0.0.0.0' || port.host === '*' ? 'localhost' : port.host;
    const url = `http://${host}:${port.port}`;
    await window.electronAPI.openUrl(url);
  }, []);

  const handleOpenTerminal = useCallback(async (node: GraphNode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.projectPath) {
      await window.electronAPI.openTerminal(node.projectPath);
    }
  }, []);

  const handleKillProcess = useCallback(async (node: GraphNode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.pid) {
      await window.electronAPI.killProcess(node.pid);
    }
  }, []);

  const handleTestService = useCallback((node: GraphNode, e: React.MouseEvent) => {
    e.stopPropagation();
    if (onTestService) {
      onTestService(node.id);
    }
  }, [onTestService]);

  const handlePortClick = useCallback(async (port: number) => {
    const url = `http://localhost:${port}`;
    await window.electronAPI.openUrl(url);
  }, []);

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
              const isExpanded = expandedNodes.has(node.id);
              const hasRoutes = node.routes && node.routes.length > 0;
              const canTest = node.type !== 'external' && node.ports.length > 0 && hasRoutes;

              return (
                <div
                  key={node.id}
                  className={`service-item ${isExpanded ? 'expanded' : ''}`}
                  onClick={() => toggleExpanded(node.id)}
                >
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
                        <svg
                          className={`service-expand-icon ${isExpanded ? 'expanded' : ''}`}
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                        >
                          <path
                            d="M3 4.5L6 7.5L9 4.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
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

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="service-expanded">
                      {/* Quick Actions */}
                      <div className="service-actions">
                        {node.ports.length > 0 && (
                          <button
                            className="service-action-btn"
                            onClick={(e) => handleOpenBrowser(node, e)}
                            title="Open in browser"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5"/>
                              <path d="M1.5 7H12.5M7 1.5C8.5 3 9.5 5 9.5 7C9.5 9 8.5 11 7 12.5M7 1.5C5.5 3 4.5 5 4.5 7C4.5 9 5.5 11 7 12.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            Browser
                          </button>
                        )}
                        {node.projectPath && (
                          <button
                            className="service-action-btn"
                            onClick={(e) => handleOpenTerminal(node, e)}
                            title="Open terminal at project"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <rect x="1" y="2" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
                              <path d="M3.5 5.5L5.5 7.5L3.5 9.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M7 9.5H10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            Terminal
                          </button>
                        )}
                        {canTest && onTestService && (
                          <button
                            className="service-action-btn service-action-test"
                            onClick={(e) => handleTestService(node, e)}
                            title="Test API endpoints"
                          >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                              <path d="M2 4L6 8L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              <path d="M7 12H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                            </svg>
                            Test
                          </button>
                        )}
                        <button
                          className="service-action-btn service-action-kill"
                          onClick={(e) => handleKillProcess(node, e)}
                          title="Kill process"
                        >
                          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                            <path d="M10.5 3.5L3.5 10.5M3.5 3.5L10.5 10.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                          </svg>
                          Kill
                        </button>
                      </div>

                      {/* Details */}
                      <div className="service-details">
                        <div className="service-detail-row">
                          <span className="service-detail-label">PID</span>
                          <span className="service-detail-value">{node.pid}</span>
                        </div>
                        {node.ports.length > 0 && (
                          <div className="service-detail-row">
                            <span className="service-detail-label">Ports</span>
                            <span className="service-detail-value">
                              {node.ports.map(p => `:${p.port}`).join(', ')}
                            </span>
                          </div>
                        )}
                        {hasRoutes && (
                          <div className="service-detail-row">
                            <span className="service-detail-label">Routes</span>
                            <span className="service-detail-value">{node.routes!.length} discovered</span>
                          </div>
                        )}
                        {node.projectPath && (
                          <div className="service-detail-row">
                            <span className="service-detail-label">Path</span>
                            <span className="service-detail-value service-detail-path" title={node.projectPath}>
                              {node.projectPath}
                            </span>
                          </div>
                        )}
                        <div className="service-detail-row">
                          <span className="service-detail-label">Command</span>
                          <span className="service-detail-value service-detail-command" title={node.command}>
                            {node.command}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
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
              <button
                key={port}
                className="port-chip port-chip-clickable"
                onClick={() => handlePortClick(port)}
                title={`Open localhost:${port} in browser`}
              >
                :{port}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
