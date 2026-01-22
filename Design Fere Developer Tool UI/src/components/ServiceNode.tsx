interface ServiceNodeProps {
  name: string;
  type: string;
  port: number;
  status: string;
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

export function ServiceNode({ name, type, port, status }: ServiceNodeProps) {
  const accentColor = getServiceColor(type);

  return (
    <div 
      className="bg-white rounded-xl border border-[#e5e5e5] px-7 py-5 min-w-[220px] hover:border-[#d4d4d4] hover:shadow-md transition-all duration-200"
      style={{ boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)' }}
    >
      <div className="flex items-center gap-2.5 mb-3">
        <div 
          className="w-2.5 h-2.5 rounded-full"
          style={{ 
            backgroundColor: status === 'running' ? accentColor : '#a3a3a3',
            boxShadow: status === 'running' ? `0 0 8px ${accentColor}40` : 'none'
          }}
        />
        <span 
          className="text-[11px] px-2.5 py-1 rounded-md"
          style={{ 
            fontFamily: 'Inter, sans-serif',
            backgroundColor: `${accentColor}12`,
            color: accentColor,
            fontWeight: 600,
            letterSpacing: '0.02em'
          }}
        >
          {getTypeBadge(type)}
        </span>
      </div>
      
      <h3 
        className="text-[16px] text-[#0a0a0a] mb-2"
        style={{ fontFamily: 'Inter, sans-serif', fontWeight: 600, letterSpacing: '-0.01em' }}
      >
        {name}
      </h3>
      
      <div 
        className="text-[15px] text-[#525252] flex items-center gap-1.5"
        style={{ fontFamily: 'JetBrains Mono, monospace' }}
      >
        <span className="text-[#a3a3a3]">localhost</span>
        <span style={{ color: accentColor, fontWeight: 600 }}>:{port}</span>
      </div>
    </div>
  );
}