import { useState, useEffect } from "react";
import type { TraceResult, TraceHop, GraphNode } from "../../types/electron";
import { BrandIcon, inferServiceBrand } from "./brandIcons";

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

function formatAxisTick(ms: number, totalTime: number): string {
  if (totalTime < 10) {
    const decimals = totalTime < 2 ? 2 : 1;
    return `${ms.toFixed(decimals)}ms`;
  }
  return formatLatency(ms);
}

function formatHopLatency(ms: number, inferred: boolean): string {
  if (ms < 1) return "<1ms";
  return inferred ? `~${formatLatency(ms)}` : formatLatency(ms);
}

function getStatusColor(status: number): string {
  if (status >= 200 && status < 300) return "#22C55E";
  if (status >= 300 && status < 400) return "#3B82F6";
  if (status >= 400 && status < 500) return "#EAB308";
  return "#EF4444";
}

function getNodeInfo(
  nodeId: string,
  nodes: GraphNode[],
): { name: string; brand: string | null; isGraphNode: boolean } {
  const node = nodes.find((n) => n.id === nodeId);
  if (node) {
    const port = node.ports[0]?.port;
    return {
      name: port ? `${node.name}:${port}` : node.name,
      brand: inferServiceBrand(node),
      isGraphNode: true,
    };
  }
  if (nodeId.startsWith("external:")) {
    return { name: nodeId.slice(9), brand: null, isGraphNode: false };
  }
  return { name: nodeId, brand: null, isGraphNode: false };
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

/**
 * Best-effort inference for which hop likely failed.
 * We only know final request status, not per-hop HTTP status.
 */
function findLikelyFailingHop(
  hops: TraceHop[],
  response: TraceResult["response"],
  timedOut: boolean,
): number {
  if (hops.length === 0) return -1;
  const hasFailure = timedOut || (response ? response.status >= 500 : false);
  if (!hasFailure) return -1;

  // Prefer the latest observed hop, fallback to the latest hop.
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!hops[i].inferred) return i;
  }
  return hops.length - 1;
}

