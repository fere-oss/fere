import { useEffect, useRef } from "react";
import {
  getBezierPath,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "reactflow";
import type { ArrowEdgeData } from "./ArrowEdge";

export type TraceEdgeData = ArrowEdgeData & {
  latency?: number;
  /** Whether this hop is currently the one being animated */
  isActiveHop?: boolean;
  /** Whether the draw-on animation has completed for this edge */
  isDrawn?: boolean;
  /** Whether this hop was inferred rather than directly observed */
  inferred?: boolean;
};

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

function TraceEdgePath({
  id,
  edgePath,
  labelX,
  labelY,
  latency,
  isActiveHop,
  isDrawn,
  inferred,
}: {
  id: string;
  edgePath: string;
  labelX?: number;
  labelY?: number;
  latency?: number;
  isActiveHop?: boolean;
  isDrawn?: boolean;
  inferred?: boolean;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  const animatedRef = useRef<SVGPathElement>(null);

  useEffect(() => {
    if (!animatedRef.current) return;
    const path = animatedRef.current;
    const length = path.getTotalLength();

    if (isActiveHop) {
      // Start draw-on: set dasharray to full length, offset to full length, then animate to 0
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
      // Force reflow
      path.getBoundingClientRect();
      // Animate
      path.style.transition = `stroke-dashoffset ${Math.max(800, Math.min(2500, (latency || 800) * 2))}ms ease-out`;
      path.style.strokeDashoffset = "0";
    } else if (isDrawn) {
      // Already drawn — show fully
      path.style.strokeDasharray = "none";
      path.style.strokeDashoffset = "0";
      path.style.transition = "none";
    } else {
      // Not yet drawn — hide
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
      path.style.transition = "none";
    }
  }, [isActiveHop, isDrawn, latency]);

  const showBadge = (isDrawn || isActiveHop) && latency !== undefined && latency >= 0 && labelX !== undefined && labelY !== undefined;
  const badgeColor = inferred ? "rgba(100, 116, 139, 0.7)" : (latency !== undefined ? getLatencyColor(latency) : "#3B82F6");
  const badgeText = latency !== undefined && latency >= 0 ? `${inferred ? "~" : ""}${formatLatency(latency)}` : "";
  const badgeWidth = Math.max(40, badgeText.length * 8 + 16);

  return (
    <g className={isActiveHop || isDrawn ? "rf-trace-edge-active" : "rf-trace-edge-pending"}>
      {/* Base glow stroke */}
      <path
        ref={pathRef}
        d={edgePath}
        fill="none"
        stroke="rgba(59, 130, 246, 0.3)"
        strokeWidth={3}
        strokeLinecap="round"
        style={{ opacity: isActiveHop || isDrawn ? 1 : 0 }}
      />
      {/* Animated top stroke */}
      <path
        ref={animatedRef}
        id={id}
        d={edgePath}
        fill="none"
        stroke="#3B82F6"
        strokeWidth={2}
        strokeLinecap="round"
        strokeDasharray={inferred ? "6 4" : "none"}
        className="react-flow__edge-path"
        style={{ filter: "drop-shadow(0 0 3px rgba(59, 130, 246, 0.5))" }}
      />
      {/* Latency badge */}
      {showBadge && (
        <g
          transform={`translate(${labelX}, ${labelY})`}
          className="rf-trace-badge"
          style={{ opacity: isDrawn ? 1 : 0, transition: "opacity 0.3s ease" }}
        >
          <rect
            x={-badgeWidth / 2}
            y={-10}
            width={badgeWidth}
            height={20}
            rx={10}
            fill={badgeColor}
          />
          <text
            x={0}
            y={1}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="white"
            fontSize={10}
            fontWeight={600}
            fontFamily="'JetBrains Mono', monospace"
          >
            {badgeText}
          </text>
        </g>
      )}
    </g>
  );
}

export function TraceBezierEdge({
  id,
  data,
}: EdgeProps<TraceEdgeData>) {
  if (!data) return null;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: data.sx,
    sourceY: data.sy,
    sourcePosition: data.sourcePos,
    targetX: data.tx,
    targetY: data.ty,
    targetPosition: data.targetPos,
  });
  return (
    <TraceEdgePath
      id={id}
      edgePath={edgePath}
      labelX={labelX}
      labelY={labelY}
      latency={data.latency}
      isActiveHop={data.isActiveHop}
      isDrawn={data.isDrawn}
      inferred={data.inferred}
    />
  );
}

export function TraceStepEdge({
  id,
  data,
}: EdgeProps<TraceEdgeData>) {
  if (!data) return null;
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX: data.sx,
    sourceY: data.sy,
    sourcePosition: data.sourcePos,
    targetX: data.tx,
    targetY: data.ty,
    targetPosition: data.targetPos,
    borderRadius: 16,
  });
  return (
    <TraceEdgePath
      id={id}
      edgePath={edgePath}
      labelX={labelX}
      labelY={labelY}
      latency={data.latency}
      isActiveHop={data.isActiveHop}
      isDrawn={data.isDrawn}
      inferred={data.inferred}
    />
  );
}
