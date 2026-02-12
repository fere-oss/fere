import { computeHierarchicalLayout } from "../layout";
import { makeNode, makeEdge, resetCounters } from "../testHelpers";

beforeEach(() => resetCounters());

describe("computeHierarchicalLayout", () => {
  it("returns empty arrays when given no nodes", () => {
    const { connected, standalone } = computeHierarchicalLayout([], []);
    expect(connected).toEqual([]);
    expect(standalone).toEqual([]);
  });

  it("marks nodes without edges as standalone", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const { connected, standalone } = computeHierarchicalLayout(nodes, []);
    expect(connected).toHaveLength(0);
    expect(standalone).toHaveLength(2);
    expect(standalone.map((ln) => ln.node.id).sort()).toEqual(["a", "b"]);
  });

  it("marks nodes with edges as connected", () => {
    const nodes = [makeNode({ id: "a" }), makeNode({ id: "b" })];
    const edges = [makeEdge("a", "b")];
    const { connected, standalone } = computeHierarchicalLayout(nodes, edges);
    expect(connected).toHaveLength(2);
    expect(standalone).toHaveLength(0);
  });

  it("assigns source nodes to layer 0 and targets to deeper layers", () => {
    const a = makeNode({ id: "a", type: "frontend" });
    const b = makeNode({ id: "b", type: "backend" });
    const c = makeNode({ id: "c", type: "database" });
    const edges = [makeEdge("a", "b"), makeEdge("b", "c")];
    const { connected } = computeHierarchicalLayout([a, b, c], edges);

    const layerOf = (id: string) => connected.find((ln) => ln.node.id === id)!.layer;
    expect(layerOf("a")).toBe(0);
    expect(layerOf("b")).toBe(1);
    expect(layerOf("c")).toBe(2);
  });

  it("assigns the same layer to parallel nodes", () => {
    // a -> b, a -> c  (b and c should be same layer)
    const a = makeNode({ id: "a", type: "frontend" });
    const b = makeNode({ id: "b", type: "backend" });
    const c = makeNode({ id: "c", type: "backend" });
    const edges = [makeEdge("a", "b"), makeEdge("a", "c")];
    const { connected } = computeHierarchicalLayout([a, b, c], edges);

    const layerOf = (id: string) => connected.find((ln) => ln.node.id === id)!.layer;
    expect(layerOf("a")).toBe(0);
    expect(layerOf("b")).toBe(layerOf("c"));
    expect(layerOf("b")).toBe(1);
  });

  it("separates connected and standalone nodes in a mixed graph", () => {
    const a = makeNode({ id: "a" });
    const b = makeNode({ id: "b" });
    const c = makeNode({ id: "standalone" });
    const edges = [makeEdge("a", "b")];
    const { connected, standalone } = computeHierarchicalLayout([a, b, c], edges);
    expect(connected.map((ln) => ln.node.id).sort()).toEqual(["a", "b"]);
    expect(standalone.map((ln) => ln.node.id)).toEqual(["standalone"]);
  });

  it("assigns groupIds based on base name similarity", () => {
    const a = makeNode({ id: "api-server", name: "api-server" });
    const b = makeNode({ id: "api-worker", name: "api-worker" });
    const c = makeNode({ id: "db", name: "db" });
    const edges = [makeEdge("api-server", "db"), makeEdge("api-worker", "db")];
    const { connected } = computeHierarchicalLayout([a, b, c], edges);

    const groupOf = (id: string) => connected.find((ln) => ln.node.id === id)!.groupId;
    // api-server and api-worker should share the same base group ("api")
    expect(groupOf("api-server")).toBe(groupOf("api-worker"));
    // db should have a different group
    expect(groupOf("db")).not.toBe(groupOf("api-server"));
  });

  it("handles cycles without crashing (picks a root)", () => {
    const a = makeNode({ id: "a", type: "frontend" });
    const b = makeNode({ id: "b", type: "backend" });
    const edges = [makeEdge("a", "b"), makeEdge("b", "a")];
    const { connected } = computeHierarchicalLayout([a, b], edges);
    expect(connected).toHaveLength(2);
    // Both should have layers assigned
    connected.forEach((ln) => {
      expect(typeof ln.layer).toBe("number");
    });
  });

  it("sorts standalone nodes by type priority (frontends before databases)", () => {
    const fe = makeNode({ id: "fe", type: "frontend" });
    const db = makeNode({ id: "db", type: "database" });
    const be = makeNode({ id: "be", type: "backend" });
    const { standalone } = computeHierarchicalLayout([db, fe, be], []);
    const orders = standalone.map((ln) => ({ id: ln.node.id, order: ln.order }));
    const sorted = [...orders].sort((a, b) => a.order - b.order);
    // Frontend should come first, then backend, then database
    expect(sorted[0].id).toBe("fe");
    expect(sorted[sorted.length - 1].id).toBe("db");
  });

  it("handles a diamond dependency graph correctly", () => {
    //   a
    //  / \
    // b   c
    //  \ /
    //   d
    const a = makeNode({ id: "a", type: "frontend" });
    const b = makeNode({ id: "b", type: "backend" });
    const c = makeNode({ id: "c", type: "backend" });
    const d = makeNode({ id: "d", type: "database" });
    const edges = [
      makeEdge("a", "b"),
      makeEdge("a", "c"),
      makeEdge("b", "d"),
      makeEdge("c", "d"),
    ];
    const { connected } = computeHierarchicalLayout([a, b, c, d], edges);
    const layerOf = (id: string) => connected.find((ln) => ln.node.id === id)!.layer;
    expect(layerOf("a")).toBe(0);
    expect(layerOf("b")).toBe(1);
    expect(layerOf("c")).toBe(1);
    // d should be at the deepest layer since it depends on b and c
    expect(layerOf("d")).toBeGreaterThanOrEqual(2);
  });

  it("produces consistent results on repeated calls with same input", () => {
    const nodes = [
      makeNode({ id: "x", type: "frontend" }),
      makeNode({ id: "y", type: "backend" }),
      makeNode({ id: "z", type: "database" }),
    ];
    const edges = [makeEdge("x", "y"), makeEdge("y", "z")];

    const result1 = computeHierarchicalLayout(nodes, edges);
    const result2 = computeHierarchicalLayout(nodes, edges);

    expect(result1.connected.length).toBe(result2.connected.length);
    result1.connected.forEach((ln1, i) => {
      const ln2 = result2.connected[i];
      expect(ln1.node.id).toBe(ln2.node.id);
      expect(ln1.layer).toBe(ln2.layer);
      expect(ln1.order).toBe(ln2.order);
    });
  });
});
