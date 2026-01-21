import React from 'react';
import { useSystemSnapshot } from './hooks/useSystemMonitor';
import { ServiceList } from './components/ServiceList';
import { PortList } from './components/PortList';
import { Header } from './components/Header';
import './App.css';

function App() {
  const { snapshot, loading, refresh, error } = useSystemSnapshot(2000);
  const { graph, ports } = snapshot;

  return (
    <div className="app">
      <Header
        serviceCount={graph.nodes.length}
        connectionCount={graph.edges.length}
        onRefresh={refresh}
      />
      {error && (
        <div className="error-banner">
          <span className="error-title">Monitoring error:</span>
          <span className="error-message">{error}</span>
        </div>
      )}
      <main className="main-content">
        <div className="panel services-panel">
          <h2 className="panel-title">Services</h2>
          {loading ? (
            <div className="loading">Scanning...</div>
          ) : graph.nodes.length === 0 ? (
            <div className="empty-state">
              <p>No dev services detected</p>
              <span className="empty-hint">Start a local server to see it here</span>
            </div>
          ) : (
            <ServiceList nodes={graph.nodes} edges={graph.edges} />
          )}
        </div>
        <div className="panel ports-panel">
          <h2 className="panel-title">Listening Ports</h2>
          {loading ? (
            <div className="loading">Scanning...</div>
          ) : ports.length === 0 ? (
            <div className="empty-state">
              <p>No ports in use</p>
            </div>
          ) : (
            <PortList ports={ports} />
          )}
        </div>
      </main>
    </div>
  );
}

export default App;
