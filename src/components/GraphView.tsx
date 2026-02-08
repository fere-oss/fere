import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  MarkerType,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type { GraphNode } from "../types/electron";
import { SERVICE_COLORS } from "./graph/constants";
import { ContextMenu } from "./graph/ContextMenu";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { flowNodeTypes } from "./graph/flowNodes";
import { buildFlowLayout } from "./graph/flowLayout";
import type { GraphViewProps } from "./graph/types";
import { useExternalApis } from "./graph/useExternalApis";
import { useGraphLayoutData } from "./graph/useGraphLayoutData";
import { useNodeMeasurements } from "./graph/useNodeMeasurements";

export function GraphView({
  nodes,
  edges,
  isContainerView = false,
  onDatabaseClick,
  dataStatus,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);
  const [animateNodes, setAnimateNodes] = useState(true);
  const [contextMenu, setContextMenu] = useState<{
    node: GraphNode;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const orderCacheRef = useRef<Map<number, string[]>>(new Map());
  const groupOrderCacheRef = useRef<Map<number, string[]>>(new Map());
  const didFitViewRef = useRef(false);
  const didInitialAnimationRef = useRef(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [, setExternalApiVersion] = useState(0);
  useEffect(() => {
    if (didInitialAnimationRef.current) return;
    didInitialAnimationRef.current = true;
    const timer = setTimeout(() => setAnimateNodes(false), 1200);
    return () => clearTimeout(timer);
  }, []);
  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (
        isContainerView &&
        node.isDockerContainer &&
        node.type === "database" &&
        onDatabaseClick
      ) {
        onDatabaseClick(node);
      } else {
        setSelectedNode(node);
      }
    },
    [isContainerView, onDatabaseClick],
  );
  const handleContextMenu = useCallback(
    (event: ReactMouseEvent, node: GraphNode) => {
      event.preventDefault();
      event.stopPropagation();
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setContextMenu({
        node,
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
      });
    },
    [],
  );
  const {
    layoutNodes,
    layoutEdges,
    projectPathsKey,
    sortedLayers,
    stableConnectedLayout,
    standaloneGroups,
  } = useGraphLayoutData({
    nodes,
    edges,
    isContainerView,
    orderCache: orderCacheRef.current,
    groupOrderCache: groupOrderCacheRef.current,
  });
  const nodesKey = useMemo(
    () =>
      layoutNodes
        .map((node) => node.id)
        .sort()
        .join(","),
    [layoutNodes],
  );
  const { nodeHeightsRef, layoutVersion, handleNodeMeasure } =
    useNodeMeasurements(nodesKey, layoutNodes.length);
  useExternalApis(projectPathsKey, () =>
    setExternalApiVersion((version) => version + 1),
  );
  const connectedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const connected = new Set<string>();
    connected.add(hoveredNodeId);
    layoutEdges.forEach((edge) => {
      if (edge.source === hoveredNodeId) connected.add(edge.target);
      if (edge.target === hoveredNodeId) connected.add(edge.source);
    });
    return connected;
  }, [hoveredNodeId, layoutEdges]);

  const flowLayout = useMemo(
    () =>
      buildFlowLayout({
        layoutNodes,
        sortedLayers,
        stableConnectedLayout,
        standaloneGroups,
        nodeHeights: nodeHeightsRef.current,
        onNodeClick: handleNodeClick,
        onNodeContextMenu: handleContextMenu,
        animateNodes,
        onMeasure: handleNodeMeasure,
        isContainerView,
        hoveredNodeId,
        connectedNodeIds,
      }),
    [
      layoutNodes,
      sortedLayers,
      stableConnectedLayout,
      standaloneGroups,
      handleNodeClick,
      handleContextMenu,
      animateNodes,
      handleNodeMeasure,
      isContainerView,
      layoutVersion,
      hoveredNodeId,
      connectedNodeIds,
    ],
  );

  const flowEdges = useMemo(() => {
    if (!hoveredNodeId) return [];
    return layoutEdges
      .filter(
        (edge) =>
          edge.source === hoveredNodeId || edge.target === hoveredNodeId,
      )
      .map((edge) => {
        const confidence = edge.confidence ?? 0.6;
        const opacity = Math.max(0.25, Math.min(1, 0.35 + confidence * 0.65));
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "default" as const,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            width: 18,
            height: 18,
            color: "var(--graph-edge)",
          },
          className: "graph-edge",
          style: {
            opacity,
            stroke: "var(--graph-edge)",
            strokeWidth: 1.6,
            strokeLinecap: "round" as const,
            strokeLinejoin: "round" as const,
          },
        };
      });
  }, [layoutEdges, hoveredNodeId]);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "default" as const,
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 18,
        height: 18,
        color: "var(--graph-edge)",
      },
      style: {
        stroke: "var(--graph-edge)",
        strokeWidth: 1.7,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
      },
    }),
    [],
  );

  useEffect(() => {
    if (!reactFlowInstance || didFitViewRef.current) return;
    if (layoutNodes.length === 0) return;
    reactFlowInstance.fitView({ padding: 0.24, duration: 0 });
    didFitViewRef.current = true;
  }, [reactFlowInstance, layoutNodes.length]);

  const formatAge = useCallback((ageMs?: number | null) => {
    if (ageMs === null || ageMs === undefined) return "—";
    if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))}ms`;
    if (ageMs < 60000) return `${(ageMs / 1000).toFixed(1)}s`;
    return `${Math.round(ageMs / 60000)}m`;
  }, []);

  const lastUpdated = dataStatus?.collectedAt
    ? formatAge(Date.now() - dataStatus.collectedAt)
    : "—";

  const handleNodeMouseEnter = useCallback(
    (_event: ReactMouseEvent, node: { id: string; type?: string }) => {
      if (node.type === "service") {
        setHoveredNodeId(node.id);
      }
    },
    [],
  );

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredNodeId(null);
  }, []);

  if (layoutNodes.length === 0) {
    const emptyTitle = isContainerView
      ? "No containers running"
      : "No services running";
    const emptySubtitle = isContainerView
      ? "Start Docker containers to see them here"
      : "Start a dev server to see the connection graph";
    return (
      <div className="graph-view" ref={containerRef}>
        <div className="graph-empty">
          <p>{emptyTitle}</p>
          <span>{emptySubtitle}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-view" ref={containerRef}>
      <div className="graph-legend">
        <div className="graph-legend-title">Service Types</div>
        {Array.from(new Set(layoutNodes.map((n) => n.type)))
          .filter((type) => SERVICE_COLORS[type])
          .map((type) => (
            <div key={type} className="graph-legend-item">
              <div
                className="graph-legend-dot"
                style={{ backgroundColor: SERVICE_COLORS[type].color }}
              />
              <span>{SERVICE_COLORS[type].label}</span>
            </div>
          ))}
      </div>

      {dataStatus && (
        <div className="graph-freshness">
          <span className="graph-freshness-title">Last updated</span>
          <span className="graph-freshness-value">{lastUpdated} ago</span>
          <span className="graph-freshness-meta">
            ps {formatAge(dataStatus.processesAgeMs)} · lsof{" "}
            {formatAge(dataStatus.portsAgeMs)} · tcp{" "}
            {formatAge(dataStatus.connectionsAgeMs)}
          </span>
        </div>
      )}

      <div className="graph-flow">
        <ReactFlow
          nodes={flowLayout.nodes}
          edges={flowEdges}
          nodeTypes={flowNodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnScroll={false}
          zoomOnPinch
          zoomOnDoubleClick={false}
          panOnScroll
          minZoom={0.25}
          maxZoom={1.8}
          translateExtent={flowLayout.bounds}
          onInit={setReactFlowInstance}
          onNodeMouseEnter={handleNodeMouseEnter}
          onNodeMouseLeave={handleNodeMouseLeave}
          onPaneClick={() => {
            setSelectedNode(null);
            setContextMenu(null);
          }}
          onPaneContextMenu={(event) => {
            event.preventDefault();
            setContextMenu(null);
          }}
        >
          <Background color="rgba(0,0,0,0.04)" gap={24} />
          <Controls position="top-right" />
        </ReactFlow>
      </div>

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

      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          edges={layoutEdges}
          allNodes={layoutNodes}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
