import {
  getBezierPath,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "reactflow";
import { TraceBezierEdge, TraceStepEdge } from "./TraceEdge";

export type ArrowEdgeData = {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourcePos: Position;
  targetPos: Position;
  /** When set, this edge represents a bundle of N edges to the same group */
  bundleCount?: number;
  /** Target node type for connection labels */
  targetType?: string;
  /** Target node port for connection labels */
  targetPort?: number;
  /** Whether learning labels are visible */
  connectionLabel?: string | null;
};

function EdgePath({ id, edgePath, bundleCount, labelX, labelY, connectionLabel }: {
  id: string;
  edgePath: string;
  bundleCount?: number;
  labelX?: number;
  labelY?: number;
  connectionLabel?: string | null;
}) {
  return (
    <g>
      <path
        d={edgePath}
        fill="none"
        stroke="rgba(10, 10, 10, 0.13)"
        strokeWidth={bundleCount ? 3 : 2}
        strokeLinecap="round"
      />
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke="rgba(10, 10, 10, 0.85)"
        strokeWidth={bundleCount ? 2.5 : 1.5}
        strokeDasharray="4 8"
        strokeLinecap="round"
        className="react-flow__edge-path rf-edge-flow"
      />
      {bundleCount && labelX !== undefined && labelY !== undefined && (
        <g transform={`translate(${labelX}, ${labelY})`}>
          <rect x={-12} y={-10} width={24} height={20} rx={10} fill="rgba(0,0,0,0.55)" />
          <text
            x={0}
            y={1}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="white"
            fontSize={11}
            fontWeight={600}
          >
            {bundleCount}
          </text>
        </g>
      )}
      {connectionLabel && !bundleCount && labelX !== undefined && labelY !== undefined && (
        <g transform={`translate(${labelX}, ${labelY})`}>
          <rect
            x={-connectionLabel.length * 2.7 - 6}
            y={-8}
            width={connectionLabel.length * 5.4 + 12}
            height={16}
            rx={3}
            fill="white"
            stroke="rgba(0,0,0,0.08)"
            strokeWidth={0.5}
          />
          <text
            x={0}
            y={1}
            textAnchor="middle"
            dominantBaseline="middle"
            fill="#999"
            fontSize={9}
            fontFamily="system-ui, sans-serif"
          >
            {connectionLabel}
          </text>
        </g>
      )}
    </g>
  );
}

export function ArrowBezierEdge({
  id,
  data,
}: EdgeProps<ArrowEdgeData>) {
  if (!data) return null;
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX: data.sx,
    sourceY: data.sy,
    sourcePosition: data.sourcePos,
    targetX: data.tx,
    targetY: data.ty,
    targetPosition: data.targetPos,
  });
  return <EdgePath id={id} edgePath={edgePath} bundleCount={data.bundleCount} labelX={labelX} labelY={labelY} connectionLabel={data.connectionLabel} />;
}

export function ArrowStepEdge({
  id,
  data,
}: EdgeProps<ArrowEdgeData>) {
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
  return <EdgePath id={id} edgePath={edgePath} bundleCount={data.bundleCount} labelX={labelX} labelY={labelY} connectionLabel={data.connectionLabel} />;
}

export const flowEdgeTypes = {
  arrowBezier: ArrowBezierEdge,
  arrowStep: ArrowStepEdge,
  traceBezier: TraceBezierEdge,
  traceStep: TraceStepEdge,
} as const;
