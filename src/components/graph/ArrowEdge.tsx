import { useEffect, useRef, useState } from "react";
import {
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
} from "reactflow";

const EDGE_COLOR = "#56B4F9";
const STROKE_WIDTH = 4;
const ARROW_SIZE = 16;

type ArrowPoint = { x: number; y: number; angle: number };

function computeMidArrow(path: SVGPathElement): ArrowPoint | null {
  const length = path.getTotalLength();
  if (length < 20) return null;
  const mid = length / 2;
  const p = path.getPointAtLength(mid);
  const p1 = path.getPointAtLength(mid - 1);
  const p2 = path.getPointAtLength(mid + 1);
  const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * (180 / Math.PI);
  return { x: p.x, y: p.y, angle };
}

function MidArrow({
  pathRef,
  pathData,
}: {
  pathRef: React.RefObject<SVGPathElement | null>;
  pathData: string;
}) {
  const [arrow, setArrow] = useState<ArrowPoint | null>(null);

  useEffect(() => {
    if (!pathRef.current) return;
    setArrow(computeMidArrow(pathRef.current));
  }, [pathData, pathRef]);

  if (!arrow) return null;

  return (
    <polygon
      points={`${-ARROW_SIZE},${-ARROW_SIZE * 0.7} ${ARROW_SIZE * 0.7},0 ${-ARROW_SIZE},${ARROW_SIZE * 0.7}`}
      transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angle})`}
      fill={EDGE_COLOR}
    />
  );
}

export function ArrowBezierEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const pathRef = useRef<SVGPathElement>(null);
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <g>
      <path
        ref={pathRef}
        id={id}
        d={edgePath}
        fill="none"
        stroke={EDGE_COLOR}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="react-flow__edge-path"
      />
      <MidArrow pathRef={pathRef} pathData={edgePath} />
    </g>
  );
}

export function ArrowStepEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const pathRef = useRef<SVGPathElement>(null);
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 16,
  });

  return (
    <g>
      <path
        ref={pathRef}
        id={id}
        d={edgePath}
        fill="none"
        stroke={EDGE_COLOR}
        strokeWidth={STROKE_WIDTH}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="react-flow__edge-path"
      />
      <MidArrow pathRef={pathRef} pathData={edgePath} />
    </g>
  );
}

export const flowEdgeTypes = {
  arrowBezier: ArrowBezierEdge,
  arrowStep: ArrowStepEdge,
} as const;
