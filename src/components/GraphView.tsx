import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  ControlButton,
  Position,
  type ReactFlowInstance,
} from "reactflow";
import "reactflow/dist/style.css";
import type { GraphEdge, GraphNode, TraceHop } from "../types/electron";
import { ContextMenu } from "./graph/ContextMenu";
import { NodeDetailPanel } from "./graph/NodeDetailPanel";
import { flowNodeTypes, HoverContext } from "./graph/flowNodes";
import { flowEdgeTypes, type ArrowEdgeData } from "./graph/ArrowEdge";
import { FLOW_LAYOUT, buildFlowLayout } from "./graph/flowLayout";
import type { GraphViewProps } from "./graph/types";
import { useExternalApis } from "./graph/useExternalApis";
import { useGraphLayoutData } from "./graph/useGraphLayoutData";
import { useNodeMeasurements } from "./graph/useNodeMeasurements";
import { useTraceState, useTraceDispatch } from "./graph/traceContext";
import { TraceOverlay } from "./graph/TraceOverlay";
import { TraceWaterfall } from "./graph/TraceWaterfall";

const NODE_TYPES = flowNodeTypes;
const EDGE_TYPES = flowEdgeTypes;

const ActivePorts = React.memo(function ActivePorts({
  nodes,
  reactFlowInstance,
}: {
  nodes: GraphNode[];
  reactFlowInstance: ReactFlowInstance | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const portEntries = useMemo(() => {
    const entries: {
      port: number;
      host: string;
      nodeId: string;
      nodeName: string;
    }[] = [];
    for (const node of nodes) {
      const mainPort = node.ports[0];
      if (mainPort) {
        entries.push({
          port: mainPort.port,
          host: mainPort.host || "localhost",
          nodeId: node.id,
          nodeName: node.name,
        });
      }
    }
    return entries.sort((a, b) => a.port - b.port);
  }, [nodes]);

  const handleClick = useCallback(
    (nodeId: string) => {
      if (!reactFlowInstance) return;
      const rfNode = reactFlowInstance.getNode(nodeId);
      if (rfNode) {
        reactFlowInstance.setCenter(
          rfNode.position.x + FLOW_LAYOUT.NODE_WIDTH / 2,
          rfNode.position.y + 95,
          { zoom: 1.2, duration: 400 },
        );
      }
    },
    [reactFlowInstance],
  );

  if (portEntries.length === 0) return null;

  return (
    <div
      className={`graph-ports${expanded ? " graph-ports-expanded" : ""}`}
      onClick={() => {
        if (!expanded) setExpanded(true);
      }}
    >
      {/* Collapsed: pill content */}
      <div className="graph-ports-pill-content">
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
        </svg>
        <span>
          {portEntries.length} {portEntries.length === 1 ? "port" : "ports"}
        </span>
      </div>

      {/* Expanded: header + list */}
      <button
        className="graph-ports-header"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(false);
        }}
      >
        <span className="graph-ports-title">Active Ports</span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M4 4L12 12M12 4L4 12" />
        </svg>
      </button>
      <div className="graph-ports-list">
        {portEntries.map((entry) => (
          <button
            key={entry.port}
            className="graph-ports-item"
            onClick={(e) => {
              e.stopPropagation();
              handleClick(entry.nodeId);
            }}
          >
            <span className="graph-ports-number">:{entry.port}</span>
            <span className="graph-ports-name">{entry.nodeName}</span>
          </button>
        ))}
      </div>
    </div>
  );
});

