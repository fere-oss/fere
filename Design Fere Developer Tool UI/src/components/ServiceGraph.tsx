import { ServiceNode } from './ServiceNode';
import { useEffect, useRef, useState } from 'react';

interface Service {
  id: string;
  name: string;
  type: string;
  port: number;
  cpu: number;
  memory: number;
  status: string;
  connections: string[];
}

interface ServiceGraphProps {
  services: Service[];
}

interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function ServiceGraph({ services }: ServiceGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());

  // Organize services by layer
  const frontend = services.filter(s => s.type === 'frontend');
  const backend = services.filter(s => s.type === 'backend' || s.type === 'runtime');
  const database = services.filter(s => s.type === 'database');

  // Create connection map for drawing lines
  const connections: Array<{ from: string; to: string }> = [];
  services.forEach(service => {
    service.connections.forEach(targetId => {
      connections.push({ from: service.id, to: targetId });
    });
  });

  // Calculate node positions
  useEffect(() => {
    if (!containerRef.current) return;

    const positions = new Map<string, NodePosition>();
    const container = containerRef.current;
    const containerRect = container.getBoundingClientRect();

    services.forEach(service => {
      const element = container.querySelector(`#node-${service.id}`);
      if (element) {
        const rect = element.getBoundingClientRect();
        positions.set(service.id, {
          x: rect.left - containerRect.left + rect.width / 2,
          y: rect.top - containerRect.top + rect.height / 2,
          width: rect.width,
          height: rect.height
        });
      }
    });

    setNodePositions(positions);
  }, [services]);

  // Generate SVG path for connection
  const getConnectionPath = (fromId: string, toId: string) => {
    const from = nodePositions.get(fromId);
    const to = nodePositions.get(toId);

    if (!from || !to) return '';

    const startX = from.x;
    const startY = from.y + (from.height / 2) + 10;
    const endX = to.x;
    const endY = to.y - (to.height / 2) - 10;

    // Control point for curve
    const controlY = startY + (endY - startY) / 2;

    return `M ${startX} ${startY} C ${startX} ${controlY}, ${endX} ${controlY}, ${endX} ${endY}`;
  };

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-auto p-12">
      <svg 
        className="absolute inset-0 w-full h-full pointer-events-none z-0"
        style={{ top: 0, left: 0 }}
      >
        <defs>
          <marker
            id="arrowhead"
            markerWidth="10"
            markerHeight="10"
            refX="8"
            refY="5"
            orient="auto"
          >
            <polygon
              points="0 0, 10 5, 0 10"
              fill="#a3a3a3"
            />
          </marker>
        </defs>
        
        {/* Connection lines */}
        {connections.map((conn, i) => {
          const path = getConnectionPath(conn.from, conn.to);
          
          return (
            <path
              key={i}
              d={path}
              stroke="#c7c7c7"
              strokeWidth="2.5"
              fill="none"
              markerEnd="url(#arrowhead)"
              strokeDasharray="0"
              opacity="0.7"
            />
          );
        })}
      </svg>

      <div className="relative z-10 flex flex-col items-center gap-20">
        {/* Frontend Layer */}
        {frontend.length > 0 && (
          <div className="flex flex-col items-center gap-6">
            <div className="text-[11px] text-[#a3a3a3] tracking-wider mb-1" style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600 }}>
              FRONTEND
            </div>
            <div className="flex gap-8">
              {frontend.map(service => (
                <div key={service.id} id={`node-${service.id}`}>
                  <ServiceNode
                    name={service.name}
                    type={service.type}
                    port={service.port}
                    status={service.status}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Backend Layer */}
        {backend.length > 0 && (
          <div className="flex flex-col items-center gap-6">
            <div className="text-[11px] text-[#a3a3a3] tracking-wider mb-1" style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600 }}>
              BACKEND / RUNTIME
            </div>
            <div className="flex gap-8">
              {backend.map(service => (
                <div key={service.id} id={`node-${service.id}`}>
                  <ServiceNode
                    name={service.name}
                    type={service.type}
                    port={service.port}
                    status={service.status}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Database Layer */}
        {database.length > 0 && (
          <div className="flex flex-col items-center gap-6">
            <div className="text-[11px] text-[#a3a3a3] tracking-wider mb-1" style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600 }}>
              DATABASE
            </div>
            <div className="flex gap-8">
              {database.map(service => (
                <div key={service.id} id={`node-${service.id}`}>
                  <ServiceNode
                    name={service.name}
                    type={service.type}
                    port={service.port}
                    status={service.status}
                  />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}