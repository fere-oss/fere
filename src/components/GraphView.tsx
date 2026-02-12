import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  Position,
  type ReactFlowInstance,
  type Viewport,
} from "reactflow";
import "reactflow/dist/style.css";
import type { GraphEdge, GraphNode } from "../types/electron";
import { ContextMenu } from "./graph/ContextMenu";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { flowNodeTypes, HoverContext } from "./graph/flowNodes";
import { flowEdgeTypes, type ArrowEdgeData } from "./graph/ArrowEdge";
import { FLOW_LAYOUT, buildFlowLayout } from "./graph/flowLayout";
import type { GraphViewProps } from "./graph/types";
import { useExternalApis } from "./graph/useExternalApis";
import { useGraphLayoutData } from "./graph/useGraphLayoutData";
import { useNodeMeasurements } from "./graph/useNodeMeasurements";

const NODE_TYPES = flowNodeTypes;
const EDGE_TYPES = flowEdgeTypes;

function FreshnessBadge({
  dataStatus,
  onFreshnessClick,
  formatAge,
}: {
  dataStatus: GraphViewProps["dataStatus"];
  onFreshnessClick?: GraphViewProps["onFreshnessClick"];
  formatAge: (ageMs?: number | null) => string;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!dataStatus) return null;

  const lastUpdated = dataStatus.collectedAt
    ? formatAge(now - dataStatus.collectedAt)
    : "—";

  return (
    <div
      className={`graph-freshness ${onFreshnessClick ? "graph-freshness-clickable" : ""}`}
      onClick={onFreshnessClick}
      title={onFreshnessClick ? "Click to view container logs" : undefined}
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
  );
}

export function GraphView({
  nodes,
  edges,
  isContainerView = false,
  onDatabaseClick,
  onFreshnessClick,
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

  // Viewport tracking for node culling (virtualization)
  const viewportRef = useRef<Viewport>({ x: 0, y: 0, zoom: 0.6 });
  const [viewportVersion, setViewportVersion] = useState(0);
  const containerSizeRef = useRef({ width: 1200, height: 800 });
  const didInitialAnimationRef = useRef(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
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
  const bumpExternalApiVersion = useCallback(() => undefined, []);
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

  const flowLayout = useMemo(
    () => {
      // Keeps memo recalculation tied to measurement updates.
      const measurementVersion = layoutVersion;
      void measurementVersion;
      return buildFlowLayout({
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
      });
    },
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
      nodeHeightsRef,
    ],
  );

  const hoverState = useMemo(
    () => ({ hoveredNodeId, connectedNodeIds }),
    [hoveredNodeId, connectedNodeIds],
  );

  // Node virtualization — hide nodes far outside the viewport.
  // Uses a large world-space buffer (2000px) so nodes don't pop in during
  // normal panning. Only culls truly distant nodes in large graphs.
  const culledFlowNodes = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _v = viewportVersion; // subscribe to debounced viewport changes
    const { x: panX, y: panY, zoom: z } = viewportRef.current;
    const { width: cw, height: ch } = containerSizeRef.current;
    const buffer = 2000;
    const worldXMin = -panX / z - buffer;
    const worldYMin = -panY / z - buffer;
    const worldXMax = (cw - panX) / z + buffer;
    const worldYMax = (ch - panY) / z + buffer;

    return flowLayout.nodes.map((node) => {
      if (node.type !== "service") return node; // always show labels/boxes
      const { x, y } = node.position;
      const w = FLOW_LAYOUT.NODE_WIDTH;
      const h =
        nodeHeightsRef.current.get(node.id) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
      const visible =
        x + w >= worldXMin &&
        x <= worldXMax &&
        y + h >= worldYMin &&
        y <= worldYMax;
      return visible ? node : { ...node, hidden: true };
    });
  }, [flowLayout.nodes, viewportVersion, nodeHeightsRef]);

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

    // Deduplicate edges
    const seen = new Set<string>();
    const dedupedEdges = layoutEdges.filter((edge) => {
      if (edge.source !== hoveredNodeId) return false;
      const key = `${edge.source}->${edge.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Edge bundling — group edges whose targets share the same layout group.
    // When 3+ edges target the same group, bundle into a single edge to reduce clutter.
    const BUNDLE_THRESHOLD = 3;
    const layoutLookup = new Map(
      stableConnectedLayout.map((ln) => [ln.node.id, ln]),
    );
    const edgesByGroup = new Map<string, GraphEdge[]>();
    dedupedEdges.forEach((edge) => {
      const tgt = layoutLookup.get(edge.target);
      const groupKey = tgt
        ? `layer-${tgt.layer}-${tgt.groupId}`
        : edge.target;
      if (!edgesByGroup.has(groupKey)) edgesByGroup.set(groupKey, []);
      edgesByGroup.get(groupKey)!.push(edge);
    });

    const bundled: Array<GraphEdge & { _bundleCount?: number }> = [];
    edgesByGroup.forEach((groupEdges) => {
      if (groupEdges.length < BUNDLE_THRESHOLD) {
        bundled.push(...groupEdges);
      } else {
        // Pick the middle target as the bundle representative
        const rep = groupEdges[Math.floor(groupEdges.length / 2)];
        bundled.push({ ...rep, id: `bundle-${rep.id}`, _bundleCount: groupEdges.length });
      }
    });

    return bundled.map((edge) => {
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
          bundleCount: (edge as typeof edge & { _bundleCount?: number })._bundleCount,
        };
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: edgeType,
          data,
        };
      });
  }, [layoutEdges, hoveredNodeId, flowLayout.nodes, nodeHeightsRef, stableConnectedLayout]);

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

  // Update viewport ref continuously for accurate culling math.
  const handleMove = useCallback((_event: unknown, vp: Viewport) => {
    viewportRef.current = vp;
  }, []);
  // Recompute culling only after interaction ends to avoid zoom/pan stutter.
  const handleMoveEnd = useCallback((_event: unknown, vp: Viewport) => {
    viewportRef.current = vp;
    setViewportVersion((v) => v + 1);
  }, []);

  // Measure container for viewport culling bounds
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      containerSizeRef.current = {
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      };
      setViewportVersion((v) => v + 1);
    });
    ro.observe(el);
    return () => ro.disconnect();
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
      <FreshnessBadge
        dataStatus={dataStatus}
        onFreshnessClick={onFreshnessClick}
        formatAge={formatAge}
      />

      <div className="graph-flow">
        <HoverContext.Provider value={hoverState}>
          <ReactFlow
            nodes={culledFlowNodes}
            edges={flowEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={defaultEdgeOptions}
            onlyRenderVisibleElements
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
            onMove={handleMove}
            onMoveEnd={handleMoveEnd}
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
