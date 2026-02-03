import type { NodePosition } from './types';

interface Point {
  x: number;
  y: number;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface EdgeRoute {
  from: string;
  to: string;
  path: string;
  waypoints: Point[];
  confidence: number;
}

interface Connection {
  from: string;
  to: string;
  sourcePort: number;
  targetPort: number;
  confidence: number;
}

// Padding around nodes for edge routing
const NODE_PADDING = 16;
const EDGE_SEPARATION = 12;

/**
 * Get the bounding box of a node with padding
 */
function getNodeBounds(pos: NodePosition, padding = NODE_PADDING): Rect {
  return {
    x: pos.x - pos.width / 2 - padding,
    y: pos.y - pos.height / 2 - padding,
    width: pos.width + padding * 2,
    height: pos.height + padding * 2,
  };
}

/**
 * Check if a point is inside a rectangle
 */
function pointInRect(p: Point, rect: Rect): boolean {
  return (
    p.x >= rect.x &&
    p.x <= rect.x + rect.width &&
    p.y >= rect.y &&
    p.y <= rect.y + rect.height
  );
}

/**
 * Check if a line segment intersects a rectangle
 * Uses Liang-Barsky algorithm
 */
function lineIntersectsRect(p1: Point, p2: Point, rect: Rect): boolean {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;

  // Check if either endpoint is inside the rect
  if (pointInRect(p1, rect) || pointInRect(p2, rect)) {
    return true;
  }

  // Parametric line: P(t) = p1 + t * (p2 - p1), t in [0, 1]
  let tMin = 0;
  let tMax = 1;

  const edges = [
    { p: -dx, q: p1.x - rect.x }, // Left
    { p: dx, q: rect.x + rect.width - p1.x }, // Right
    { p: -dy, q: p1.y - rect.y }, // Top
    { p: dy, q: rect.y + rect.height - p1.y }, // Bottom
  ];

  for (const { p, q } of edges) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) {
        tMin = Math.max(tMin, t);
      } else {
        tMax = Math.min(tMax, t);
      }
      if (tMin > tMax) return false;
    }
  }

  return tMin <= tMax;
}

/**
 * Check if a bezier curve intersects a rectangle
 * Sample the curve at multiple points and check line segments
 */
function bezierIntersectsRect(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  rect: Rect,
  samples = 10
): boolean {
  let prev = p0;
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const curr = cubicBezierPoint(p0, p1, p2, p3, t);
    if (lineIntersectsRect(prev, curr, rect)) {
      return true;
    }
    prev = curr;
  }
  return false;
}

/**
 * Get a point on a cubic bezier curve
 */
function cubicBezierPoint(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  t: number
): Point {
  const mt = 1 - t;
  const mt2 = mt * mt;
  const mt3 = mt2 * mt;
  const t2 = t * t;
  const t3 = t2 * t;

  return {
    x: mt3 * p0.x + 3 * mt2 * t * p1.x + 3 * mt * t2 * p2.x + t3 * p3.x,
    y: mt3 * p0.y + 3 * mt2 * t * p1.y + 3 * mt * t2 * p2.y + t3 * p3.y,
  };
}

/**
 * Get edge point on node boundary, using ports (top/bottom for vertical layout)
 */
function getEdgePort(
  node: NodePosition,
  isSource: boolean,
  _targetNode?: NodePosition
): Point {
  // For layered layout: sources exit from bottom, targets enter from top
  const halfH = node.height / 2;

  if (isSource) {
    return { x: node.x, y: node.y + halfH };
  } else {
    return { x: node.x, y: node.y - halfH };
  }
}

/**
 * Find nodes that a straight line from source to target would pass through
 */
function findObstructingNodes(
  sourceId: string,
  targetId: string,
  sourcePos: NodePosition,
  targetPos: NodePosition,
  allPositions: Map<string, NodePosition>
): NodePosition[] {
  const obstructions: NodePosition[] = [];
  const start = getEdgePort(sourcePos, true);
  const end = getEdgePort(targetPos, false);

  // Only check nodes in layers between source and target
  const minLayer = Math.min(sourcePos.layer, targetPos.layer);
  const maxLayer = Math.max(sourcePos.layer, targetPos.layer);

  allPositions.forEach((pos, nodeId) => {
    if (nodeId === sourceId || nodeId === targetId) return;

    // Only check nodes in intermediate layers
    if (pos.layer <= minLayer || pos.layer >= maxLayer) return;

    const bounds = getNodeBounds(pos);
    if (lineIntersectsRect(start, end, bounds)) {
      obstructions.push(pos);
    }
  });

  // Sort by layer (closest to source first)
  obstructions.sort((a, b) => a.layer - b.layer);

  return obstructions;
}