export function TraceWaterfall({
  result,
  nodes,
  onHoverHop,
  onClickHop,
  onDismiss,
}: TraceWaterfallProps) {
  const [collapsed, setCollapsed] = useState(false);
  const displayedHops = result.hops;
  const depths = computeDepths(displayedHops);
  const bottleneckIdx = findBottleneck(displayedHops);
  const likelyFailingHopIdx = findLikelyFailingHop(displayedHops, result.response, result.timedOut);
  const totalTime = Math.max(1, result.totalTime || 1);
  const responseWindow = Math.min(totalTime, Math.max(0.2, Math.min(2, totalTime * 0.2)));

  // Keyboard dismiss
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onDismiss]);

  const methodColor =
    result.request.method === "GET"
      ? "#22C55E"
      : result.request.method === "POST"
        ? "#F97316"
        : result.request.method === "DELETE"
          ? "#EF4444"
          : "#2563EB";

  const rowCount =
    displayedHops.length + (result.response ? 1 : 0) + (displayedHops.length === 0 ? 1 : 0);
  const expandedHeight = Math.min(560, Math.max(220, 56 + 24 + 22 + rowCount * 30 + 18));

  if (collapsed) {
    return (
      <div className="trace-waterfall trace-waterfall-collapsed">
        <button
          className="trace-waterfall-collapsed-btn"
          onClick={() => setCollapsed(false)}
          title="Expand trace details"
        >
          <span className="trace-waterfall-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" className="trace-waterfall-icon-svg">
              <line x1="1.5" y1="8" x2="5.5" y2="8" />
              <circle cx="8" cy="8" r="2.1" />
              <line x1="10.5" y1="8" x2="14.5" y2="8" />
            </svg>
          </span>
          <span>Trace</span>
          <span className="trace-waterfall-method" style={{ color: methodColor }}>
            {result.request.method}
          </span>
          <span className="trace-waterfall-total">{formatLatency(result.totalTime)}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="trace-waterfall" style={{ height: expandedHeight }}>
      {/* Header */}
      <div className="trace-waterfall-header">
        <div className="trace-waterfall-title">
          <span className="trace-waterfall-icon" aria-hidden="true">
            <svg viewBox="0 0 16 16" className="trace-waterfall-icon-svg">
              <line x1="1.5" y1="8" x2="5.5" y2="8" />
              <circle cx="8" cy="8" r="2.1" />
              <line x1="10.5" y1="8" x2="14.5" y2="8" />
            </svg>
          </span>
          <span>Trace:</span>
          <span className="trace-waterfall-method" style={{ color: methodColor }}>
            {result.request.method}
          </span>
          <span className="trace-waterfall-url">
            {result.request.url.replace(/^https?:\/\//, "")}
          </span>
          <span
            className="trace-waterfall-mode-badge"
            title="Connection-level trace. Hop timing/status may be inferred without service instrumentation."
          >
            Approximate
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
          <span className="trace-waterfall-total">{formatLatency(result.totalTime)}</span>
          <button
            className="trace-waterfall-close"
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed(true);
            }}
            aria-label="Minimize trace"
            title="Minimize"
          >
            &#x2212;
          </button>
          <button
            className="trace-waterfall-close"
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
            aria-label="Close trace"
            title="Close"
          >
            &#x2715;
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="trace-waterfall-body">
        {/* Timeline axis */}
        <div className="trace-waterfall-axis">
          {[0, 0.25, 0.5, 0.75, 1].map((pct) => (
            <span key={pct} className="trace-waterfall-tick" style={{ left: `${pct * 100}%` }}>
              {formatAxisTick(totalTime * pct, totalTime)}
            </span>
          ))}
        </div>

        {/* Legend */}
        <div className="trace-waterfall-legend">
          <span className="trace-waterfall-legend-item">
            <span className="trace-waterfall-legend-line trace-waterfall-legend-solid" />
            <span>Observed connection</span>
          </span>
          <span className="trace-waterfall-legend-item">
            <span className="trace-waterfall-legend-line trace-waterfall-legend-dashed" />
            <span>Inferred hop/status (~)</span>
          </span>
        </div>

        {/* Hop rows */}
        <div className="trace-waterfall-rows">
          {displayedHops.map((hop, i) => {
            const isInferred = hop.inferred;
            const barLeft = (hop.startTime / totalTime) * 100;
            const barWidth = Math.max(1, (hop.latency / totalTime) * 100);
            const isBottleneck = !isInferred && i === bottleneckIdx;
            const isLikelyFailure = i === likelyFailingHopIdx;
            const color = isLikelyFailure
              ? "#EF4444"
              : isInferred
                ? "rgba(100, 116, 139, 0.5)"
                : getLatencyColor(hop.latency);
            const target = getNodeInfo(hop.targetNodeId, nodes);

            return (
              <div
                key={`${hop.sourceNodeId}-${hop.targetNodeId}`}
                className={`trace-waterfall-row ${isBottleneck ? "trace-waterfall-row-bottleneck" : ""}`}
                style={{ paddingLeft: depths[i] * 12 }}
                onMouseEnter={() => onHoverHop(hop)}
                onMouseLeave={() => onHoverHop(null)}
                onClick={() => onClickHop(hop)}
              >
                <div className="trace-waterfall-label">
                  <span className="trace-waterfall-arrow">{isInferred ? "⇢" : "→"}</span>
                  <span className="trace-waterfall-node-name-wrap">
                    {target.isGraphNode && (
                      <BrandIcon
                        value={target.brand || target.name}
                        className="trace-waterfall-node-icon"
                        size={14}
                      />
                    )}
                    <span className="trace-waterfall-node-name" title={target.name}>
                      {target.name}
                    </span>
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
                <div className="trace-waterfall-note">
                  {isLikelyFailure && (
                    <span className="trace-waterfall-failure-tag">likely error</span>
                  )}
                </div>
                <div
                  className="trace-waterfall-latency"
                  style={{ color: isInferred ? "#94A3B8" : color }}
                >
                  {formatHopLatency(hop.latency, isInferred)}
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
                    left: `${((totalTime - responseWindow) / totalTime) * 100}%`,
                    width: `${(responseWindow / totalTime) * 100}%`,
                    background: getStatusColor(result.response.status),
                    minWidth: 4,
                  }}
                />
              </div>
              <div className="trace-waterfall-note" />
              <div
                className="trace-waterfall-latency"
                style={{ color: getStatusColor(result.response.status) }}
              >
                {formatLatency(totalTime)}
              </div>
            </div>
          )}

          {/* Empty state */}
          {displayedHops.length === 0 && (
            <div className="trace-waterfall-empty">
              No downstream hops detected — request was handled by the target service alone.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
