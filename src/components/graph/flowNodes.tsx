import { memo, useEffect, useRef } from "react";
import type { GraphNode } from "../../types/electron";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Handle, Position } from "reactflow";
import { ServiceNode } from "./ServiceNodes";
import { useHoverState } from "./hoverContext";
import { useTraceState } from "./traceContext";

export type { HoverState } from "./hoverContext";
export { HoverContext } from "./hoverContext";

export type FlowServiceNodeData = {
  node: GraphNode;
  onNodeClick: (node: GraphNode) => void;
  onNodeContextMenu: (e: ReactMouseEvent, node: GraphNode) => void;
  animate: boolean;
  animationIndex: number;
  onMeasure: (id: string, height: number) => void;
  debugHighlightNodeIds?: Set<string>;
};

export function TierLabelNode({ data }: { data: { text: string } }) {
  return <div className="graph-tier-label">{data.text}</div>;
}

export function GroupLabelNode({
  data,
}: {
  data: { text: string; color: string };
}) {
  return (
    <div
      className="graph-group-label"
      style={{ ["--group-color" as string]: data.color }}
    >
      {data.text}
    </div>
  );
}

export function GroupBoxNode({
  data,
}: {
  data: { width: number; height: number; color: string };
}) {
  return (
    <div
      className="graph-group-box"
      style={{
        width: data.width,
        height: data.height,
        ["--group-color" as string]: data.color,
      }}
    />
  );
}

const FlowServiceNodeInner = memo(function FlowServiceNodeInner({
  data,
}: {
  data: FlowServiceNodeData;
}) {
  const nodeRef = useRef<HTMLDivElement | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const { hoveredNodeId, connectedNodeIds } = useHoverState();
  const {
    phase: tracePhase,
    traceNodeIds,
    entryNodeId,
    result: traceResult,
  } = useTraceState();

  useEffect(() => {
    if (!nodeRef.current) return;
    const element = nodeRef.current;
    let rafId = 0;
    const measure = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const d = dataRef.current;
        // Use unscaled layout height so zoom level doesn't change measured node size.
        const height =
          element.offsetHeight || element.getBoundingClientRect().height;
        d.onMeasure(d.node.id, height);
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, []);

  const traceActive = tracePhase !== "idle";
  const isInTrace = traceNodeIds.has(data.node.id);
  const isTraceEntry = traceActive && entryNodeId === data.node.id;

  // Trace takes priority over hover when a trace is active
  const isConnected = connectedNodeIds.has(data.node.id);
  const isDebugHighlighted =
    data.debugHighlightNodeIds?.has(data.node.id) ?? false;
  const dimmed = traceActive
    ? !isInTrace
    : hoveredNodeId !== null && !isConnected;
  // Keep trace styling isolated to rf-node-trace-active (no hover highlight glow/scale while tracing).
  const highlighted = traceActive
    ? false
    : hoveredNodeId !== null && isConnected;

  // Build the entry marker label: "▶ POST /api/orders"
  let entryLabel = "";
  if (isTraceEntry && traceResult) {
    const method = traceResult.request.method;
    let path = "/";
    try {
      path = new URL(traceResult.request.url).pathname;
    } catch {
      /* ignore */
    }
    entryLabel = `${method} ${path}`;
  }

  const wrapperClass = [
    "rf-node-wrapper",
    data.animate && "rf-node-animate",
    dimmed && "rf-node-dimmed",
    highlighted && "rf-node-highlighted",
    isDebugHighlighted && "rf-node-debug-highlighted",
    traceActive && isInTrace && "rf-node-trace-active",
    isTraceEntry && "rf-node-trace-entry",
  ]
    .filter(Boolean)
    .join(" ");

  const methodColor = "#FFFFFF";

  return (
    <div
      ref={nodeRef}
      className={wrapperClass}
      style={{ animationDelay: `${data.animationIndex * 40}ms` }}
    >
      {/* Entry point marker — anchored above the node */}
      {isTraceEntry && (
        <div className="trace-entry-marker">
          <div className="trace-entry-pill">
            <span className="trace-entry-icon">▶</span>
            <span className="trace-entry-method" style={{ color: methodColor }}>
              {traceResult?.request.method}
            </span>
            <span className="trace-entry-path">
              {entryLabel.split(" ").slice(1).join(" ")}
            </span>
            {tracePhase === "capturing" && (
              <span className="trace-entry-status">
                <span className="trace-entry-spinner" />
              </span>
            )}
            {tracePhase === "complete" && traceResult && (
              <span className="trace-entry-time">
                {traceResult.timedOut
                  ? "Timed out"
                  : `${Math.round(traceResult.totalTime)}ms`}
              </span>
            )}
          </div>
          <div className="trace-entry-arrow" />
        </div>
      )}
      <Handle
        type="target"
        id="target-top"
        position={Position.Top}
        className="rf-handle rf-handle-target"
      />
      <Handle
        type="target"
        id="target-bottom"
        position={Position.Bottom}
        className="rf-handle rf-handle-target"
      />
      <Handle
        type="target"
        id="target-left"
        position={Position.Left}
        className="rf-handle rf-handle-target"
      />
      <Handle
        type="target"
        id="target-right"
        position={Position.Right}
        className="rf-handle rf-handle-target"
      />
      <ServiceNode
        node={data.node}
        onClick={data.onNodeClick}
        onContextMenu={data.onNodeContextMenu}
        animationIndex={0}
      />
      <Handle
        type="source"
        id="source-top"
        position={Position.Top}
        className="rf-handle rf-handle-source"
      />
      <Handle
        type="source"
        id="source-bottom"
        position={Position.Bottom}
        className="rf-handle rf-handle-source"
      />
      <Handle
        type="source"
        id="source-left"
        position={Position.Left}
        className="rf-handle rf-handle-source"
      />
      <Handle
        type="source"
        id="source-right"
        position={Position.Right}
        className="rf-handle rf-handle-source"
      />
    </div>
  );
});

export function FlowServiceNode({ data }: { data: FlowServiceNodeData }) {
  return <FlowServiceNodeInner data={data} />;
}

export const flowNodeTypes = {
  service: FlowServiceNode,
  tierLabel: TierLabelNode,
  groupLabel: GroupLabelNode,
  groupBox: GroupBoxNode,
} as const;
