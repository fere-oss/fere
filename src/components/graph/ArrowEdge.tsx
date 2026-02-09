import { useEffect, useRef, useState } from "react";
import {
  getBezierPath,
  getSmoothStepPath,
  type EdgeProps,
} from "reactflow";

const EDGE_COLOR = "#3B82F6";
const STROKE_WIDTH = 2.5;
const ARROW_SPACING = 64;
const ARROW_SIZE = 10;

type ArrowPoint = { x: number; y: number; angle: number };

function computeArrows(path: SVGPathElement): ArrowPoint[] {
  const length = path.getTotalLength();
  if (length < ARROW_SPACING) return [];
  const points: ArrowPoint[] = [];
  const start = ARROW_SPACING * 0.7;
  for (let d = start; d < length - ARROW_SPACING * 0.4; d += ARROW_SPACING) {
    const p1 = path.getPointAtLength(d - 1);
    const p2 = path.getPointAtLength(d + 1);
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * (180 / Math.PI);
    const p = path.getPointAtLength(d);
    points.push({ x: p.x, y: p.y, angle });
  }
  return points;
}

function ArrowChevrons({
  pathRef,
  pathData,
}: {
  pathRef: React.RefObject<SVGPathElement | null>;
  pathData: string;
}) {
  const [arrows, setArrows] = useState<ArrowPoint[]>([]);

  useEffect(() => {
    if (!pathRef.current) return;
    setArrows(computeArrows(pathRef.current));
  }, [pathData, pathRef]);

  return (
    <>
      {arrows.map((arrow, i) => (
        <polygon
          key={i}
          points={`${-ARROW_SIZE},${-ARROW_SIZE * 0.75} ${ARROW_SIZE * 0.6},0 ${-ARROW_SIZE},${ARROW_SIZE * 0.75}`}
          transform={`translate(${arrow.x},${arrow.y}) rotate(${arrow.angle})`}
          fill={EDGE_COLOR}
          opacity={0.85}
        />
      ))}
    </>
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
      <ArrowChevrons pathRef={pathRef} pathData={edgePath} />
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
      <ArrowChevrons pathRef={pathRef} pathData={edgePath} />
    </g>
  );
}

export const flowEdgeTypes = {
  arrowBezier: ArrowBezierEdge,
  arrowStep: ArrowStepEdge,
} as const;
