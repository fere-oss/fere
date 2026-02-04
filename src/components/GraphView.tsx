import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { GraphNode, GraphEdge } from '../types/electron';
import { SERVICE_COLORS } from './graph/constants';
import { externalApiCache, externalApiInFlight, EXTERNAL_API_CACHE_TTL_MS } from './graph/externalApis';
import { computeHierarchicalLayout } from './graph/layout';
import { groupContainersByProject, groupLayoutNodes } from './graph/grouping';
import { routeEdges } from './graph/edgeRouting';
import type { GraphViewProps, NodePosition, LayoutNode, RenderGroup } from './graph/types';
import { ContextMenu } from './graph/ContextMenu';
import { NodeDetailPanel } from './graph/NodeDetailPanel';
import { ProjectContainer } from './graph/ContainerGroups';
import { NodeGroupContainer } from './graph/ServiceNodes';

export function GraphView({
  nodes,
  edges,
  isContainerView = false,
  onDatabaseClick,
  onFreshnessClick,
  dataStatus,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [displayNodes, setDisplayNodes] = useState<GraphNode[]>(nodes);
  const [displayEdges, setDisplayEdges] = useState<GraphEdge[]>(edges);
  const [nodePositions, setNodePositions] = useState<Map<string, NodePosition>>(new Map());
  const [zoom, setZoom] = useState(0.6);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    node: GraphNode;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  // Handle node click - navigate to database page for database containers, otherwise show detail panel
  const handleNodeClick = useCallback((node: GraphNode) => {
    if (isContainerView && node.isDockerContainer && node.type === 'database' && onDatabaseClick) {
      onDatabaseClick(node);
    } else {
      setSelectedNode(node);
    }
  }, [isContainerView, onDatabaseClick]);

  const orderCacheRef = useRef<Map<number, string[]>>(new Map());
  const groupOrderCacheRef = useRef<Map<number, string[]>>(new Map());
  const [, setExternalApiVersion] = useState(0);

  // Create a stable key based on node IDs to trigger re-animation only on actual changes
  const nodeSetKey = useMemo(() => {
    return nodes.map(n => n.id).sort().join(',');
  }, [nodes]);

  const edgeSetKey = useMemo(() => {
    return edges.map(e => `${e.source}-${e.target}`).sort().join(',');
  }, [edges]);

  // Keep refs to latest nodes/edges for use in effect without causing re-runs
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  nodesRef.current = nodes;
  edgesRef.current = edges;

  // Track previous keys to detect actual changes
  const prevNodeSetKeyRef = useRef<string | null>(null);
  const prevEdgeSetKeyRef = useRef<string | null>(null);
  const isInitialRenderRef = useRef(true);

  useEffect(() => {
    const nodesChanged = prevNodeSetKeyRef.current !== nodeSetKey;
    const edgesChanged = prevEdgeSetKeyRef.current !== edgeSetKey;

    // Skip if nothing changed
    if (!nodesChanged && !edgesChanged) {
      return;
    }

    // Update refs
    prevNodeSetKeyRef.current = nodeSetKey;
    prevEdgeSetKeyRef.current = edgeSetKey;

    // On initial render or when content changes, update immediately
    if (isInitialRenderRef.current) {
      isInitialRenderRef.current = false;
      setDisplayNodes(nodesRef.current);
      setDisplayEdges(edgesRef.current);
    } else {
      // Small delay for tab switches to allow animation setup
      const timer = setTimeout(() => {
        setDisplayNodes(nodesRef.current);
        setDisplayEdges(edgesRef.current);
      }, 30);
      return () => clearTimeout(timer);
    }
  }, [nodeSetKey, edgeSetKey]);

  // Filter out external nodes
  const localNodes = useMemo(() => displayNodes.filter(n => {
    if (n.type === 'external') return false;
    if (n.id.includes('external-')) return false;
    if (/\d+\.\d+\.\d+\.\d+/.test(n.id)) return false;
    return true;
  }), [displayNodes]);

  // Filter edges to only include connections between local nodes
  const localEdges = useMemo(() => {
    const localNodeIds = new Set(localNodes.map(n => n.id));
    return displayEdges.filter(e => localNodeIds.has(e.source) && localNodeIds.has(e.target));
  }, [localNodes, displayEdges]);

  // Create a stable key for project paths to prevent unnecessary external API fetches
  const projectPathsKey = useMemo(() => {
    return Array.from(
      new Set(localNodes.map(node => node.projectPath).filter(Boolean))
    ).sort().join(',');
  }, [localNodes]);

  // Keep ref to localNodes for use in effect
  const localNodesRef = useRef(localNodes);
  localNodesRef.current = localNodes;

  useEffect(() => {
    if (!window.electronAPI?.getExternalApis) return;
    if (!projectPathsKey) return;

    const projectPaths = projectPathsKey.split(',').filter(Boolean);
    if (projectPaths.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        for (const projectPath of projectPaths) {
          if (cancelled) return;
          const cached = externalApiCache.get(projectPath);
          if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) continue;
          if (externalApiInFlight.has(projectPath)) continue;
          externalApiInFlight.add(projectPath);
          try {
            const apis = await window.electronAPI.getExternalApis(projectPath);
            if (cancelled) return;
            externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
            setExternalApiVersion(version => version + 1);
          } catch (error) {
            if (cancelled) return;
          } finally {
            externalApiInFlight.delete(projectPath);
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectPathsKey]);

  // Compute hierarchical layout (returns connected and standalone nodes separately)
  const { connected: connectedLayout, standalone: standaloneLayout } = useMemo(() =>
    computeHierarchicalLayout(localNodes, localEdges),
    [localNodes, localEdges]
  );

  // Stabilize connected node ordering to prevent jitter
  const stableConnectedLayout = useMemo(() => {
    const byLayer = new Map<number, LayoutNode[]>();
    connectedLayout.forEach(node => {
      if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
      byLayer.get(node.layer)!.push(node);
    });

    const stableOrders = new Map<string, number>();
    byLayer.forEach((layerNodes, layer) => {
      const groups = new Map<string, LayoutNode[]>();
      layerNodes.forEach(node => {
        if (!groups.has(node.groupId)) groups.set(node.groupId, []);
        groups.get(node.groupId)!.push(node);
      });

      const groupIds = Array.from(groups.keys());
      const groupOrderSeed = [...groupIds].sort((a, b) => {
        const aOrder = Math.min(...groups.get(a)!.map(n => n.order));
        const bOrder = Math.min(...groups.get(b)!.map(n => n.order));
        return aOrder - bOrder;
      });

      const cachedGroupOrder = groupOrderCacheRef.current.get(layer);
      const groupSet = new Set(groupIds);
      const sameGroupSet =
        cachedGroupOrder &&
        cachedGroupOrder.length === groupIds.length &&
        cachedGroupOrder.every(id => groupSet.has(id));
      const finalGroupOrder = sameGroupSet ? cachedGroupOrder : groupOrderSeed;
      groupOrderCacheRef.current.set(layer, finalGroupOrder);

      const cachedNodeOrder = orderCacheRef.current.get(layer) || [];
      const cachedIndex = new Map(cachedNodeOrder.map((id, idx) => [id, idx]));
      const finalNodeOrder: string[] = [];

      finalGroupOrder.forEach(groupId => {
        const nodes = groups.get(groupId) || [];
        nodes.sort((a, b) => {
          const aIdx = cachedIndex.get(a.node.id);
          const bIdx = cachedIndex.get(b.node.id);
          if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
          if (aIdx !== undefined) return -1;
          if (bIdx !== undefined) return 1;
          if (a.order !== b.order) return a.order - b.order;
          return a.node.id.localeCompare(b.node.id);
        });
        nodes.forEach(node => finalNodeOrder.push(node.node.id));
      });

      orderCacheRef.current.set(layer, finalNodeOrder);
      finalNodeOrder.forEach((id, index) => {
        stableOrders.set(id, index);
      });
    });

    return connectedLayout.map(node => ({
      ...node,
      order: stableOrders.get(node.node.id) ?? node.order,
    }));
  }, [connectedLayout]);

  // Get unique layers and sort them for connected topology
  const sortedLayers = useMemo(() => {
    const layers = new Set(stableConnectedLayout.map(ln => ln.layer));
    return Array.from(layers).sort((a, b) => a - b);
  }, [stableConnectedLayout]);

  // Group nodes by layer for rendering (dynamic layers based on topology)
  const layerGroups = useMemo(() => {
    const groups: Map<number, RenderGroup[]> = new Map();
    sortedLayers.forEach(layer => {
      groups.set(layer, groupLayoutNodes(stableConnectedLayout, layer));
    });
    return groups;
  }, [stableConnectedLayout, sortedLayers]);

  // Group standalone nodes for rendering
  const standaloneGroups = useMemo(() => {
    if (standaloneLayout.length === 0) return [];

    // Group by type for standalone services
    const byType = new Map<string, GraphNode[]>();
    standaloneLayout.forEach(ln => {
      const type = ln.node.type;
      if (!byType.has(type)) byType.set(type, []);
      byType.get(type)!.push(ln.node);
    });

    const result: RenderGroup[] = [];
    byType.forEach((nodes, type) => {
      result.push({
        groupName: SERVICE_COLORS[type]?.label || type,
        nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
        isGroup: nodes.length > 1,
      });
    });

    return result.sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [standaloneLayout]);

  // Container projects for container view mode (grouped by project, then by type)
  const containerProjects = useMemo(() => {
    if (!isContainerView) return [];
    return groupContainersByProject(localNodes);
  }, [isContainerView, localNodes]);

  // Get layer label based on layer index and content
  const getLayerLabel = useCallback((layer: number, nodes: GraphNode[]): string => {
    // Analyze node types in this layer
    const types = new Set(nodes.map(n => n.type));

    if (layer === 0) {
      if (types.has('frontend')) return 'FRONTEND';
      return 'ENTRY POINTS';
    }

    if (types.has('database') || types.has('cache')) {
      if (types.size === 1 && types.has('database')) return 'DATABASE';
      if (types.size === 1 && types.has('cache')) return 'CACHE';
      return 'DATA LAYER';
    }

    if (types.has('backend') || types.has('webserver') || types.has('nodejs') || types.has('python')) {
      return `TIER ${layer}`;
    }

    if (types.has('broker') || types.has('realtime')) {
      return 'MESSAGING';
    }

    if (types.has('worker') || types.has('client')) {
      return 'WORKERS';
    }

    return `TIER ${layer}`;
  }, []);

  const formatAge = useCallback((ageMs?: number | null) => {
    if (ageMs === null || ageMs === undefined) return '—';
    if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))}ms`;
    if (ageMs < 60000) return `${(ageMs / 1000).toFixed(1)}s`;
    return `${Math.round(ageMs / 60000)}m`;
  }, []);

  // Force re-render every second to update the "time ago" display
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setTick(t => t + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const lastUpdated = dataStatus?.collectedAt
    ? formatAge(Date.now() - dataStatus.collectedAt)
    : '—';

  // Create connection list from edges
  const connections = useMemo(() =>
    localEdges.map(edge => ({
      from: edge.source,
      to: edge.target,
      sourcePort: edge.sourcePort,
      targetPort: edge.targetPort,
      confidence: edge.confidence ?? 0.6,
    })),
    [localEdges]
  );

  const zoomStep = 0.05;
  const clampZoom = useCallback((value: number) => Math.max(0.4, Math.min(2, value)), []);

  // Zoom handlers
  const handleZoomIn = () => setZoom(z => clampZoom(z + zoomStep));
  const handleZoomOut = () => setZoom(z => clampZoom(z - zoomStep));
  const handleZoomReset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Pan handlers with requestAnimationFrame for smooth movement
  const rafRef = useRef<number | null>(null);
  const panRef = useRef(pan);
  panRef.current = pan;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (selectedNode || contextMenu) return;
    if (e.button !== 0) return;
    setIsDragging(true);
    setDragStart({ x: e.clientX - panRef.current.x, y: e.clientY - panRef.current.y });
  }, [selectedNode, contextMenu]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (selectedNode || contextMenu) return;
    if (!isDragging) return;

    const newX = e.clientX - dragStart.x;
    const newY = e.clientY - dragStart.y;

    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      setPan({ x: newX, y: newY });
    });
  }, [isDragging, dragStart, selectedNode, contextMenu]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.closest('.node-detail-panel') || target.closest('.context-menu')) {
          return;
        }
      }
      e.preventDefault();
      const direction = e.deltaY > 0 ? -1 : 1;
      setZoom(z => clampZoom(z + direction * zoomStep));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, [clampZoom]);

  // Context menu handler
  const handleContextMenu = useCallback((e: React.MouseEvent, node: GraphNode) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setContextMenu({
      node,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  // Close context menu on Escape key
  useEffect(() => {
    if (!contextMenu) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setContextMenu(null);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [contextMenu]);

  // Build layer mapping for nodes (both connected and standalone)
  const nodeLayerMap = useMemo(() => {
    const map = new Map<string, { layer: number; indexInLayer: number }>();
    stableConnectedLayout.forEach(ln => {
      map.set(ln.node.id, { layer: ln.layer, indexInLayer: ln.order });
    });
    // Standalone nodes get a special layer (-1)
    standaloneLayout.forEach(ln => {
      map.set(ln.node.id, { layer: -1, indexInLayer: ln.order });
    });
    return map;
  }, [stableConnectedLayout, standaloneLayout]);

  // Calculate node positions after render
  useEffect(() => {
    if (!canvasRef.current) return;

    const updatePositions = () => {
      const positions = new Map<string, NodePosition>();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const canvasRect = canvas.getBoundingClientRect();

      localNodes.forEach(node => {
        const element = canvas.querySelector(`[data-node-id="${node.id}"]`);
        if (element) {
          const rect = element.getBoundingClientRect();
          const layerInfo = nodeLayerMap.get(node.id) || { layer: 0, indexInLayer: 0 };
          positions.set(node.id, {
            x: (rect.left - canvasRect.left + rect.width / 2) / zoom,
            y: (rect.top - canvasRect.top + rect.height / 2) / zoom,
            width: rect.width / zoom,
            height: rect.height / zoom,
            layer: layerInfo.layer,
            indexInLayer: layerInfo.indexInLayer,
          });
        }
      });

      setNodePositions(positions);
    };

    const timer = setTimeout(updatePositions, 150);
    return () => clearTimeout(timer);
  }, [localNodes, nodeLayerMap, zoom]);

  // Edge routing with collision detection and smart waypoints
  const edgeRoutes = useMemo(() => {
    return routeEdges(connections, nodePositions);
  }, [nodePositions, connections]);

  if (localNodes.length === 0) {
    return (
      <div className="graph-view" ref={containerRef}>
        <div className="graph-empty">
          <p>No services running</p>
          <span>Start a dev server to see the connection graph</span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="graph-view"
      ref={containerRef}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      style={{ cursor: selectedNode || contextMenu ? 'default' : isDragging ? 'grabbing' : 'grab' }}
    >
      {/* Legend - only show in service map view, not container view */}
      {!isContainerView && (
        <div className="graph-legend">
          <div className="graph-legend-title">Service Types</div>
          {Array.from(new Set(localNodes.map(n => n.type)))
            .filter(type => SERVICE_COLORS[type])
            .map(type => (
              <div key={type} className="graph-legend-item">
                <div
                  className="graph-legend-dot"
                  style={{ backgroundColor: SERVICE_COLORS[type].color }}
                />
                <span>{SERVICE_COLORS[type].label}</span>
              </div>
            ))}
        </div>
      )}

      {/* Zoom Controls */}
      <div className="graph-controls">
        <button className="graph-control-btn" onClick={handleZoomIn} title="Zoom In">+</button>
        <button className="graph-control-btn" onClick={handleZoomReset} title="Reset">⟲</button>
        <button className="graph-control-btn" onClick={handleZoomOut} title="Zoom Out">−</button>
        <span className="graph-zoom-level">{Math.round(zoom * 100)}%</span>
      </div>

      {/* Data Freshness */}
      {dataStatus && (
        <div
          className={`graph-freshness ${onFreshnessClick ? 'graph-freshness-clickable' : ''}`}
          onClick={onFreshnessClick}
          title={onFreshnessClick ? 'Click to view container logs' : undefined}
        >
          <span className="graph-freshness-title">Last updated</span>
          <span className="graph-freshness-value">{lastUpdated} ago</span>
          <span className="graph-freshness-meta">
            ps {formatAge(dataStatus.processesAgeMs)} · lsof {formatAge(dataStatus.portsAgeMs)} · tcp {formatAge(dataStatus.connectionsAgeMs)}
          </span>
          {onFreshnessClick && (
            <span className="graph-freshness-link">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
              </svg>
              View logs
            </span>
          )}
        </div>
      )}

      {/* Zoomable/Pannable Canvas */}
      <div
        className="graph-canvas"
        ref={canvasRef}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
        }}
      >
        {/* Connection lines SVG - only show in graph view, not container view */}
        {!isContainerView && (
          <svg className="graph-connections">
            <defs>
              <marker
                id="arrowhead"
                markerWidth="8"
                markerHeight="8"
                refX="8"
                refY="4"
                orient="auto"
                markerUnits="userSpaceOnUse"
                viewBox="0 0 8 8"
              >
                <path
                  d="M 0 0 L 8 4 L 0 8 Z"
                  fill="currentColor"
                />
              </marker>
            </defs>

            {edgeRoutes.map((route, i) => {
              const opacity = Math.max(0.2, Math.min(1, 0.25 + route.confidence * 0.75));
              return (
              <path
                key={`${route.from}-${route.to}-${i}`}
                d={route.path}
                stroke="currentColor"
                strokeWidth="1.6"
                fill="none"
                markerEnd="url(#arrowhead)"
                className="graph-edge"
                style={{ opacity }}
              />
            )})}
          </svg>
        )}

        {/* Container View: Project containers with type groups inside */}
        {isContainerView ? (
          <div className="container-projects-view">
            {containerProjects.map((project, projectIdx) => (
              <ProjectContainer
                key={`project-${project.projectName}`}
                project={project}
                onNodeClick={handleNodeClick}
                onContextMenu={handleContextMenu}
                animationDelay={projectIdx * 150}
              />
            ))}
          </div>
        ) : (
          /* Regular Service Map: Layered nodes based on topology */
          <div className="graph-layers">
            {sortedLayers.map((layer, layerIdx) => {
              const groups = layerGroups.get(layer) || [];
              const allNodes = groups.flatMap(g => g.nodes);
              if (allNodes.length === 0) return null;

              // Calculate base animation index for this layer
              let nodeIndex = layerIdx * 2;

              return (
                <div key={`layer-${layer}`} className="graph-layer" style={{ animationDelay: `${layerIdx * 80}ms` }}>
                  <div className="graph-layer-label">{getLayerLabel(layer, allNodes)}</div>
                  <div className="graph-layer-nodes">
                    {groups.map((group, index) => {
                      const currentIndex = nodeIndex;
                      nodeIndex += group.nodes.length;
                      return (
                        <NodeGroupContainer
                          key={`layer${layer}-${group.groupName}-${index}`}
                          group={group}
                          onNodeClick={handleNodeClick}
                          onContextMenu={handleContextMenu}
                          baseIndex={currentIndex}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Standalone Services Section */}
            {standaloneGroups.length > 0 && (
              <div className="graph-layer graph-layer-standalone" style={{ animationDelay: `${sortedLayers.length * 80 + 50}ms` }}>
                <div className="graph-layer-label">STANDALONE SERVICES</div>
                <div className="graph-layer-nodes">
                  {standaloneGroups.map((group, index) => {
                    const baseIndex = sortedLayers.length * 2 + index * 2;
                    return (
                      <NodeGroupContainer
                        key={`standalone-${group.groupName}-${index}`}
                        group={group}
                        onNodeClick={handleNodeClick}
                        onContextMenu={handleContextMenu}
                        baseIndex={baseIndex}
                      />
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          node={contextMenu.node}
          x={contextMenu.x}
          y={contextMenu.y}
          width={contextMenu.width}
          height={contextMenu.height}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Node Detail Panel */}
      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          edges={localEdges}
          allNodes={localNodes}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
