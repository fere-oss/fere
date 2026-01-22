import { ServiceGraph } from './components/ServiceGraph';
import { ServiceSidebar } from './components/ServiceSidebar';

// Mock data for services
const services = [
  {
    id: 'frontend',
    name: 'React App',
    type: 'frontend',
    port: 3000,
    cpu: 12,
    memory: 245,
    status: 'running',
    connections: ['backend-api']
  },
  {
    id: 'backend-api',
    name: 'Express API',
    type: 'backend',
    port: 8080,
    cpu: 8,
    memory: 156,
    status: 'running',
    connections: ['postgres', 'redis']
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    type: 'database',
    port: 5432,
    cpu: 5,
    memory: 312,
    status: 'running',
    connections: []
  },
  {
    id: 'redis',
    name: 'Redis Cache',
    type: 'database',
    port: 6379,
    cpu: 2,
    memory: 89,
    status: 'running',
    connections: []
  },
  {
    id: 'python-worker',
    name: 'Python Worker',
    type: 'runtime',
    port: 5000,
    cpu: 15,
    memory: 198,
    status: 'running',
    connections: ['postgres']
  }
];

export default function App() {
  return (
    <div className="h-screen bg-[#f5f5f5] flex flex-col overflow-hidden">
      {/* macOS Traffic Lights */}
      <div className="absolute top-0 left-0 z-50 flex gap-2 p-5">
        <div className="w-3 h-3 rounded-full bg-[#FF5F57] hover:bg-[#FF4842] transition-colors cursor-pointer" />
        <div className="w-3 h-3 rounded-full bg-[#FFBD2E] hover:bg-[#FFB01F] transition-colors cursor-pointer" />
        <div className="w-3 h-3 rounded-full bg-[#28CA42] hover:bg-[#1FB834] transition-colors cursor-pointer" />
      </div>

      {/* App Title */}
      <div className="pt-16 pb-7 px-10">
        <h1 className="text-[28px] tracking-tight text-[#0a0a0a]" style={{ fontFamily: 'Inter, sans-serif', fontWeight: 700, letterSpacing: '-0.02em' }}>
          Fere
        </h1>
        <p className="text-[14px] text-[#737373] mt-1.5" style={{ fontFamily: 'Inter, sans-serif' }}>
          Localhost Environment Visualizer
        </p>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex gap-6 px-10 pb-10 overflow-hidden">
        {/* Connection Graph */}
        <div className="flex-1 bg-white rounded-2xl border border-[#e5e5e5] overflow-hidden" style={{ boxShadow: '0 2px 12px rgba(0, 0, 0, 0.06)' }}>
          <ServiceGraph services={services} />
        </div>

        {/* Sidebar */}
        <div className="w-[340px]">
          <ServiceSidebar services={services} />
        </div>
      </div>
    </div>
  );
}