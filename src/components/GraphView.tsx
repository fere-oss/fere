import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  Position,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type { GraphEdge, GraphNode } from "../types/electron";
import { ContextMenu } from "./graph/ContextMenu";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { flowNodeTypes, HoverContext } from "./graph/flowNodes";
import { flowEdgeTypes, type ArrowEdgeData } from "./graph/ArrowEdge";
import { FLOW_LAYOUT, buildFlowLayout } from "./graph/flowLayout";
import type { GraphViewProps, NodePosition } from "./graph/types";
import { useExternalApis } from "./graph/useExternalApis";
import { useGraphLayoutData } from "./graph/useGraphLayoutData";
import { useNodeMeasurements } from "./graph/useNodeMeasurements";

const NODE_TYPES = flowNodeTypes;
const EDGE_TYPES = flowEdgeTypes;

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
  const [externalApiVersion, setExternalApiVersion] = useState(0);
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
  const bumpExternalApiVersion = useCallback(() => {
    setExternalApiVersion((version) => version + 1);
  }, []);
  const externalApisLoaded = useExternalApis(projectPathsKey, bumpExternalApiVersion);
  const { nodeHeightsRef, layoutVersion, handleNodeMeasure } =
    useNodeMeasurements(nodesKey, layoutNodes.length, externalApisLoaded);
  const connectedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const connected = new Set<string>();
    connected.add(hoveredNodeId);
    layoutEdges.forEach((edge) => {
      if (edge.source === hoveredNodeId) connected.add(edge.target);
    });
    return connected;
  }, [hoveredNodeId, layoutEdges]);

  const hoverValue = useMemo(
    () => ({ hoveredNodeId, connectedNodeIds }),
    [hoveredNodeId, connectedNodeIds],
  );

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
      externalApiVersion,
    ],
  );

  const hoverState = useMemo(
    () => ({ hoveredNodeId, connectedNodeIds }),
    [hoveredNodeId, connectedNodeIds],
  );

  const flowEdges = useMemo(() => {
    if (!hoveredNodeId) return [];
    const W = FLOW_LAYOUT.NODE_WIDTH;
    const posMap = new Map<string, { x: number; y: number }>();
    const heightMap = new Map<string, number>();
    const serviceCenters: Array<{ id: string; x: number; y: number }> = [];
    for (const node of flowLayout.nodes) {
      posMap.set(node.id, node.position);
      if (node.type === "service") {
        const h = nodeHeightsRef.current.get(node.id) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
        heightMap.set(node.id, h);
        serviceCenters.push({
          id: node.id,
          x: node.position.x + W / 2,
          y: node.position.y,
        });
      }
    }

    function endpoint(
      pos: { x: number; y: number },
      h: number,
      side: "top" | "bottom" | "left" | "right",
    ): { x: number; y: number; pos: Position } {
      switch (side) {
        case "top":
          return { x: pos.x + W / 2, y: pos.y, pos: Position.Top };
        case "bottom":
          return { x: pos.x + W / 2, y: pos.y + h, pos: Position.Bottom };
        case "left":
          return { x: pos.x, y: pos.y + h / 2, pos: Position.Left };
        case "right":
          return { x: pos.x + W, y: pos.y + h / 2, pos: Position.Right };
      }
    }

    const seen = new Set<string>();
    return layoutEdges
      .filter((edge) => {
        if (edge.source !== hoveredNodeId) return false;
        const key = `${edge.source}->${edge.target}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((edge) => {
        const srcPos = posMap.get(edge.source);
        const tgtPos = posMap.get(edge.target);
        const srcH = heightMap.get(edge.source) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
        const tgtH = heightMap.get(edge.target) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
        let srcSide: "top" | "bottom" | "left" | "right" = "bottom";
        let tgtSide: "top" | "bottom" | "left" | "right" = "top";
        let edgeType: "arrowBezier" | "arrowStep" = "arrowBezier";
        if (srcPos && tgtPos) {
          const dx = tgtPos.x - srcPos.x;
          const dy = tgtPos.y - srcPos.y;
          const sameLayer = Math.abs(dy) < 80;
          if (sameLayer) {
            const srcCenterX = srcPos.x + W / 2;
            const tgtCenterX = tgtPos.x + W / 2;
            const minX = Math.min(srcCenterX, tgtCenterX);
            const maxX = Math.max(srcCenterX, tgtCenterX);
            const hasIntermediate = serviceCenters.some((node) => {
              if (node.id === edge.source || node.id === edge.target) return false;
              if (Math.abs(node.y - srcPos.y) > 60) return false;
              return node.x > minX + 8 && node.x < maxX - 8;
            });

            if (hasIntermediate) {
              edgeType = "arrowStep";
              if (dx > 0) {
                srcSide = "top";
                tgtSide = "top";
              } else {
                srcSide = "bottom";
                tgtSide = "bottom";
              }
            } else if (dx > 0) {
              srcSide = "right";
              tgtSide = "left";
            } else {
              srcSide = "left";
              tgtSide = "right";
            }
          } else if (dy > 0) {
            srcSide = "bottom";
            tgtSide = "top";
          } else {
            srcSide = "top";
            tgtSide = "bottom";
          }
        }
        const src = srcPos
          ? endpoint(srcPos, srcH, srcSide)
          : { x: 0, y: 0, pos: Position.Bottom };
        const tgt = tgtPos
          ? endpoint(tgtPos, tgtH, tgtSide)
          : { x: 0, y: 0, pos: Position.Top };
        const data: ArrowEdgeData = {
          sx: src.x,
          sy: src.y,
          tx: tgt.x,
          ty: tgt.y,
          sourcePos: src.pos,
          targetPos: tgt.pos,
        };
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edgeType,
          data,
        };
      });
  }, [layoutEdges, hoveredNodeId, flowLayout.nodes, nodeHeightsRef]);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "arrowBezier" as const,
    }),
    [],
  );

  useEffect(() => {
    if (!reactFlowInstance || didFitViewRef.current) return;
    if (layoutNodes.length === 0) return;
    reactFlowInstance.fitView({ padding: 0.32, duration: 0 });
    didFitViewRef.current = true;
  }, [reactFlowInstance, layoutNodes.length]);

  const formatAge = useCallback((ageMs?: number | null) => {
    if (ageMs === null || ageMs === undefined) return "—";
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
    : "—";

  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingHover = useRef<string | null>(null);
  const handleNodeMouseEnter = useCallback(
    (_event: ReactMouseEvent, node: { id: string; type?: string }) => {
      clearTimeout(hoverTimer.current);
      if (node.type === "service") {
        pendingHover.current = node.id;
        hoverTimer.current = setTimeout(() => {
          setHoveredNodeId(pendingHover.current);
        }, 50);
      }
    },
    [],
  );

  const handleNodeMouseLeave = useCallback(() => {
    clearTimeout(hoverTimer.current);
    pendingHover.current = null;
    hoverTimer.current = setTimeout(() => setHoveredNodeId(null), 80);
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
            ps {formatAge(dataStatus.processesAgeMs)} · lsof{" "}
            {formatAge(dataStatus.portsAgeMs)} · tcp{" "}
            {formatAge(dataStatus.connectionsAgeMs)}
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

      <div className="graph-flow">
        <HoverContext.Provider value={hoverState}>
          <ReactFlow
            nodes={flowLayout.nodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            proOptions={{ hideAttribution: true }}
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
            <Controls position="top-right" showInteractive={false} />
          </ReactFlow>
        </HoverContext.Provider>
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
          edges={layoutEdges}
          allNodes={layoutNodes}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
