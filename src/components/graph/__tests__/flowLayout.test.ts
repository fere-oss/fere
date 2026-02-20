import { buildStableConnectedLayout, FLOW_LAYOUT } from "../flowLayout";
import { computeHierarchicalLayout } from "../layout";
import { makeNode, makeEdge, resetCounters } from "../testHelpers";

beforeEach(() => resetCounters());

describe("buildStableConnectedLayout", () => {
  function getConnected(nodes: ReturnType<typeof makeNode>[], edges: ReturnType<typeof makeEdge>[]) {
    return computeHierarchicalLayout(nodes, edges).connected;
  }

  it("preserves order when called with empty caches", () => {
    const nodes = [
      makeNode({ id: "a", type: "frontend" }),
      makeNode({ id: "b", type: "backend" }),
    ];
    const edges = [makeEdge("a", "b")];
    const connected = getConnected(nodes, edges);
    const orderCache = new Map<number, string[]>();
    const groupOrderCache = new Map<number, string[]>();

    const result = buildStableConnectedLayout(connected, orderCache, groupOrderCache);
    expect(result).toHaveLength(2);
    // Caches should be populated
    expect(orderCache.size).toBeGreaterThan(0);
    expect(groupOrderCache.size).toBeGreaterThan(0);
  });

  it("maintains stable order across multiple calls with same topology", () => {
    const nodes = [
      makeNode({ id: "a", type: "frontend" }),
      makeNode({ id: "b", type: "backend", name: "api-server" }),
      makeNode({ id: "c", type: "backend", name: "api-worker" }),
    ];
    const edges = [makeEdge("a", "b"), makeEdge("a", "c")];
    const connected = getConnected(nodes, edges);
    const orderCache = new Map<number, string[]>();
    const groupOrderCache = new Map<number, string[]>();

    const result1 = buildStableConnectedLayout(connected, orderCache, groupOrderCache);
    const result2 = buildStableConnectedLayout(connected, orderCache, groupOrderCache);

    // Orders should be identical between calls when topology hasn't changed
    result1.forEach((ln, i) => {
      expect(ln.order).toBe(result2[i].order);
      expect(ln.node.id).toBe(result2[i].node.id);
    });
  });

  it("groups nodes by groupId within each layer", () => {
    const nodes = [
      makeNode({ id: "fe", type: "frontend", name: "fe" }),
      makeNode({ id: "api-1", type: "backend", name: "api-server" }),
      makeNode({ id: "api-2", type: "backend", name: "api-worker" }),
      makeNode({ id: "db", type: "database", name: "db" }),
    ];
    const edges = [
      makeEdge("fe", "api-1"),
      makeEdge("fe", "api-2"),
      makeEdge("api-1", "db"),
      makeEdge("api-2", "db"),
    ];
    const connected = getConnected(nodes, edges);
    const orderCache = new Map<number, string[]>();
    const groupOrderCache = new Map<number, string[]>();

    const result = buildStableConnectedLayout(connected, orderCache, groupOrderCache);

    // api-1 and api-2 should be adjacent in the order (same group)
    const layer1Nodes = result
      .filter((ln) => ln.layer === 1)
      .sort((a, b) => a.order - b.order);
    const ids = layer1Nodes.map((ln) => ln.node.id);
    const idx1 = ids.indexOf("api-1");
    const idx2 = ids.indexOf("api-2");
    expect(Math.abs(idx1 - idx2)).toBe(1);
  });

  it("populates order cache per layer", () => {
    const nodes = [
      makeNode({ id: "a", type: "frontend" }),
      makeNode({ id: "b", type: "backend" }),
      makeNode({ id: "c", type: "database" }),
    ];
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];
    const connected = getConnected(nodes, edges);
    const orderCache = new Map<number, string[]>();
    const groupOrderCache = new Map<number, string[]>();

    buildStableConnectedLayout(connected, orderCache, groupOrderCache);

    // Each layer that has nodes should have an entry in the order cache
    const layers = new Set(connected.map((ln) => ln.layer));
    layers.forEach((layer) => {
      expect(orderCache.has(layer)).toBe(true);
      expect(orderCache.get(layer)!.length).toBeGreaterThan(0);
    });
  });
});

describe("FLOW_LAYOUT constants", () => {
  it("has reasonable layout dimensions", () => {
    expect(FLOW_LAYOUT.NODE_WIDTH).toBeGreaterThan(0);
    expect(FLOW_LAYOUT.NODE_MIN_HEIGHT).toBeGreaterThan(0);
    expect(FLOW_LAYOUT.NODE_GAP).toBeGreaterThan(0);
    expect(FLOW_LAYOUT.LAYER_GAP).toBeGreaterThan(0);
  });

  it("limits group columns to prevent overly wide layouts", () => {
    expect(FLOW_LAYOUT.MAX_GROUP_COLUMNS).toBeLessThanOrEqual(4);
    expect(FLOW_LAYOUT.MAX_STANDALONE_COLUMNS).toBeLessThanOrEqual(4);
  });
});