/**
 * Calculate waypoints to route around obstructing nodes
 */
function calculateWaypoints(
  sourcePos: NodePosition,
  targetPos: NodePosition,
  obstructions: NodePosition[]
): Point[] {
  const start = getEdgePort(sourcePos, true);
  const end = getEdgePort(targetPos, false);

  if (obstructions.length === 0) {
    return [start, end];
  }

  const waypoints: Point[] = [start];

  // Route around each obstruction
  for (const obs of obstructions) {
    const bounds = getNodeBounds(obs, NODE_PADDING + 4);
    const prevPoint = waypoints[waypoints.length - 1];

    // Determine which side to route around
    // Prefer the side that's closer to the line
    const leftX = bounds.x;
    const rightX = bounds.x + bounds.width;
    const nodeBotY = bounds.y + bounds.height;

    // Calculate midpoint between previous waypoint and end
    const targetX = (prevPoint.x + end.x) / 2;

    // Route to whichever side is closer to our trajectory
    const distToLeft = Math.abs(targetX - leftX);
    const distToRight = Math.abs(targetX - rightX);

    const routeX = distToLeft < distToRight ? leftX - 4 : rightX + 4;

    // Add waypoints: go horizontally, then vertically around the node
    waypoints.push({ x: routeX, y: prevPoint.y });
    waypoints.push({ x: routeX, y: nodeBotY + 8 });
  }

  waypoints.push(end);

  return waypoints;
}

/**
 * Convert waypoints to a smooth SVG path
 * Uses cubic bezier curves for smooth transitions
 */
function waypointsToPath(waypoints: Point[], smooth = true): string {
  if (waypoints.length < 2) return '';

  const [start, ...rest] = waypoints;

  if (!smooth || waypoints.length === 2) {
    // Simple case: direct bezier or line
    const end = rest[rest.length - 1];
    const dy = end.y - start.y;
    const controlOffset = Math.min(Math.abs(dy) * 0.4, 100);

    return `M ${start.x} ${start.y} C ${start.x} ${start.y + controlOffset}, ${end.x} ${end.y - controlOffset}, ${end.x} ${end.y}`;
  }

  // Multiple waypoints: smooth path through all points
  let d = `M ${start.x} ${start.y}`;

  for (let i = 0; i < rest.length; i++) {
    const curr = rest[i];
    const prev = i === 0 ? start : rest[i - 1];

    if (i === rest.length - 1) {
      // Last segment: curve to endpoint
      const dy = curr.y - prev.y;
      const controlOffset = Math.min(Math.abs(dy) * 0.35, 60);
      d += ` C ${prev.x} ${prev.y + controlOffset}, ${curr.x} ${curr.y - controlOffset}, ${curr.x} ${curr.y}`;
    } else if (i === 0) {
      // First intermediate point: curve from start
      const dy = curr.y - prev.y;
      const controlOffset = Math.min(Math.abs(dy) * 0.35, 60);
      d += ` C ${prev.x} ${prev.y + controlOffset}, ${curr.x} ${curr.y - controlOffset}, ${curr.x} ${curr.y}`;
    } else {
      // Middle waypoints: smooth connection
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;

      if (Math.abs(dx) > Math.abs(dy)) {
        // Horizontal segment
        const midX = (prev.x + curr.x) / 2;
        d += ` C ${midX} ${prev.y}, ${midX} ${curr.y}, ${curr.x} ${curr.y}`;
      } else {
        // Vertical segment
        const midY = (prev.y + curr.y) / 2;
        d += ` C ${prev.x} ${midY}, ${curr.x} ${midY}, ${curr.x} ${curr.y}`;
      }
    }
  }

  return d;
}

/**
 * Simple direct edge path (no obstruction handling)
 * Used when source and target are in adjacent layers
 */
