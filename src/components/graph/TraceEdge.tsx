import {
  getBezierPath,
  getSmoothStepPath,
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
  const showBadge = (isDrawn || isActiveHop) && latency !== undefined && latency >= 0 && labelX !== undefined && labelY !== undefined;
  const badgeColor = "#171717";
  const badgeText = latency !== undefined && latency >= 0 ? `${inferred ? "~" : ""}${formatLatency(latency)}` : "";
  const badgeWidth = Math.max(40, badgeText.length * 8 + 16);

  return (
    <g className={isActiveHop || isDrawn ? "rf-trace-edge-active" : "rf-trace-edge-pending"}>
      {/* Base stroke */}
      <path
        d={edgePath}
        fill="none"
        stroke="rgba(10, 10, 10, 0.13)"
        strokeWidth={3}
        strokeLinecap="round"
        style={{ opacity: isActiveHop || isDrawn ? 1 : 0 }}
      />
      {/* Dotted streaming stroke (matches regular hover edge style) */}
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke={inferred ? "rgba(100, 116, 139, 0.8)" : "rgba(10, 10, 10, 0.85)"}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeDasharray={inferred ? "6 4" : "4 8"}
        className="react-flow__edge-path rf-edge-flow"
        style={{ opacity: isActiveHop || isDrawn ? 1 : 0 }}
      />
      {/* Latency badge */}
      {showBadge && (
        <g
          transform={`translate(${labelX}, ${labelY})`}
          className="rf-trace-badge"
          style={{ opacity: isDrawn || isActiveHop ? 1 : 0, transition: "opacity 0.3s ease" }}
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
