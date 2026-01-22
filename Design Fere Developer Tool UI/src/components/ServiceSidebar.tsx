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

interface ServiceSidebarProps {
  services: Service[];
}

const getServiceColor = (type: string) => {
  switch (type) {
    case 'database':
    case 'runtime':
      return '#76B900'; // NVIDIA Green
    case 'frontend':
    case 'backend':
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
    runtime: 'Runtime'
  };
  return labels[type] || 'Service';
};

export function ServiceSidebar({ services }: ServiceSidebarProps) {
  // Get all unique ports
  const allPorts = services.map(s => s.port).sort((a, b) => a - b);

  return (
    <div className="h-full flex flex-col gap-5">
      {/* Services List */}
      <div className="flex-1 bg-white rounded-xl border border-[#e5e5e5] overflow-hidden flex flex-col" style={{ boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)' }}>
        <div className="px-6 py-5 border-b border-[#e5e5e5] bg-gradient-to-b from-[#fafafa] to-white">
          <h2 
            className="text-[15px] text-[#0a0a0a]"
            style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, letterSpacing: '-0.01em' }}
          >
            Running Services
          </h2>
          <p 
            className="text-[12px] text-[#737373] mt-1"
            style={{ fontFamily: 'Inter, sans-serif' }}
          >
            {services.length} active
          </p>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {services.map(service => {
            const accentColor = getServiceColor(service.type);
            
            return (
              <div
                key={service.id}
                className="p-4 rounded-lg border border-[#e5e5e5] hover:border-[#d4d4d4] hover:shadow-sm transition-all duration-200 bg-white"
              >
                <div className="flex items-start justify-between mb-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <div 
                        className="w-2 h-2 rounded-full"
                        style={{ 
                          backgroundColor: accentColor,
                          boxShadow: `0 0 6px ${accentColor}40`
                        }}
                      />
                      <h3 
                        className="text-[14px] text-[#0a0a0a]"
                        style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, letterSpacing: '-0.01em' }}
                      >
                        {service.name}
                      </h3>
                    </div>
                    <span 
                      className="text-[11px] px-2 py-1 rounded-md inline-block"
                      style={{ 
                        fontFamily: 'Inter, sans-serif',
                        backgroundColor: `${accentColor}12`,
                        color: accentColor,
                        fontWeight: 600,
                        letterSpacing: '0.02em'
                      }}
                    >
                      {getTypeBadge(service.type)}
                    </span>
                  </div>
                  <div 
                    className="text-[13px] px-2.5 py-1 rounded-md"
                    style={{ 
                      fontFamily: 'JetBrains Mono, monospace',
                      backgroundColor: '#f5f5f5',
                      color: accentColor,
                      fontWeight: 600
                    }}
                  >
                    :{service.port}
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-3 mt-3 pt-3 border-t border-[#f5f5f5]">
                  <div>
                    <div 
                      className="text-[10px] text-[#a3a3a3] mb-1 uppercase tracking-wide"
                      style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
                    >
                      CPU
                    </div>
                    <div 
                      className="text-[13px] text-[#0a0a0a]"
                      style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
                    >
                      {service.cpu}%
                    </div>
                  </div>
                  <div>
                    <div 
                      className="text-[10px] text-[#a3a3a3] mb-1 uppercase tracking-wide"
                      style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600 }}
                    >
                      Memory
                    </div>
                    <div 
                      className="text-[13px] text-[#0a0a0a]"
                      style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
                    >
                      {service.memory} MB
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Ports List */}
      <div className="bg-white rounded-xl border border-[#e5e5e5] p-6" style={{ boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)' }}>
        <h3 
          className="text-[14px] text-[#0a0a0a] mb-4"
          style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, letterSpacing: '-0.01em' }}
        >
          Active Ports
        </h3>
        <div className="flex flex-wrap gap-2">
          {allPorts.map(port => (
            <div
              key={port}
              className="px-3 py-1.5 bg-[#f5f5f5] border border-[#e5e5e5] rounded-lg text-[12px] text-[#0a0a0a] hover:bg-[#efefef] transition-colors"
              style={{ fontFamily: 'JetBrains Mono, monospace', fontWeight: 600 }}
            >
              :{port}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}