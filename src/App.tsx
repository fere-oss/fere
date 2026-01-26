import { useState, useMemo, useEffect } from 'react';
import { useSystemSnapshot } from './hooks/useSystemMonitor';
import { GraphView } from './components/GraphView';
import { ServiceSidebar } from './components/ServiceSidebar';
import { CurlBuilder } from './components/CurlBuilder';
import './App.css';

// Detect platform for default tab label
const isMacOS = navigator.userAgent.toLowerCase().includes('mac');
const SYSTEM_TAB_LABEL = isMacOS ? 'macOS' : 'System';
const SYSTEM_TAB_ID = '__system__';

// View modes
type ViewMode = 'graph' | 'api-tester';

function App() {
  const { snapshot, loading, error } = useSystemSnapshot(2000);
  const { graph, ports } = snapshot;

  // View mode state - graph or api-tester
  const [viewMode, setViewMode] = useState<ViewMode>('graph');

  // Selected tab state - default to system tab
  const [selectedTab, setSelectedTab] = useState<string>(SYSTEM_TAB_ID);

  // Build tabs from unique projectPaths
  const tabs = useMemo(() => {
    const projectPaths = new Map<string, string>(); // path -> label

    graph.nodes.forEach(node => {
      if (node.projectPath) {
        // Extract folder name as label
        const label = node.projectPath.split('/').pop() || node.projectPath;
        projectPaths.set(node.projectPath, label);
      }
    });

    // Sort project tabs alphabetically by label
    const projectTabs = Array.from(projectPaths.entries())
      .map(([path, label]) => ({ id: path, label }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // System tab first, then project tabs
    return [
      { id: SYSTEM_TAB_ID, label: SYSTEM_TAB_LABEL },
      ...projectTabs,
    ];
  }, [graph.nodes]);

  // Auto-select first available tab if current selection becomes invalid
  useEffect(() => {
    const tabIds = tabs.map(t => t.id);
    if (!tabIds.includes(selectedTab) && tabs.length > 0) {
      setSelectedTab(tabs[0].id);
    }
  }, [tabs, selectedTab]);

  // Filter nodes based on selected tab
  const filteredData = useMemo(() => {
    const isSystemTab = selectedTab === SYSTEM_TAB_ID;

    // Get primary nodes for this tab (non-external nodes matching the filter)
    const primaryNodes = graph.nodes.filter(node => {
      // External nodes are handled separately
      if (node.type === 'external') return false;

      if (isSystemTab) {
        // System tab: nodes without projectPath
        return !node.projectPath;
      } else {
        // Project tab: nodes matching this projectPath
        return node.projectPath === selectedTab;
      }
    });

    const primaryNodeIds = new Set(primaryNodes.map(n => n.id));

    // Find external nodes connected to primary nodes
    const connectedExternalIds = new Set<string>();
    graph.edges.forEach(edge => {
      if (primaryNodeIds.has(edge.source) || primaryNodeIds.has(edge.target)) {
        // Check if either end is an external node
        const sourceNode = graph.nodes.find(n => n.id === edge.source);
        const targetNode = graph.nodes.find(n => n.id === edge.target);

        if (sourceNode?.type === 'external') connectedExternalIds.add(sourceNode.id);
        if (targetNode?.type === 'external') connectedExternalIds.add(targetNode.id);
      }
    });

    // Include external nodes that are connected
    const externalNodes = graph.nodes.filter(n => connectedExternalIds.has(n.id));
    const filteredNodes = [...primaryNodes, ...externalNodes];
    const filteredNodeIds = new Set(filteredNodes.map(n => n.id));

    // Filter edges to only include those between filtered nodes
    const filteredEdges = graph.edges.filter(edge =>
      filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
    );

    // Filter ports to only include those from primary nodes (not external)
    const primaryPorts = new Set<number>();
    primaryNodes.forEach(node => {
      node.ports.forEach(p => primaryPorts.add(p.port));
    });
    const filteredPorts = ports.filter(p => primaryPorts.has(p.port));

    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      ports: filteredPorts,
    };
  }, [graph.nodes, graph.edges, ports, selectedTab]);

  return (
    <div className="app">
      {/* App Title */}
      <div className="app-header">
        <h1 className="app-title">fere</h1>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <span className="error-title">Error:</span>
          <span className="error-message">{error}</span>
        </div>
      )}

      {/* View Mode Tabs */}
      <div className="view-mode-tabs">
        <button
          className={`view-mode-tab ${viewMode === 'graph' ? 'view-mode-tab-active' : ''}`}
          onClick={() => setViewMode('graph')}
        >
          <span className="view-mode-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <circle cx="3" cy="8" r="2" fill="currentColor"/>
              <circle cx="13" cy="4" r="2" fill="currentColor"/>
              <circle cx="13" cy="12" r="2" fill="currentColor"/>
              <path d="M5 8L11 5M5 8L11 11" stroke="currentColor" strokeWidth="1.5"/>
            </svg>
          </span>
          Service Map
        </button>
        <button
          className={`view-mode-tab ${viewMode === 'api-tester' ? 'view-mode-tab-active' : ''}`}
          onClick={() => setViewMode('api-tester')}
        >
          <span className="view-mode-icon">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 4L6 8L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M8 12H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
          </span>
          API Tester
        </button>
      </div>

      {/* Project Tabs - only show for graph view */}
      {viewMode === 'graph' && tabs.length > 1 && (
        <div className="app-tabs">
          {tabs.map(tab => (
            <button
              key={tab.id}
              className={`app-tab ${selectedTab === tab.id ? 'app-tab-active' : ''}`}
              onClick={() => setSelectedTab(tab.id)}
            >
              {tab.label}
              {selectedTab === tab.id && (
                <span className="app-tab-count">
                  {filteredData.nodes.filter(n => n.type !== 'external').length}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Main Content */}
      <main className="main-content">
        {viewMode === 'graph' ? (
          <>
            {/* Connection Graph */}
            <div className="graph-container">
              {loading ? (
                <div className="loading">Scanning localhost...</div>
              ) : (
                <GraphView nodes={filteredData.nodes} edges={filteredData.edges} />
              )}
            </div>

            {/* Sidebar */}
            <div className="sidebar">
              <ServiceSidebar
                nodes={filteredData.nodes}
                ports={filteredData.ports}
                loading={loading}
              />
            </div>
          </>
        ) : (
          /* API Tester View */
          <div className="api-tester-container">
            {loading ? (
              <div className="loading">Scanning localhost...</div>
            ) : (
              <CurlBuilder nodes={graph.nodes} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