function directEdgePath(
  sourcePos: NodePosition,
  targetPos: NodePosition
): { path: string; waypoints: Point[] } {
  const start = getEdgePort(sourcePos, true);
  const end = getEdgePort(targetPos, false);

  const dy = end.y - start.y;
  const dx = end.x - start.x;

  let path: string;

  if (sourcePos.layer === targetPos.layer) {
    // Same layer: arc over
    const arcY = Math.min(start.y, end.y) - Math.max(40, Math.abs(dx) * 0.15);
    const midX = (start.x + end.x) / 2;
    path = `M ${start.x} ${start.y} Q ${midX} ${arcY}, ${end.x} ${end.y}`;
  } else {
    // Different layers: smooth S-curve
    const controlOffset = Math.min(Math.abs(dy) * 0.4, 120);
    path = `M ${start.x} ${start.y} C ${start.x} ${start.y + controlOffset}, ${end.x} ${end.y - controlOffset}, ${end.x} ${end.y}`;
  }

  return { path, waypoints: [start, end] };
}

/**
 * Check if a direct bezier path intersects any nodes
 */
function directPathHasCollision(
  sourcePos: NodePosition,
  targetPos: NodePosition,
  sourceId: string,
  targetId: string,
  allPositions: Map<string, NodePosition>
): boolean {
  const start = getEdgePort(sourcePos, true);
  const end = getEdgePort(targetPos, false);

  const dy = end.y - start.y;
  const controlOffset = Math.min(Math.abs(dy) * 0.4, 120);

  const p0 = start;
  const p1 = { x: start.x, y: start.y + controlOffset };
  const p2 = { x: end.x, y: end.y - controlOffset };
  const p3 = end;

  const minLayer = Math.min(sourcePos.layer, targetPos.layer);
  const maxLayer = Math.max(sourcePos.layer, targetPos.layer);

  let hasCollision = false;
  allPositions.forEach((pos, nodeId) => {
    if (hasCollision) return;
    if (nodeId === sourceId || nodeId === targetId) return;
    if (pos.layer <= minLayer || pos.layer >= maxLayer) return;

    const bounds = getNodeBounds(pos, 8);
    if (bezierIntersectsRect(p0, p1, p2, p3, bounds, 16)) {
      hasCollision = true;
    }
  });

  return hasCollision;
}

/**
 * Group edges by source-target layer pairs for bundling
 */
