import React from 'react';
import type { Port } from '../types/electron';

interface PortListProps {
  ports: Port[];
}

const COMMON_PORTS: Record<number, string> = {
  80: 'HTTP',
  443: 'HTTPS',
  3000: 'React/Node',
  3001: 'Dev Server',
  4000: 'GraphQL',
  5000: 'Flask',
  5173: 'Vite',
  5432: 'PostgreSQL',
  6379: 'Redis',
  8000: 'Django',
  8080: 'HTTP Alt',
  8443: 'HTTPS Alt',
  9000: 'PHP-FPM',
  27017: 'MongoDB',
  3306: 'MySQL',
};

export function PortList({ ports }: PortListProps) {
  // Sort by port number
  const sortedPorts = [...ports].sort((a, b) => a.port - b.port);

  return (
    <div className="port-list">
      {sortedPorts.map(port => (
        <div key={`${port.port}-${port.pid}`} className="port-item">
          <div className="port-number">:{port.port}</div>
          <div className="port-info">
            <div className="port-process">{port.process}</div>
            <div className="port-details">
              <span className="port-detail">PID: {port.pid}</span>
              <span className="port-detail">{port.host === '*' ? 'All interfaces' : port.host}</span>
              {COMMON_PORTS[port.port] && (
                <span className="port-detail port-hint">{COMMON_PORTS[port.port]}</span>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
