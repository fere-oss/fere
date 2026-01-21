import React from 'react';
import type { GraphNode, GraphEdge } from '../types/electron';
import { useKillProcess } from '../hooks/useSystemMonitor';

interface ServiceListProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

const TYPE_COLORS: Record<string, string> = {
  database: '#525252',
  cache: '#737373',
  webserver: '#404040',
  container: '#525252',
  frontend: '#171717',
  backend: '#404040',
  nodejs: '#525252',
  python: '#737373',
  service: '#a3a3a3',
  external: '#1e293b',
};

const TYPE_LABELS: Record<string, string> = {
  database: 'Database',
  cache: 'Cache',
  webserver: 'Web Server',
  container: 'Container',
  frontend: 'Frontend',
  backend: 'Backend',
  nodejs: 'Node.js',
  python: 'Python',
  service: 'Service',
  external: 'External',
};

export function ServiceList({ nodes, edges }: ServiceListProps) {
  const { kill, killing } = useKillProcess();

  const getConnectionsTo = (nodeId: string) => {
    return edges.filter(e => e.target === nodeId).map(e => {
      const sourceNode = nodes.find(n => n.id === e.source);
      return sourceNode?.name || 'Unknown';
    });
  };

  const handleKill = async (pid: number, name: string) => {
    if (window.confirm(`Kill process "${name}" (PID: ${pid})?`)) {
      await kill(pid);
    }
  };

  return (
    <div className="service-list">
      {nodes.map(node => {
        const connections = getConnectionsTo(node.id);

        return (
          <div key={node.id} className="service-card">
            <div className="service-header">
              <div
                className="service-type-badge"
                style={{ backgroundColor: TYPE_COLORS[node.type] || TYPE_COLORS.service }}
              >
                {TYPE_LABELS[node.type] || 'Service'}
              </div>
              {node.pid > 0 && (
                <button
                  className="kill-btn"
                  onClick={() => handleKill(node.pid, node.name)}
                  disabled={killing}
                  title="Stop process"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                    <path d="M14 1.41L12.59 0 7 5.59 1.41 0 0 1.41 5.59 7 0 12.59 1.41 14 7 8.41 12.59 14 14 12.59 8.41 7z"/>
                  </svg>
                </button>
              )}
            </div>
            <div className="service-name">{node.name}</div>
            {node.project && <div className="service-project">{node.project}</div>}
            <div className="service-ports">
              {node.ports.map(p => (
                <span key={p.port} className="port-badge">
                  :{p.port}
                  {p.description && <span className="port-desc">{p.description}</span>}
                </span>
              ))}
            </div>
            <div className="service-meta">
              <span className="meta-item">PID: {node.pid}</span>
              <span className="meta-item">CPU: {node.cpu.toFixed(1)}%</span>
              <span className="meta-item">MEM: {node.memory.toFixed(1)}%</span>
            </div>
            {connections.length > 0 && (
              <div className="service-connections">
                <span className="connections-label">Connected from:</span>
                {connections.map((name, i) => (
                  <span key={i} className="connection-badge">{name}</span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