function groupEdgesByLayers(
  connections: Connection[],
  positions: Map<string, NodePosition>
): Map<string, Connection[]> {
  const groups = new Map<string, Connection[]>();

  connections.forEach(conn => {
    const srcPos = positions.get(conn.from);
    const tgtPos = positions.get(conn.to);
    if (!srcPos || !tgtPos) return;

    const key = `${srcPos.layer}->${tgtPos.layer}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(conn);
  });

  return groups;
}

/**
 * Calculate edge bundle offsets to prevent overlapping parallel edges
 */
function calculateBundleOffsets(
  connections: Connection[],
  positions: Map<string, NodePosition>
): Map<string, number> {
  const offsets = new Map<string, number>();
  const groups = groupEdgesByLayers(connections, positions);

  groups.forEach(bundle => {
    if (bundle.length <= 1) return;

    // Sort edges by source x position for consistent ordering
    bundle.sort((a, b) => {
      const posA = positions.get(a.from);
      const posB = positions.get(b.from);
      return (posA?.x ?? 0) - (posB?.x ?? 0);
    });

    bundle.forEach((conn, idx) => {
      const offset = (idx - (bundle.length - 1) / 2) * EDGE_SEPARATION;
      const key = `${conn.from}->${conn.to}`;
      offsets.set(key, offset);
    });
  });

  return offsets;
}

/**
 * Main edge routing function
 * Routes edges to avoid passing through nodes
 */
export function routeEdges(
  connections: Connection[],
  positions: Map<string, NodePosition>
): EdgeRoute[] {
  if (positions.size === 0) return [];

  const routes: EdgeRoute[] = [];
  const bundleOffsets = calculateBundleOffsets(connections, positions);

  connections.forEach(conn => {
    const sourcePos = positions.get(conn.from);
    const targetPos = positions.get(conn.to);
    if (!sourcePos || !targetPos) return;

    // Get bundle offset for this edge
    const bundleOffset = bundleOffsets.get(`${conn.from}->${conn.to}`) ?? 0;

    // Apply bundle offset to positions (shift horizontally)
    const adjustedSourcePos = { ...sourcePos, x: sourcePos.x + bundleOffset };
    const adjustedTargetPos = { ...targetPos, x: targetPos.x + bundleOffset };

    // Check if this is an adjacent layer connection or spans multiple layers
    const layerSpan = Math.abs(targetPos.layer - sourcePos.layer);

    if (layerSpan <= 1) {
      // Adjacent layers or same layer: use direct path
      const { path, waypoints } = directEdgePath(adjustedSourcePos, adjustedTargetPos);
      routes.push({
        from: conn.from,
        to: conn.to,
        path,
        waypoints,
        confidence: conn.confidence,
      });
    } else {
      // Spans multiple layers: check for collisions
      const hasCollision = directPathHasCollision(
        adjustedSourcePos,
        adjustedTargetPos,
        conn.from,
        conn.to,
        positions
      );

      if (!hasCollision) {
        // No collision: use direct path
        const { path, waypoints } = directEdgePath(adjustedSourcePos, adjustedTargetPos);
        routes.push({
          from: conn.from,
          to: conn.to,
          path,
          waypoints,
          confidence: conn.confidence,
        });
      } else {
        // Has collision: find obstructions and route around them
        const obstructions = findObstructingNodes(
          conn.from,
          conn.to,
          adjustedSourcePos,
          adjustedTargetPos,
          positions
        );

        const waypoints = calculateWaypoints(
          adjustedSourcePos,
          adjustedTargetPos,
          obstructions
        );

        const path = waypointsToPath(waypoints, true);

        routes.push({
          from: conn.from,
          to: conn.to,
          path,
          waypoints,
          confidence: conn.confidence,
        });
      }
    }
  });

  return routes;
}

/**
 * Simplified edge routing for cases where full collision detection isn't needed
 * Uses smart port selection and smooth curves
 */
export function routeEdgesSimple(
  connections: Connection[],
  positions: Map<string, NodePosition>
): EdgeRoute[] {
  if (positions.size === 0) return [];

  const routes: EdgeRoute[] = [];
  const bundleOffsets = calculateBundleOffsets(connections, positions);

  connections.forEach(conn => {
    const sourcePos = positions.get(conn.from);
    const targetPos = positions.get(conn.to);
    if (!sourcePos || !targetPos) return;

    const bundleOffset = bundleOffsets.get(`${conn.from}->${conn.to}`) ?? 0;

    const start = getEdgePort(sourcePos, true);
    const end = getEdgePort(targetPos, false);

    // Apply bundle offset
    start.x += bundleOffset;
    end.x += bundleOffset;

    const dx = end.x - start.x;
    const dy = end.y - start.y;

    let path: string;

    if (sourcePos.layer === targetPos.layer) {
      // Same layer: arc over
      const arcY = Math.min(start.y, end.y) - Math.max(40, Math.abs(dx) * 0.12);
      const midX = (start.x + end.x) / 2;
      path = `M ${start.x} ${start.y} Q ${midX} ${arcY}, ${end.x} ${end.y}`;
    } else {
      // Different layers: smooth S-curve with controlled curvature
      const verticalDist = Math.abs(dy);
      const horizontalDist = Math.abs(dx);

      // Adjust control points based on the angle
      let controlOffset = Math.min(verticalDist * 0.4, 100);

      // For edges with significant horizontal displacement, use different control points
      if (horizontalDist > verticalDist * 0.5) {
        // More horizontal: use S-curve that goes out then in
        const midY = (start.y + end.y) / 2;
        path = `M ${start.x} ${start.y} C ${start.x} ${midY}, ${end.x} ${midY}, ${end.x} ${end.y}`;
      } else {
        // More vertical: standard bezier
        path = `M ${start.x} ${start.y} C ${start.x} ${start.y + controlOffset}, ${end.x} ${end.y - controlOffset}, ${end.x} ${end.y}`;
      }
    }

    routes.push({
      from: conn.from,
      to: conn.to,
      path,
      waypoints: [start, end],
      confidence: conn.confidence,
    });
  });

  return routes;
}
