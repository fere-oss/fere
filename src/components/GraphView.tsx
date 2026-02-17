import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import ReactFlow, {
  Background,
  Controls,
  ControlButton,
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
import type { GraphViewProps } from "./graph/types";
import { useExternalApis } from "./graph/useExternalApis";
import { useGraphLayoutData } from "./graph/useGraphLayoutData";
import { useNodeMeasurements } from "./graph/useNodeMeasurements";

const NODE_TYPES = flowNodeTypes;
const EDGE_TYPES = flowEdgeTypes;

function ActivePorts({
  nodes,
  reactFlowInstance,
}: {
  nodes: GraphNode[];
  reactFlowInstance: ReactFlowInstance | null;
}) {
  const [expanded, setExpanded] = useState(false);

  const portEntries = useMemo(() => {
    const entries: { port: number; host: string; nodeId: string; nodeName: string }[] = [];
    for (const node of nodes) {
      const mainPort = node.ports[0];
      if (mainPort) {
        entries.push({ port: mainPort.port, host: mainPort.host || "localhost", nodeId: node.id, nodeName: node.name });
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
      onClick={() => { if (!expanded) setExpanded(true); }}
    >
      {/* Collapsed: pill content */}
      <div className="graph-ports-pill-content">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2" />
        </svg>
        <span>{portEntries.length} {portEntries.length === 1 ? "port" : "ports"}</span>
      </div>

      {/* Expanded: header + list */}
      <button
        className="graph-ports-header"
        onClick={(e) => { e.stopPropagation(); setExpanded(false); }}
      >
        <span className="graph-ports-title">Active Ports</span>
        <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M4 4L12 12M12 4L4 12" />
        </svg>
      </button>
      <div className="graph-ports-list">
        {portEntries.map((entry) => (
          <button
            key={entry.port}
            className="graph-ports-item"
            onClick={(e) => { e.stopPropagation(); handleClick(entry.nodeId); }}
          >
            <span className="graph-ports-number">:{entry.port}</span>
            <span className="graph-ports-name">{entry.nodeName}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

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
  const [viewportReady, setViewportReady] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
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
    () => layoutNodes.map((node) => node.id).sort().join(","),
    [layoutNodes],
  );
  const nodeIds = useMemo(() => layoutNodes.map((node) => node.id), [layoutNodes]);
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
    },
    [
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
    fitPendingRef.current = true;
    setViewportReady(false);
  }, [nodesKey]);

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

  useEffect(() => {
    return () => {
      clearTimeout(hoverTimer.current);
    };
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
    <div className={`graph-view${isContainerView ? " container-view" : ""}`} ref={containerRef}>
      <ActivePorts nodes={layoutNodes} reactFlowInstance={reactFlowInstance} />

      <div className={`graph-flow${viewportReady ? "" : " graph-flow-hidden"}`}>
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
            <Controls position="top-right" showZoom={false} showFitView={false} showInteractive={false}>
              <ControlButton onClick={() => reactFlowInstance?.zoomIn({ duration: 200 })} title="Zoom in">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M8 3v10M3 8h10" />
                </svg>
              </ControlButton>
              <ControlButton onClick={() => reactFlowInstance?.zoomOut({ duration: 200 })} title="Zoom out">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M3 8h10" />
                </svg>
              </ControlButton>
              <ControlButton onClick={() => reactFlowInstance?.fitView({ padding: 0.32, duration: 300 })} title="Recenter">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
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
