import { groupLayoutNodes, groupContainersByProject } from "../grouping";
import { makeNode, resetCounters } from "../testHelpers";
import type { LayoutNode } from "../types";

beforeEach(() => resetCounters());

describe("groupLayoutNodes", () => {
  it("returns empty array for a layer with no nodes", () => {
    const result = groupLayoutNodes([], 0);
    expect(result).toEqual([]);
  });

  it("groups nodes by groupId within a layer", () => {
    const layoutNodes: LayoutNode[] = [
      { node: makeNode({ id: "api-1", name: "api-1" }), layer: 0, order: 0, groupId: "api" },
      { node: makeNode({ id: "api-2", name: "api-2" }), layer: 0, order: 1, groupId: "api" },
      { node: makeNode({ id: "db", name: "db" }), layer: 0, order: 2, groupId: "db" },
    ];
    const result = groupLayoutNodes(layoutNodes, 0);

    expect(result).toHaveLength(2);
    const apiGroup = result.find((g) => g.groupName.toLowerCase() === "api");
    const dbGroup = result.find((g) => g.groupName.toLowerCase() === "db");
    expect(apiGroup).toBeDefined();
    expect(apiGroup!.nodes).toHaveLength(2);
    expect(apiGroup!.isGroup).toBe(true);
    expect(dbGroup).toBeDefined();
    expect(dbGroup!.nodes).toHaveLength(1);
    expect(dbGroup!.isGroup).toBe(false);
  });

  it("ignores nodes from other layers", () => {
    const layoutNodes: LayoutNode[] = [
      { node: makeNode({ id: "a" }), layer: 0, order: 0, groupId: "a" },
      { node: makeNode({ id: "b" }), layer: 1, order: 0, groupId: "b" },
    ];
    const result = groupLayoutNodes(layoutNodes, 0);
    expect(result).toHaveLength(1);
    expect(result[0].nodes[0].id).toBe("a");
  });

  it("preserves order within groups", () => {
    const layoutNodes: LayoutNode[] = [
      { node: makeNode({ id: "svc-1" }), layer: 0, order: 0, groupId: "svc" },
      { node: makeNode({ id: "svc-2" }), layer: 0, order: 1, groupId: "svc" },
      { node: makeNode({ id: "svc-3" }), layer: 0, order: 2, groupId: "svc" },
    ];
    const result = groupLayoutNodes(layoutNodes, 0);
    expect(result).toHaveLength(1);
    expect(result[0].nodes.map((n) => n.id)).toEqual(["svc-1", "svc-2", "svc-3"]);
  });

  it("handles case-insensitive groupId matching", () => {
    const layoutNodes: LayoutNode[] = [
      { node: makeNode({ id: "a" }), layer: 0, order: 0, groupId: "Api" },
      { node: makeNode({ id: "b" }), layer: 0, order: 1, groupId: "api" },
    ];
    const result = groupLayoutNodes(layoutNodes, 0);
    // Both should be in the same group since groupId is lowercased internally
    expect(result).toHaveLength(1);
    expect(result[0].nodes).toHaveLength(2);
  });
});

describe("groupContainersByProject", () => {
  it("returns empty type groups when given no containers", () => {
    const result = groupContainersByProject([]);
    expect(result).toHaveLength(1);
    expect(result[0].projectName).toBe("Containers");
    expect(result[0].totalContainers).toBe(0);
    expect(result[0].typeGroups).toHaveLength(0);
  });

  it("groups containers by type", () => {
    const containers = [
      makeNode({ id: "pg", name: "postgres", type: "database", isDockerContainer: true }),
      makeNode({ id: "redis", name: "redis", type: "cache", isDockerContainer: true }),
      makeNode({ id: "mysql", name: "mysql", type: "database", isDockerContainer: true }),
    ];
    const result = groupContainersByProject(containers);
    expect(result[0].totalContainers).toBe(3);

    const dbGroup = result[0].typeGroups.find((g) => g.groupType === "database");
    expect(dbGroup).toBeDefined();
    expect(dbGroup!.nodes).toHaveLength(2);

    const cacheGroup = result[0].typeGroups.find((g) => g.groupType === "cache");
    expect(cacheGroup).toBeDefined();
    expect(cacheGroup!.nodes).toHaveLength(1);
  });

  it("sorts type groups by predefined order (frontend before database)", () => {
    const containers = [
      makeNode({ id: "db", type: "database", isDockerContainer: true }),
      makeNode({ id: "fe", type: "frontend", isDockerContainer: true }),
      makeNode({ id: "be", type: "backend", isDockerContainer: true }),
    ];
    const result = groupContainersByProject(containers);
    const types = result[0].typeGroups.map((g) => g.groupType);
    const frontendIdx = types.indexOf("frontend");
    const backendIdx = types.indexOf("backend");
    const databaseIdx = types.indexOf("database");
    expect(frontendIdx).toBeLessThan(backendIdx);
    expect(backendIdx).toBeLessThan(databaseIdx);
  });

  it("sorts nodes within each type group alphabetically", () => {
    const containers = [
      makeNode({ id: "z-db", name: "z-postgres", type: "database", isDockerContainer: true }),
      makeNode({ id: "a-db", name: "a-mysql", type: "database", isDockerContainer: true }),
    ];
    const result = groupContainersByProject(containers);
    const dbGroup = result[0].typeGroups.find((g) => g.groupType === "database");
    expect(dbGroup!.nodes[0].name).toBe("a-mysql");
    expect(dbGroup!.nodes[1].name).toBe("z-postgres");
  });
});
