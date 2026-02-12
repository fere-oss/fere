/**
 * Tests for viewport culling logic.
 *
 * The culling algorithm in GraphView.tsx uses AABB (Axis-Aligned Bounding Box)
 * intersection: a node is visible if its rectangle overlaps the expanded viewport.
 *
 * Viewport bounds in world space:
 *   worldXMin = -panX / zoom - buffer
 *   worldYMin = -panY / zoom - buffer
 *   worldXMax = (containerWidth - panX) / zoom + buffer
 *   worldYMax = (containerHeight - panY) / zoom + buffer
 *
 * Node is visible when:
 *   x + w >= worldXMin && x <= worldXMax &&
 *   y + h >= worldYMin && y <= worldYMax
 */

import { FLOW_LAYOUT } from "../flowLayout";

const NODE_WIDTH = FLOW_LAYOUT.NODE_WIDTH;
const NODE_MIN_HEIGHT = FLOW_LAYOUT.NODE_MIN_HEIGHT;
const BUFFER = 2000; // matches GraphView.tsx

interface ViewportParams {
  panX: number;
  panY: number;
  zoom: number;
  containerWidth: number;
  containerHeight: number;
}

interface NodeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Replicate the culling logic from GraphView.tsx */
function isNodeVisible(node: NodeRect, viewport: ViewportParams): boolean {
  const { panX, panY, zoom: z, containerWidth: cw, containerHeight: ch } = viewport;
  const worldXMin = -panX / z - BUFFER;
  const worldYMin = -panY / z - BUFFER;
  const worldXMax = (cw - panX) / z + BUFFER;
  const worldYMax = (ch - panY) / z + BUFFER;

  return (
    node.x + node.w >= worldXMin &&
    node.x <= worldXMax &&
    node.y + node.h >= worldYMin &&
    node.y <= worldYMax
  );
}

describe("viewport culling", () => {
  const defaultViewport: ViewportParams = {
    panX: 0,
    panY: 0,
    zoom: 1,
    containerWidth: 1200,
    containerHeight: 800,
  };

  it("shows a node at origin with default viewport", () => {
    const node: NodeRect = { x: 0, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(node, defaultViewport)).toBe(true);
  });

  it("shows nodes within the buffer zone", () => {
    // Node is just outside the raw viewport but within the 2000px buffer
    const node: NodeRect = { x: 1500, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(node, defaultViewport)).toBe(true);
  });

  it("hides nodes far outside the viewport", () => {
    // Node is 5000px to the right — well beyond the 2000px buffer
    const node: NodeRect = { x: 5000, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(node, defaultViewport)).toBe(false);
  });

  it("hides nodes far above the viewport", () => {
    const node: NodeRect = { x: 0, y: -5000, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(node, defaultViewport)).toBe(false);
  });

  it("accounts for zoom level — zoomed out shows wider world area", () => {
    const zoomedOut: ViewportParams = { ...defaultViewport, zoom: 0.3 };
    // At zoom 0.3, the world area is much larger: containerWidth/0.3 = 4000 + buffer
    const farNode: NodeRect = { x: 4000, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(farNode, zoomedOut)).toBe(true);
  });

  it("accounts for zoom level — zoomed in shows smaller world area", () => {
    const zoomedIn: ViewportParams = { ...defaultViewport, zoom: 1.8 };
    // At zoom 1.8, world width ≈ 1200/1.8 ≈ 667 + buffer = 2667
    const farNode: NodeRect = { x: 3000, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(farNode, zoomedIn)).toBe(false);
  });

  it("accounts for pan offset", () => {
    // Panned 3000px to the right — shifts the visible area left
    const panned: ViewportParams = { ...defaultViewport, panX: 3000 };
    // Node at x=-5000 would normally be hidden, but with panX=3000:
    // worldXMin = -3000/1 - 2000 = -5000
    const farLeftNode: NodeRect = { x: -4800, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(farLeftNode, panned)).toBe(true);
  });

  it("correctly handles negative pan (panned to the left)", () => {
    const pannedLeft: ViewportParams = { ...defaultViewport, panX: -2000 };
    // worldXMin = 2000/1 - 2000 = 0 → far left
    // worldXMax = (1200 - (-2000))/1 + 2000 = 5200
    const rightNode: NodeRect = { x: 5000, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(rightNode, pannedLeft)).toBe(true);
  });

  it("uses node dimensions for the AABB check", () => {
    // Node's right edge (x + w) just touches the visible world area
    // worldXMin = -0/1 - 2000 = -2000
    const nodeAtEdge: NodeRect = { x: -2200, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    // x + w = -2200 + 260 = -1940, which is >= worldXMin (-2000) → visible
    expect(isNodeVisible(nodeAtEdge, defaultViewport)).toBe(true);
  });

  it("hides a node whose right edge is just past the buffer boundary", () => {
    // worldXMin = -2000
    // node at x = -2300, w = 260, so x + w = -2040
    // -2040 >= -2000 is false → hidden
    const nodeJustOutside: NodeRect = { x: -2300, y: 0, w: NODE_WIDTH, h: NODE_MIN_HEIGHT };
    expect(isNodeVisible(nodeJustOutside, defaultViewport)).toBe(false);
  });
});
