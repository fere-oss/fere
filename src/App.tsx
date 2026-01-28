import { useState, useMemo, useEffect, useCallback } from "react";
import { useSystemSnapshot } from "./hooks/useSystemMonitor";
import { GraphView } from "./components/GraphView";
import { ServiceSidebar } from "./components/ServiceSidebar";
import { CurlBuilder } from "./components/CurlBuilder";
import "./App.css";

// Detect platform for default tab label
const isMacOS = navigator.userAgent.toLowerCase().includes("mac");
const SYSTEM_TAB_LABEL = isMacOS ? "macOS" : "System";
const SYSTEM_TAB_ID = "__system__";

// View modes
type ViewMode = "graph" | "containers" | "api-tester";

function App() {
  const { snapshot, loading, error } = useSystemSnapshot(2000);
  const { graph, ports } = snapshot;

  // View mode state - graph or api-tester
  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  // Selected tab state - default to system tab
  const [selectedTab, setSelectedTab] = useState<string>(SYSTEM_TAB_ID);

  // Service to pre-select in API tester when navigating from sidebar
  const [testServiceId, setTestServiceId] = useState<string | undefined>();

  // Handle "Test" button click from sidebar - switch to API tester with service pre-selected
  const handleTestService = useCallback((nodeId: string) => {
    setTestServiceId(nodeId);
    setViewMode("api-tester");
  }, []);

  // Build tabs from unique projectPaths
  const tabs = useMemo(() => {
    const projectPaths = new Map<string, string>(); // path -> label

    graph.nodes.forEach((node) => {
      if (node.projectPath) {
        // Extract folder name as label
        const label = node.projectPath.split("/").pop() || node.projectPath;
        projectPaths.set(node.projectPath, label);
      }
    });

    // Sort project tabs alphabetically by label
    const projectTabs = Array.from(projectPaths.entries())
      .map(([path, label]) => ({ id: path, label }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // System tab first, then project tabs
    return [{ id: SYSTEM_TAB_ID, label: SYSTEM_TAB_LABEL }, ...projectTabs];
  }, [graph.nodes]);

  // Auto-select first available tab if current selection becomes invalid
  useEffect(() => {
    const tabIds = tabs.map((t) => t.id);
    if (!tabIds.includes(selectedTab) && tabs.length > 0) {
      setSelectedTab(tabs[0].id);
    }
  }, [tabs, selectedTab]);

  // Filter nodes based on selected tab
  const filteredData = useMemo(() => {
    const isSystemTab = selectedTab === SYSTEM_TAB_ID;

    // Get primary nodes for this tab (non-external nodes matching the filter)
    const primaryNodes = graph.nodes.filter((node) => {
      // External nodes are handled separately
      if (node.type === "external") return false;

      if (isSystemTab) {
        // System tab: nodes without projectPath
        return !node.projectPath;
      } else {
        // Project tab: nodes matching this projectPath
        return node.projectPath === selectedTab;
      }
    });

    const primaryNodeIds = new Set(primaryNodes.map((n) => n.id));

    // Find external nodes connected to primary nodes
    const connectedExternalIds = new Set<string>();
    graph.edges.forEach((edge) => {
      if (primaryNodeIds.has(edge.source) || primaryNodeIds.has(edge.target)) {
        // Check if either end is an external node
        const sourceNode = graph.nodes.find((n) => n.id === edge.source);
        const targetNode = graph.nodes.find((n) => n.id === edge.target);

        if (sourceNode?.type === "external")
          connectedExternalIds.add(sourceNode.id);
        if (targetNode?.type === "external")
          connectedExternalIds.add(targetNode.id);
      }
    });

    // Include external nodes that are connected
    const externalNodes = graph.nodes.filter((n) =>
      connectedExternalIds.has(n.id),
    );
    const filteredNodes = [...primaryNodes, ...externalNodes];
    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));

    // Filter edges to only include those between filtered nodes
    const filteredEdges = graph.edges.filter(
      (edge) =>
        filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target),
    );

    // Filter ports to only include those from primary nodes (not external)
    const primaryPorts = new Set<number>();
    primaryNodes.forEach((node) => {
      node.ports.forEach((p) => primaryPorts.add(p.port));
    });
    const filteredPorts = ports.filter((p) => primaryPorts.has(p.port));

    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      ports: filteredPorts,
    };
  }, [graph.nodes, graph.edges, ports, selectedTab]);

  // Filter to show only running Docker containers
  const dockerContainerData = useMemo(() => {
    // Get only running Docker container nodes (exclude exited, dead, etc.)
    const containerNodes = graph.nodes.filter(
      (node) => node.isDockerContainer && node.containerState === "running"
    );
    const containerNodeIds = new Set(containerNodes.map((n) => n.id));

    // Filter edges to only include those between Docker containers
    const containerEdges = graph.edges.filter(
      (edge) =>
        containerNodeIds.has(edge.source) && containerNodeIds.has(edge.target),
    );

    // Get ports from containers
    const containerPorts = new Set<number>();
    containerNodes.forEach((node) => {
      node.ports.forEach((p) => containerPorts.add(p.port));
    });
    const filteredPorts = ports.filter((p) => containerPorts.has(p.port));

    return {
      nodes: containerNodes,
      edges: containerEdges,
      ports: filteredPorts,
    };
  }, [graph.nodes, graph.edges, ports]);

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
          className={`view-mode-tab ${viewMode === "graph" ? "view-mode-tab-active" : ""}`}
          onClick={() => setViewMode("graph")}
        >
          <span className="view-mode-icon">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <circle cx="3" cy="8" r="2" fill="currentColor" />
              <circle cx="13" cy="4" r="2" fill="currentColor" />
              <circle cx="13" cy="12" r="2" fill="currentColor" />
              <path
                d="M5 8L11 5M5 8L11 11"
                stroke="currentColor"
                strokeWidth="1.5"
              />
            </svg>
          </span>
          Service Map
        </button>
        <button
          className={`view-mode-tab ${viewMode === "containers" ? "view-mode-tab-active" : ""}`}
          onClick={() => setViewMode("containers")}
        >
          <span className="view-mode-icon">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
            </svg>
          </span>
          Containers
        </button>
        <button
          className={`view-mode-tab ${viewMode === "api-tester" ? "view-mode-tab-active" : ""}`}
          onClick={() => setViewMode("api-tester")}
        >
          <span className="view-mode-icon">
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M2 4L6 8L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M8 12H14"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </span>
          Requests
        </button>
      </div>

      {/* Project Tabs - only show for graph view */}
      {viewMode === "graph" && tabs.length > 1 && (
        <div className="app-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              className={`app-tab ${selectedTab === tab.id ? "app-tab-active" : ""}`}
              onClick={() => setSelectedTab(tab.id)}
            >
              {tab.label}
              {selectedTab === tab.id && (
                <span className="app-tab-count">
                  {
                    filteredData.nodes.filter((n) => n.type !== "external")
                      .length
                  }
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* Main Content */}
      <main className="main-content">
        {viewMode === "graph" ? (
          <>
            {/* Connection Graph */}
            <div className="graph-container">
              {loading ? (
                <div className="loading">Scanning localhost...</div>
              ) : (
                <GraphView
                  nodes={filteredData.nodes}
                  edges={filteredData.edges}
                />
              )}
            </div>

            {/* Sidebar */}
            <div className="sidebar">
              <ServiceSidebar
                nodes={filteredData.nodes}
                ports={filteredData.ports}
                loading={loading}
                onTestService={handleTestService}
              />
            </div>
          </>
        ) : viewMode === "containers" ? (
          <>
            {/* Docker Containers Graph */}
            <div className="graph-container">
              {loading ? (
                <div className="loading">Scanning Docker containers...</div>
              ) : dockerContainerData.nodes.length === 0 ? (
                <div className="graph-empty">
                  <div className="docker-empty-icon">
                    <svg
                      width="48"
                      height="48"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                      opacity="0.3"
                    >
                      <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
                    </svg>
                  </div>
                  <p>No Docker containers running</p>
                  <span>Start some containers to see them here</span>
                </div>
              ) : (
                <GraphView
                  nodes={dockerContainerData.nodes}
                  edges={dockerContainerData.edges}
                  isContainerView={true}
                />
              )}
            </div>

            {/* Sidebar for containers */}
            <div className="sidebar">
              <ServiceSidebar
                nodes={dockerContainerData.nodes}
                ports={dockerContainerData.ports}
                loading={loading}
                onTestService={handleTestService}
              />
            </div>
          </>
        ) : (
          /* API Tester View */
          <div className="api-tester-container">
            {loading ? (
              <div className="loading">Scanning localhost...</div>
            ) : (
              <CurlBuilder nodes={graph.nodes} initialServiceId={testServiceId} />
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
