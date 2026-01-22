import { useSystemSnapshot } from './hooks/useSystemMonitor';
import { GraphView } from './components/GraphView';
import { ServiceSidebar } from './components/ServiceSidebar';
import './App.css';

function App() {
  const { snapshot, loading, error } = useSystemSnapshot(2000);
  const { graph, ports } = snapshot;

  return (
    <div className="app">
      {/* macOS Traffic Lights Area */}
      <div className="traffic-lights">
        <div className="traffic-light red" />
        <div className="traffic-light yellow" />
        <div className="traffic-light green" />
      </div>

      {/* App Title */}
      <div className="app-header">
        <h1 className="app-title">Fere</h1>
        <p className="app-subtitle">Localhost Environment Visualizer</p>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <span className="error-title">Error:</span>
          <span className="error-message">{error}</span>
        </div>
      )}

      {/* Main Content */}
      <main className="main-content">
        {/* Connection Graph */}
        <div className="graph-container">
          {loading ? (
            <div className="loading">Scanning localhost...</div>
          ) : (
            <GraphView nodes={graph.nodes} edges={graph.edges} />
          )}
        </div>

        {/* Sidebar */}
        <div className="sidebar">
          <ServiceSidebar nodes={graph.nodes} ports={ports} loading={loading} />
        </div>
      </main>
    </div>
  );
}

export default App;
