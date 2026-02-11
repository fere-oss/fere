import {
  getBezierPath,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "reactflow";

export type ArrowEdgeData = {
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  sourcePos: Position;
  targetPos: Position;
};

function EdgePath({ id, edgePath }: { id: string; edgePath: string }) {
  return (
    <g>
      <path
        d={edgePath}
        fill="none"
        stroke="rgba(10, 10, 10, 0.07)"
        strokeWidth={2}
        strokeLinecap="round"
      />
      <path
        id={id}
        d={edgePath}
        fill="none"
        stroke="rgba(10, 10, 10, 0.30)"
        strokeWidth={1.5}
        strokeDasharray="4 8"
        strokeLinecap="round"
        className="react-flow__edge-path rf-edge-flow"
      />
    </g>
  );
}

export function ArrowBezierEdge({
  id,
  data,
}: EdgeProps<ArrowEdgeData>) {
  if (!data) return null;
  const [edgePath] = getBezierPath({
    sourceX: data.sx,
    sourceY: data.sy,
    sourcePosition: data.sourcePos,
    targetX: data.tx,
    targetY: data.ty,
    targetPosition: data.targetPos,
  });
  return <EdgePath id={id} edgePath={edgePath} />;
}

export function ArrowStepEdge({
  id,
  data,
}: EdgeProps<ArrowEdgeData>) {
  if (!data) return null;
  const [edgePath] = getSmoothStepPath({
    sourceX: data.sx,
    sourceY: data.sy,
    sourcePosition: data.sourcePos,
    targetX: data.tx,
    targetY: data.ty,
    targetPosition: data.targetPos,
    borderRadius: 16,
  });
  return <EdgePath id={id} edgePath={edgePath} />;
}

export const flowEdgeTypes = {
  arrowBezier: ArrowBezierEdge,
  arrowStep: ArrowStepEdge,
} as const;
