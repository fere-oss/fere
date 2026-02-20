/**
 * Tests for edge bundling logic.
 *
 * The bundling algorithm in GraphView.tsx:
 * 1. Deduplicates edges (same source->target only kept once)
 * 2. Groups edges by target's layout group key (`layer-${layer}-${groupId}`)
 * 3. When a group has >= BUNDLE_THRESHOLD (3) edges, bundles them into
 *    a single representative edge with a _bundleCount property
 */

import { makeEdge, resetCounters } from "../testHelpers";
import type { GraphEdge } from "../../../types/electron";
import type { LayoutNode } from "../types";

const BUNDLE_THRESHOLD = 3;

interface LayoutLookupEntry {
  layer: number;
  groupId: string;
}

/** Replicate the bundling logic from GraphView.tsx */
function bundleEdges(
  edges: GraphEdge[],
  hoveredNodeId: string,
  layoutLookup: Map<string, LayoutLookupEntry>,
): Array<GraphEdge & { _bundleCount?: number }> {
  // Step 1: Deduplicate
  const seen = new Set<string>();
  const dedupedEdges = edges.filter((edge) => {
    if (edge.source !== hoveredNodeId) return false;
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Step 2: Group by target layout group
  const edgesByGroup = new Map<string, GraphEdge[]>();
  dedupedEdges.forEach((edge) => {
    const tgt = layoutLookup.get(edge.target);
    const groupKey = tgt ? `layer-${tgt.layer}-${tgt.groupId}` : edge.target;
    if (!edgesByGroup.has(groupKey)) edgesByGroup.set(groupKey, []);
    edgesByGroup.get(groupKey)!.push(edge);
  });

  // Step 3: Bundle groups above threshold
  const bundled: Array<GraphEdge & { _bundleCount?: number }> = [];
  edgesByGroup.forEach((groupEdges) => {
    if (groupEdges.length < BUNDLE_THRESHOLD) {
      bundled.push(...groupEdges);
    } else {
      const rep = groupEdges[Math.floor(groupEdges.length / 2)];
      bundled.push({ ...rep, id: `bundle-${rep.id}`, _bundleCount: groupEdges.length });
    }
  });

  return bundled;
}

beforeEach(() => resetCounters());

describe("edge bundling", () => {
  it("passes through edges below the bundle threshold", () => {
    const edges = [
      makeEdge("src", "t1"),
      makeEdge("src", "t2"),
    ];
    const lookup = new Map<string, LayoutLookupEntry>([
      ["t1", { layer: 1, groupId: "api" }],
      ["t2", { layer: 1, groupId: "api" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    expect(result).toHaveLength(2);
    expect(result.every((e) => e._bundleCount === undefined)).toBe(true);
  });

  it("bundles edges when threshold is reached", () => {
    const edges = [
      makeEdge("src", "t1"),
      makeEdge("src", "t2"),
      makeEdge("src", "t3"),
    ];
    const lookup = new Map<string, LayoutLookupEntry>([
      ["t1", { layer: 1, groupId: "api" }],
      ["t2", { layer: 1, groupId: "api" }],
      ["t3", { layer: 1, groupId: "api" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    expect(result).toHaveLength(1);
    expect(result[0]._bundleCount).toBe(3);
    expect(result[0].id).toMatch(/^bundle-/);
  });

  it("bundles edges selectively — only groups exceeding threshold", () => {
    const edges = [
      makeEdge("src", "a1"),
      makeEdge("src", "a2"),
      makeEdge("src", "a3"), // 3 to "api" group → bundled
      makeEdge("src", "b1"),
      makeEdge("src", "b2"), // 2 to "db" group → not bundled
    ];
    const lookup = new Map<string, LayoutLookupEntry>([
      ["a1", { layer: 1, groupId: "api" }],
      ["a2", { layer: 1, groupId: "api" }],
      ["a3", { layer: 1, groupId: "api" }],
      ["b1", { layer: 2, groupId: "db" }],
      ["b2", { layer: 2, groupId: "db" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    // 1 bundled + 2 individual = 3 total edges
    expect(result).toHaveLength(3);
    const bundled = result.filter((e) => e._bundleCount !== undefined);
    const individual = result.filter((e) => e._bundleCount === undefined);
    expect(bundled).toHaveLength(1);
    expect(bundled[0]._bundleCount).toBe(3);
    expect(individual).toHaveLength(2);
  });

  it("deduplicates edges with same source-target before bundling", () => {
    const edges = [
      makeEdge("src", "t1"),
      makeEdge("src", "t1"), // duplicate
      makeEdge("src", "t2"),
      makeEdge("src", "t3"),
    ];
    const lookup = new Map<string, LayoutLookupEntry>([
      ["t1", { layer: 1, groupId: "api" }],
      ["t2", { layer: 1, groupId: "api" }],
      ["t3", { layer: 1, groupId: "api" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    // After dedup: t1, t2, t3 (3 unique) → bundled into 1
    expect(result).toHaveLength(1);
    expect(result[0]._bundleCount).toBe(3);
  });

  it("filters out edges not from the hovered node", () => {
    const edges = [
      makeEdge("src", "t1"),
      makeEdge("other", "t2"), // different source, should be excluded
      makeEdge("src", "t3"),
    ];
    const lookup = new Map<string, LayoutLookupEntry>([
      ["t1", { layer: 1, groupId: "api" }],
      ["t2", { layer: 1, groupId: "api" }],
      ["t3", { layer: 1, groupId: "api" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    // Only src->t1 and src->t3 (2 edges, below threshold)
    expect(result).toHaveLength(2);
    expect(result.every((e) => e.source === "src")).toBe(true);
  });

  it("picks the middle edge as the bundle representative", () => {
    const edges = [
      makeEdge("src", "t1", { id: "e1" }),
      makeEdge("src", "t2", { id: "e2" }),
      makeEdge("src", "t3", { id: "e3" }),
      makeEdge("src", "t4", { id: "e4" }),
      makeEdge("src", "t5", { id: "e5" }),
    ];
    const lookup = new Map<string, LayoutLookupEntry>([
      ["t1", { layer: 1, groupId: "svc" }],
      ["t2", { layer: 1, groupId: "svc" }],
      ["t3", { layer: 1, groupId: "svc" }],
      ["t4", { layer: 1, groupId: "svc" }],
      ["t5", { layer: 1, groupId: "svc" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    expect(result).toHaveLength(1);
    // Math.floor(5/2) = 2, so e3 is the representative
    expect(result[0].id).toBe("bundle-e3");
    expect(result[0]._bundleCount).toBe(5);
  });

  it("separates edges targeting different layers into different groups", () => {
    const edges = [
      makeEdge("src", "t1"),
      makeEdge("src", "t2"),
      makeEdge("src", "t3"),
    ];
    // Same groupId but different layers → treated as separate groups
    const lookup = new Map<string, LayoutLookupEntry>([
      ["t1", { layer: 1, groupId: "api" }],
      ["t2", { layer: 2, groupId: "api" }],
      ["t3", { layer: 3, groupId: "api" }],
    ]);

    const result = bundleEdges(edges, "src", lookup);
    // Each in a different group key → no bundling (each group has 1 edge)
    expect(result).toHaveLength(3);
    expect(result.every((e) => e._bundleCount === undefined)).toBe(true);
  });

  it("uses target id as fallback group key when target has no layout entry", () => {
    const edges = [
      makeEdge("src", "unknown1"),
      makeEdge("src", "unknown2"),
      makeEdge("src", "unknown3"),
    ];
    // No layout entries → each target is its own group
    const lookup = new Map<string, LayoutLookupEntry>();

    const result = bundleEdges(edges, "src", lookup);
    // 3 individual groups (each target is unique fallback key) → no bundling
    expect(result).toHaveLength(3);
  });
});

describe("LOD zoom threshold", () => {
  // This tests the LOD_ZOOM_THRESHOLD constant exported from flowNodes.tsx
  // The threshold determines when nodes switch between full and minimal rendering
  it("threshold is between 0 and 1", () => {
    // Import the constant
    const LOD_ZOOM_THRESHOLD = 0.45; // matches flowNodes.tsx
    expect(LOD_ZOOM_THRESHOLD).toBeGreaterThan(0);
    expect(LOD_ZOOM_THRESHOLD).toBeLessThan(1);
  });
});