export function GraphView({
  nodes,
  edges,
  isContainerView = false,
  onDatabaseClick,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [reactFlowInstance, setReactFlowInstance] =
    useState<ReactFlowInstance | null>(null);
  const animatedNodeIdsRef = useRef<Set<string>>(new Set());
  const [animateNodeIds, setAnimateNodeIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [contextMenu, setContextMenu] = useState<{
    node: GraphNode;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const orderCacheRef = useRef<Map<number, string[]>>(new Map());
  const groupOrderCacheRef = useRef<Map<number, string[]>>(new Map());
  const fitPendingRef = useRef(true);
  const wasVisibleRef = useRef(false);
  const autoRecoverKeyRef = useRef("");
  const [viewportReady, setViewportReady] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const contextMenuOpenRef = useRef(false);
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
      contextMenuOpenRef.current = true;
      setHoveredNodeId(node.id);
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
  const nodeIds = useMemo(
    () => layoutNodes.map((node) => node.id),
    [layoutNodes],
  );
  useExternalApis(projectPathsKey);
  const measurementMinHeight = isContainerView
    ? FLOW_LAYOUT.CONTAINER_NODE_MIN_HEIGHT
    : FLOW_LAYOUT.NODE_MIN_HEIGHT;
  const { nodeHeightsRef, layoutVersion, handleNodeMeasure } =
    useNodeMeasurements(nodeIds, measurementMinHeight);
  useEffect(() => {
    const nodeIds = nodesKey ? nodesKey.split(",") : [];
    if (nodeIds.length === 0) {
      setAnimateNodeIds(new Set());
      return;
    }

    const known = animatedNodeIdsRef.current;
    const currentIdSet = new Set(nodeIds);
    Array.from(known).forEach((id) => {
      if (!currentIdSet.has(id)) known.delete(id);
    });
    const fresh = nodeIds.filter((id) => !known.has(id));
    if (fresh.length === 0) return;

    const idsToAnimate = known.size === 0 ? nodeIds : fresh;
    setAnimateNodeIds(new Set(idsToAnimate));

    const timer = setTimeout(() => {
      idsToAnimate.forEach((id) => known.add(id));
      setAnimateNodeIds((current) => {
        const next = new Set(current);
        idsToAnimate.forEach((id) => next.delete(id));
        return next;
      });
    }, 700);

    return () => clearTimeout(timer);
  }, [nodesKey]);
  const flowLayout = useMemo(() => {
    // Keeps memo recalculation tied to measurement and external API updates.
    void layoutVersion;
    return buildFlowLayout({
      layoutNodes,
      sortedLayers,
      stableConnectedLayout,
      standaloneGroups,
      nodeHeights: nodeHeightsRef.current,
      onNodeClick: handleNodeClick,
      onNodeContextMenu: handleContextMenu,
      animateNodeIds,
      onMeasure: handleNodeMeasure,
      isContainerView,
    });
  }, [
    layoutNodes,
    sortedLayers,
    stableConnectedLayout,
    standaloneGroups,
    handleNodeClick,
    handleContextMenu,
    animateNodeIds,
    handleNodeMeasure,
    isContainerView,
    layoutVersion,
    nodeHeightsRef,
  ]);

  const hoverEdgeGeometry = useMemo(() => {
    const W = FLOW_LAYOUT.NODE_WIDTH;
    const posMap = new Map<string, { x: number; y: number }>();
    const heightMap = new Map<string, number>();
    const serviceCenters: Array<{ id: string; x: number; y: number }> = [];
    for (const node of flowLayout.nodes) {
      posMap.set(node.id, node.position);
      if (node.type === "service") {
        const h =
          nodeHeightsRef.current.get(node.id) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
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

    const layoutLookup = new Map(
      stableConnectedLayout.map((ln) => [ln.node.id, ln]),
    );
    const outgoingBySource = new Map<string, GraphEdge[]>();
    const incomingByTarget = new Map<string, GraphEdge[]>();
    layoutEdges.forEach((edge) => {
      const srcList = outgoingBySource.get(edge.source);
      if (srcList) srcList.push(edge);
      else outgoingBySource.set(edge.source, [edge]);

      const tgtList = incomingByTarget.get(edge.target);
      if (tgtList) tgtList.push(edge);
      else incomingByTarget.set(edge.target, [edge]);
    });
    return {
      posMap,
      heightMap,
      serviceCenters,
      layoutLookup,
      outgoingBySource,
      incomingByTarget,
      endpoint,
      width: W,
    };
  }, [
    layoutEdges,
    flowLayout.nodes,
    nodeHeightsRef,
    stableConnectedLayout,
  ]);

  const connectedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const connected = new Set<string>();
    connected.add(hoveredNodeId);
    const outgoing = hoverEdgeGeometry.outgoingBySource.get(hoveredNodeId);
    if (outgoing) outgoing.forEach((edge) => connected.add(edge.target));
    const incoming = hoverEdgeGeometry.incomingByTarget.get(hoveredNodeId);
    if (incoming) incoming.forEach((edge) => connected.add(edge.source));
    return connected;
  }, [hoveredNodeId, hoverEdgeGeometry]);

  const hoverState = useMemo(
    () => ({ hoveredNodeId, connectedNodeIds }),
    [hoveredNodeId, connectedNodeIds],
  );

  const flowEdges = useMemo(() => {
    if (!hoveredNodeId) return [];
    const {
      posMap,
      heightMap,
      serviceCenters,
      layoutLookup,
      outgoingBySource,
      incomingByTarget,
      endpoint,
      width,
    } = hoverEdgeGeometry;
    // Collect both outgoing and incoming edges for the hovered node.
    const outEdges = outgoingBySource.get(hoveredNodeId) ?? [];
    const inEdges = incomingByTarget.get(hoveredNodeId) ?? [];
    if (outEdges.length === 0 && inEdges.length === 0) return [];

    // Deduplicate by ordered pair so A→B and B→A collapse to one edge.
    const seen = new Set<string>();
    const dedupedEdges = [...outEdges, ...inEdges].filter((edge) => {
      const a = edge.source < edge.target ? edge.source : edge.target;
      const b = edge.source < edge.target ? edge.target : edge.source;
      const key = `${a}<->${b}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Grouped bundling for dense fan-out / fan-in targets.
    const BUNDLE_THRESHOLD = 3;
    const edgesByGroup = new Map<string, GraphEdge[]>();
    dedupedEdges.forEach((edge) => {
      // For each edge, the "other" node is the one that isn't the hovered node.
      const otherId = edge.source === hoveredNodeId ? edge.target : edge.source;
      const other = layoutLookup.get(otherId);
      const groupKey = other ? `layer-${other.layer}-${other.groupId}` : otherId;
      const list = edgesByGroup.get(groupKey);
      if (list) list.push(edge);
      else edgesByGroup.set(groupKey, [edge]);
    });

    const bundled: Array<GraphEdge & { _bundleCount?: number }> = [];
    edgesByGroup.forEach((groupEdges) => {
      if (groupEdges.length < BUNDLE_THRESHOLD) {
        bundled.push(...groupEdges);
      } else {
        const rep = groupEdges[Math.floor(groupEdges.length / 2)];
        bundled.push({
          ...rep,
          id: `bundle-${rep.id}`,
          _bundleCount: groupEdges.length,
        });
      }
    });

    return bundled.flatMap((edge) => {
      const srcPos = posMap.get(edge.source);
      const tgtPos = posMap.get(edge.target);
      // Skip edges whose source or target has no position in the flow layout
      // to avoid phantom lines rendered at (0,0).
      if (!srcPos || !tgtPos) return [];
      const srcH = heightMap.get(edge.source) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
      const tgtH = heightMap.get(edge.target) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
      let srcSide: "top" | "bottom" | "left" | "right" = "bottom";
      let tgtSide: "top" | "bottom" | "left" | "right" = "top";
      let edgeType: "arrowBezier" | "arrowStep" = "arrowBezier";
      const dx = tgtPos.x - srcPos.x;
      const dy = tgtPos.y - srcPos.y;
      const sameLayer = Math.abs(dy) < 80;
      if (sameLayer) {
        const srcCenterX = srcPos.x + width / 2;
        const tgtCenterX = tgtPos.x + width / 2;
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
      const src = endpoint(srcPos, srcH, srcSide);
      const tgt = endpoint(tgtPos, tgtH, tgtSide);
      const data: ArrowEdgeData = {
        sx: src.x,
        sy: src.y,
        tx: tgt.x,
        ty: tgt.y,
        sourcePos: src.pos,
        targetPos: tgt.pos,
        bundleCount: (edge as typeof edge & { _bundleCount?: number })
          ._bundleCount,
      };
      return [{
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: edgeType,
        data,
      }];
    });
  }, [hoveredNodeId, hoverEdgeGeometry]);

  // Trace state
  const traceState = useTraceState();
  const traceDispatch = useTraceDispatch();

  // Build trace edges when trace is active
  const traceEdges = useMemo(() => {
    if (traceState.phase === "idle" || !traceState.result) return [];

    return traceState.result.hops.flatMap((hop, i) => {
      // Find graph edges matching this hop
      const matchingLayoutEdges = layoutEdges.filter(
        (e) =>
          (e.source === hop.sourceNodeId && e.target === hop.targetNodeId) ||
          (e.target === hop.sourceNodeId && e.source === hop.targetNodeId)
      );

      if (matchingLayoutEdges.length === 0) return [];

      return matchingLayoutEdges.flatMap((edge) => {
        const srcPos = hoverEdgeGeometry.posMap.get(edge.source);
        const tgtPos = hoverEdgeGeometry.posMap.get(edge.target);
        if (!srcPos || !tgtPos) return [];
        const srcH = hoverEdgeGeometry.heightMap.get(edge.source) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
        const tgtH = hoverEdgeGeometry.heightMap.get(edge.target) ?? FLOW_LAYOUT.NODE_MIN_HEIGHT;
        const dy = tgtPos.y - srcPos.y;
        const dx = tgtPos.x - srcPos.x;
        const sameLayer = Math.abs(dy) < 80;
        let srcSide: "top" | "bottom" | "left" | "right" = dy > 0 ? "bottom" : "top";
        let tgtSide: "top" | "bottom" | "left" | "right" = dy > 0 ? "top" : "bottom";
        let edgeType: "traceBezier" | "traceStep" = "traceBezier";
        if (sameLayer) {
          if (dx > 0) { srcSide = "right"; tgtSide = "left"; }
          else { srcSide = "left"; tgtSide = "right"; }
          edgeType = "traceStep";
        }
        const src = hoverEdgeGeometry.endpoint(srcPos, srcH, srcSide);
        const tgt = hoverEdgeGeometry.endpoint(tgtPos, tgtH, tgtSide);

        const isActiveHop = traceState.phase === "animating" && i === traceState.activeHopIndex;
        const isDrawn = traceState.phase === "complete" || (traceState.phase === "animating" && i < traceState.activeHopIndex);

        return [{
          id: `trace-${edge.id}`,
          source: edge.source,
          target: edge.target,
          type: edgeType,
          data: {
            sx: src.x,
            sy: src.y,
            tx: tgt.x,
            ty: tgt.y,
            sourcePos: src.pos,
            targetPos: tgt.pos,
            latency: hop.latency,
            isActiveHop,
            isDrawn,
            inferred: hop.inferred,
          },
        }];
      });
    });
  }, [traceState, layoutEdges, hoverEdgeGeometry]);

  // Combine hover edges and trace edges
  const combinedEdges = useMemo(() => {
    if (traceState.phase === "idle") return flowEdges;
    return [...flowEdges, ...traceEdges];
  }, [flowEdges, traceEdges, traceState.phase]);

  // Advance trace animation
  useEffect(() => {
    if (traceState.phase !== "animating" || !traceState.result) return;
    const hop = traceState.result.hops[traceState.activeHopIndex];
    if (!hop) return;

    const duration = Math.max(800, Math.min(2500, hop.latency * 2));
    const timer = setTimeout(() => {
      traceDispatch({ type: "advance-hop" });
    }, duration);

    return () => clearTimeout(timer);
  }, [traceState.phase, traceState.activeHopIndex, traceState.result, traceDispatch]);

  // Handle waterfall interactions
  const handleWaterfallHoverHop = useCallback((hop: TraceHop | null) => {
    if (!hop) {
      setHoveredNodeId(null);
      return;
    }
    setHoveredNodeId(hop.targetNodeId);
  }, []);

  const handleWaterfallClickHop = useCallback((hop: TraceHop) => {
    const node = layoutNodes.find((n) => n.id === hop.targetNodeId);
    if (node) {
      setSelectedNode(node);
      if (reactFlowInstance) {
        const rfNode = reactFlowInstance.getNode(hop.targetNodeId);
        if (rfNode) {
          reactFlowInstance.setCenter(
            rfNode.position.x + FLOW_LAYOUT.NODE_WIDTH / 2,
            rfNode.position.y + 95,
            { zoom: 1.2, duration: 400 },
          );
        }
      }
    }
  }, [layoutNodes, reactFlowInstance]);

  const handleTraceDismiss = useCallback(() => {
    traceDispatch({ type: "dismiss" });
  }, [traceDispatch]);

  // Handle trace from context menu (fires GET to first route)
  const handleContextMenuTrace = useCallback((node: GraphNode) => {
    if (!node.routes?.length || !node.ports[0]) return;
    const route = node.routes[0];
    const port = node.ports[0].port;
    const url = `http://localhost:${port}${route.path}`;

    traceDispatch({ type: "start-capture" });

    window.electronAPI.executeTracedRequest({
      method: route.method || "GET",
      url,
      graphNodes: layoutNodes,
      graphEdges: layoutEdges,
    }).then((result) => {
      if (result.success && result.trace) {
        traceDispatch({ type: "set-result", result: result.trace });
      } else {
        traceDispatch({ type: "dismiss" });
      }
    }).catch(() => {
      traceDispatch({ type: "dismiss" });
    });
  }, [layoutNodes, layoutEdges, traceDispatch]);

  const defaultEdgeOptions = useMemo(
    () => ({
      type: "arrowBezier" as const,
    }),
    [],
  );

  useEffect(() => {
    fitPendingRef.current = true;
    setViewportReady(false);
    autoRecoverKeyRef.current = "";
  }, [nodesKey]);

  useEffect(() => {
    if (!reactFlowInstance || !viewportReady) return;
    const container = containerRef.current;
    if (!container) return;

    // Guard against rare viewport glitches where the camera drifts away from
    // every service node after topology/layout updates.
    const serviceNodes = flowLayout.nodes.filter((node) => node.type === "service");
    if (serviceNodes.length === 0) return;

    const recoveryKey = `${nodesKey}:${layoutVersion}`;
    if (autoRecoverKeyRef.current === recoveryKey) return;

    const viewport = reactFlowInstance.getViewport();
    const zoom = Math.max(0.0001, viewport.zoom || 1);
    const worldXMin = -viewport.x / zoom;
    const worldYMin = -viewport.y / zoom;
    const worldXMax = (container.clientWidth - viewport.x) / zoom;
    const worldYMax = (container.clientHeight - viewport.y) / zoom;

    const hasVisibleServiceNode = serviceNodes.some((node) => {
      const h = nodeHeightsRef.current.get(node.id) ?? measurementMinHeight;
      const x = node.position.x;
      const y = node.position.y;
      return (
        x + FLOW_LAYOUT.NODE_WIDTH >= worldXMin &&
        x <= worldXMax &&
        y + h >= worldYMin &&
        y <= worldYMax
      );
    });

    if (hasVisibleServiceNode) return;

    autoRecoverKeyRef.current = recoveryKey;
    reactFlowInstance.fitView({ padding: 0.32, duration: 220 });
  }, [
    reactFlowInstance,
    viewportReady,
    flowLayout.nodes,
    nodesKey,
    layoutVersion,
    measurementMinHeight,
    nodeHeightsRef,
  ]);

  useEffect(() => {
    if (!reactFlowInstance) return;
    const el = containerRef.current;
    if (!el) return;

    let cancelled = false;
    let rafA = 0;
    let rafB = 0;

    const fitNow = () => {
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(() => {
          if (cancelled) return;
          reactFlowInstance.fitView({ padding: 0.32, duration: 0 });
          fitPendingRef.current = false;
          setViewportReady(true);
        });
      });
    };

    const handleVisibilityCheck = () => {
      if (cancelled) return;
      const visible = el.offsetWidth > 0 && el.offsetHeight > 0;
      const becameVisible = visible && !wasVisibleRef.current;
      if (visible && (fitPendingRef.current || becameVisible)) {
        fitNow();
      } else if (visible && !fitPendingRef.current) {
        setViewportReady(true);
      }
      wasVisibleRef.current = visible;
    };

    handleVisibilityCheck();

    const observer = new ResizeObserver(() => {
      handleVisibilityCheck();
    });
    observer.observe(el);

    return () => {
      cancelled = true;
      observer.disconnect();
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
    };
  }, [reactFlowInstance, nodesKey]);

  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pendingHover = useRef<string | null>(null);
  const handleNodeMouseEnter = useCallback(
    (_event: ReactMouseEvent, node: { id: string; type?: string }) => {
      clearTimeout(hoverTimer.current);
      if (node.type === "service") {
        pendingHover.current = node.id;
        hoverTimer.current = setTimeout(() => {
          const nextHovered = pendingHover.current;
          setHoveredNodeId((current) =>
            current === nextHovered ? current : nextHovered,
          );
        }, 16);
      }
    },
    [],
  );

  const handleNodeMouseLeave = useCallback(() => {
    if (contextMenuOpenRef.current) return;
    clearTimeout(hoverTimer.current);
    pendingHover.current = null;
    hoverTimer.current = setTimeout(() => {
      setHoveredNodeId((current) => (current === null ? current : null));
    }, 40);
  }, []);

  const handlePaneClick = useCallback(() => {
    setSelectedNode(null);
    contextMenuOpenRef.current = false;
    setContextMenu(null);
  }, []);

  const handlePaneContextMenu = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    contextMenuOpenRef.current = false;
    setContextMenu(null);
  }, []);

  useEffect(() => {
    return () => {
      clearTimeout(hoverTimer.current);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      contextMenuOpenRef.current = false;
      setContextMenu(null);
      setSelectedNode(null);
      setHoveredNodeId(null);
    };
    const closeContextMenu = () => {
      contextMenuOpenRef.current = false;
      setContextMenu(null);
    };
    const closeOnWheel = () =>
      setContextMenu((current) => {
        if (current) contextMenuOpenRef.current = false;
        return current ? null : current;
      });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeContextMenu);
    window.addEventListener("blur", closeContextMenu);
    window.addEventListener("wheel", closeOnWheel, { passive: true });
    window.addEventListener("scroll", closeOnWheel, { passive: true, capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeContextMenu);
      window.removeEventListener("blur", closeContextMenu);
      window.removeEventListener("wheel", closeOnWheel);
      window.removeEventListener("scroll", closeOnWheel, true);
    };
  }, []);

  if (layoutNodes.length === 0) {
    const emptyTitle = isContainerView
      ? "No containers running"
      : "No services detected";
    const emptySubtitle = isContainerView
      ? "Start Docker containers to see them here"
      : "Try: npm run dev in your project";
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
    <div
      className={`graph-view${isContainerView ? " container-view" : ""}`}
      ref={containerRef}
    >
      <ActivePorts nodes={layoutNodes} reactFlowInstance={reactFlowInstance} />

      <div className={`graph-flow${viewportReady ? "" : " graph-flow-hidden"}`}>
        <HoverContext.Provider value={hoverState}>
          <ReactFlow
            nodes={flowLayout.nodes}
            edges={combinedEdges}
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
            onPaneClick={handlePaneClick}
            onPaneContextMenu={handlePaneContextMenu}
          >
            <Background color="rgba(0,0,0,0.04)" gap={24} />
            <Controls
              position="top-right"
              showZoom={false}
              showFitView={false}
              showInteractive={false}
            >
              <ControlButton
                onClick={() => reactFlowInstance?.zoomIn({ duration: 200 })}
                title="Zoom in"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </ControlButton>
              <ControlButton
                onClick={() => reactFlowInstance?.zoomOut({ duration: 200 })}
                title="Zoom out"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M3 8h10" />
                </svg>
              </ControlButton>
              <ControlButton
                onClick={() =>
                  reactFlowInstance?.fitView({ padding: 0.32, duration: 300 })
                }
                title="Recenter"
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3" />
                </svg>
              </ControlButton>
            </Controls>
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
          onClose={() => {
            contextMenuOpenRef.current = false;
            setContextMenu(null);
          }}
          onTraceRequest={handleContextMenuTrace}
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

      {/* Trace Overlay (origin pill) */}
      <TraceOverlay result={traceState.result} phase={traceState.phase} />

      {/* Trace Waterfall (bottom panel) */}
      {traceState.phase === "complete" && traceState.result && (
        <TraceWaterfall
          result={traceState.result}
          nodes={layoutNodes}
          onHoverHop={handleWaterfallHoverHop}
          onClickHop={handleWaterfallClickHop}
          onDismiss={handleTraceDismiss}
        />
      )}
    </div>
  );
}
