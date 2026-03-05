import { useState, useCallback, useRef, useEffect } from "react";
import type { TraceResult, TraceHop, GraphNode } from "../../types/electron";

interface TraceWaterfallProps {
  result: TraceResult;
  nodes: GraphNode[];
  onHoverHop: (hop: TraceHop | null) => void;
  onClickHop: (hop: TraceHop) => void;
  onDismiss: () => void;
}

function getLatencyColor(latency: number): string {
  if (latency < 100) return "#22C55E";
  if (latency < 300) return "#3B82F6";
  if (latency < 1000) return "#EAB308";
  return "#EF4444";
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return "#22C55E";
  if (status >= 300 && status < 400) return "#3B82F6";
  if (status >= 400 && status < 500) return "#EAB308";
  return "#EF4444";
}

function getNodeName(nodeId: string, nodes: GraphNode[]): string {
  const node = nodes.find((n) => n.id === nodeId);
  if (node) {
    const port = node.ports[0]?.port;
    return port ? `${node.name}:${port}` : node.name;
  }
  if (nodeId.startsWith("external:")) return nodeId.slice(9);
  return nodeId;
}

/**
 * Determine nesting depth for a hop based on its position in the chain.
 * Hops whose source was a previous hop's target get indented.
 */
function computeDepths(hops: TraceHop[]): number[] {
  const depths: number[] = [];
  const nodeDepth = new Map<string, number>();

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const parentDepth = nodeDepth.get(hop.sourceNodeId) ?? 0;
    const depth = parentDepth + 1;
    depths.push(depth);
    // The target of this hop becomes a potential source at this depth
    if (!nodeDepth.has(hop.targetNodeId) || nodeDepth.get(hop.targetNodeId)! < depth) {
      nodeDepth.set(hop.targetNodeId, depth);
    }
  }

  return depths;
}

/** Find the hop with the highest latency (only consider observed hops) */
function findBottleneck(hops: TraceHop[]): number {
  let maxIdx = -1;
  let maxLatency = 0;
  for (let i = 0; i < hops.length; i++) {
    if (hops[i].inferred) continue;
    if (hops[i].latency > maxLatency) {
      maxLatency = hops[i].latency;
      maxIdx = i;
    }
  }
  return maxIdx;
}

export function TraceWaterfall({ result, nodes, onHoverHop, onClickHop, onDismiss }: TraceWaterfallProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [panelHeight, setPanelHeight] = useState(200);
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const depths = computeDepths(result.hops);
  const bottleneckIdx = findBottleneck(result.hops);
  const totalTime = result.totalTime || 1;

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startY: e.clientY, startHeight: panelHeight };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dy = dragRef.current.startY - ev.clientY;
      setPanelHeight(Math.max(120, Math.min(500, dragRef.current.startHeight + dy)));
    };

    const handleUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };

    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  }, [panelHeight]);

  // Keyboard dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const methodColor =
    result.request.method === "GET" ? "#22C55E" :
    result.request.method === "POST" ? "#F97316" :
    result.request.method === "DELETE" ? "#EF4444" : "#3B82F6";

  return (
    <div
      className="trace-waterfall"
      style={{ height: collapsed ? 40 : panelHeight }}
    >
      {/* Resize handle */}
      {!collapsed && (
        <div className="trace-waterfall-resize" onMouseDown={handleDragStart} />
      )}

      {/* Header */}
      <div
        className="trace-waterfall-header"
        onClick={() => setCollapsed(!collapsed)}
      >
        <div className="trace-waterfall-title">
          <span className="trace-waterfall-icon">&#x27E1;</span>
          <span>Trace:</span>
          <span className="trace-waterfall-method" style={{ color: methodColor }}>
            {result.request.method}
          </span>
          <span className="trace-waterfall-url">
            {result.request.url.replace(/^https?:\/\//, "")}
          </span>
        </div>
        <div className="trace-waterfall-meta">
          {result.response && (
            <span
              className="trace-waterfall-status"
              style={{ background: getStatusColor(result.response.status) }}
            >
              {result.response.status}
            </span>
          )}
          {result.timedOut && (
            <span className="trace-waterfall-status" style={{ background: "#EF4444" }}>
              Timeout
            </span>
          )}
          <span className="trace-waterfall-total">
            {formatLatency(result.totalTime)}
          </span>
          <button
            className="trace-waterfall-close"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            aria-label="Close trace"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Body */}
      {!collapsed && (
        <div className="trace-waterfall-body">
          {/* Timeline axis */}
          <div className="trace-waterfall-axis">
            {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
              <span
                key={pct}
                className="trace-waterfall-tick"
                style={{ left: `${pct * 100}%` }}
              >
                {formatLatency(totalTime * pct)}
              </span>
            ))}
          </div>

          {/* Hop rows */}
          <div className="trace-waterfall-rows">
            {result.hops.map((hop, i) => {
              const isInferred = hop.inferred;
              const barLeft = (hop.startTime / totalTime) * 100;
              const barWidth = Math.max(1, (hop.latency / totalTime) * 100);
              const isBottleneck = !isInferred && i === bottleneckIdx;
              const color = isInferred ? "rgba(100, 116, 139, 0.5)" : getLatencyColor(hop.latency);

              return (
                <div
                  key={`${hop.sourceNodeId}-${hop.targetNodeId}`}
                  className={`trace-waterfall-row ${isBottleneck ? "trace-waterfall-row-bottleneck" : ""}`}
                  style={{ paddingLeft: depths[i] * 16 }}
                  onMouseEnter={() => onHoverHop(hop)}
                  onMouseLeave={() => onHoverHop(null)}
                  onClick={() => onClickHop(hop)}
                >
                  <div className="trace-waterfall-label">
                    <span className="trace-waterfall-arrow">
                      {isInferred ? "⇢" : "→"}
                    </span>
                    <span className="trace-waterfall-node-name">
                      {getNodeName(hop.targetNodeId, nodes)}
                    </span>
                  </div>
                  <div className="trace-waterfall-bar-area">
                    <div
                      className={`trace-waterfall-bar ${isBottleneck ? "trace-waterfall-bar-pulse" : ""}`}
                      style={{
                        left: `${barLeft}%`,
                        width: `${barWidth}%`,
                        background: color,
                      }}
                    />
                  </div>
                  <div className="trace-waterfall-latency" style={{ color: isInferred ? "#94A3B8" : color }}>
                    {isInferred ? `~${formatLatency(hop.latency)}` : formatLatency(hop.latency)}
                  </div>
                </div>
              );
            })}

            {/* Response row */}
            {result.response && (
              <div className="trace-waterfall-row trace-waterfall-row-response">
                <div className="trace-waterfall-label">
                  <span className="trace-waterfall-arrow">←</span>
                  <span className="trace-waterfall-node-name">
                    {result.response.status} {result.response.statusText}
                  </span>
                </div>
                <div className="trace-waterfall-bar-area">
                  <div
                    className="trace-waterfall-bar"
                    style={{
                      left: `${((totalTime - 2) / totalTime) * 100}%`,
                      width: `${(2 / totalTime) * 100}%`,
                      background: getStatusColor(result.response.status),
                      minWidth: 4,
                    }}
                  />
                </div>
                <div
                  className="trace-waterfall-latency"
                  style={{ color: getStatusColor(result.response.status) }}
                >
                  {formatLatency(totalTime)}
                </div>
              </div>
            )}

            {/* Empty state */}
            {result.hops.length === 0 && (
              <div className="trace-waterfall-empty">
                No downstream hops detected — request was handled by the target service alone.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
