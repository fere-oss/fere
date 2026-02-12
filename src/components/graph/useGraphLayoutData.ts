import { useMemo, useRef } from "react";
import type { GraphNode, GraphEdge } from "../../types/electron";
import { computeHierarchicalLayout } from "./layout";
import { groupContainersByProject } from "./grouping";
import { buildStableConnectedLayout } from "./flowLayout";
import { supportsExternalApiScan } from "./externalApis";
import type { LayoutNode, RenderGroup } from "./types";

export function useGraphLayoutData({
  nodes,
  edges,
  isContainerView,
  orderCache,
  groupOrderCache,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  isContainerView: boolean;
  orderCache: Map<number, string[]>;
  groupOrderCache: Map<number, string[]>;
}) {
  const stableNodes = useMemo(() => {
    return [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  }, [nodes]);

  const stableEdges = useMemo(() => {
    return [...edges].sort((a, b) => a.id.localeCompare(b.id));
  }, [edges]);

  const localNodes = useMemo(
    () => stableNodes.filter((n) => n.type !== "external"),
    [stableNodes],
  );

  const localEdges = useMemo(() => {
    const localNodeIds = new Set(localNodes.map((n) => n.id));
    return stableEdges.filter(
      (e) => localNodeIds.has(e.source) && localNodeIds.has(e.target),
    );
  }, [localNodes, stableEdges]);

  const containerNodes = useMemo(
    () => localNodes.filter((node) => node.isDockerContainer),
    [localNodes],
  );

  const layoutNodes = isContainerView ? containerNodes : localNodes;
  const layoutEdges = useMemo(
    () => (isContainerView ? [] : localEdges),
    [isContainerView, localEdges],
  );

  const projectPathsKey = useMemo(() => {
    return Array.from(
      new Set(
        localNodes
          .filter((node) => supportsExternalApiScan(node))
          .map((node) => node.projectPath)
          .filter(Boolean),
      ),
    )
      .sort()
      .join(",");
  }, [localNodes]);

  // Topology key — stable across metrics-only changes (cpu/memory/health).
  // Only changes when nodes are added/removed or edges change.
  const topologyKey = useMemo(() => {
    const nk = layoutNodes.map((n) => n.id).sort().join(",");
    const ek = layoutEdges.map((e) => `${e.source}-${e.target}`).sort().join(",");
    return `${nk}|${ek}`;
  }, [layoutNodes, layoutEdges]);

  // Cache the expensive hierarchical layout computation based on topology key.
  // computeHierarchicalLayout runs topological sort + 6 iterations of
  // barycenter crossing minimization — skip it when only metrics changed.
  const layoutCacheRef = useRef<{
    key: string;
    connected: LayoutNode[];
    standalone: LayoutNode[];
  }>({ key: "", connected: [], standalone: [] });

  const { connected: connectedLayout, standalone: standaloneLayout } = useMemo(
    () => {
      if (isContainerView) return { connected: [], standalone: [] };

      if (topologyKey === layoutCacheRef.current.key) {
        // Topology unchanged — reuse cached layer/order, update node references
        // so metrics (cpu/memory/health) are fresh
        const nodeMap = new Map(localNodes.map((n) => [n.id, n]));
        return {
          connected: layoutCacheRef.current.connected.map((ln) => ({
            ...ln,
            node: nodeMap.get(ln.node.id) || ln.node,
          })),
          standalone: layoutCacheRef.current.standalone.map((ln) => ({
            ...ln,
            node: nodeMap.get(ln.node.id) || ln.node,
          })),
        };
      }

      // Topology changed — full recomputation
      const result = computeHierarchicalLayout(localNodes, localEdges);
      layoutCacheRef.current = { key: topologyKey, ...result };
      return result;
    },
    [topologyKey, isContainerView, localNodes, localEdges],
  );

  const stableConnectedLayout = useMemo<LayoutNode[]>(
    () =>
      buildStableConnectedLayout(
        connectedLayout,
        orderCache,
        groupOrderCache,
      ),
    [connectedLayout, orderCache, groupOrderCache],
  );

  const sortedLayers = useMemo(() => {
    const layers = new Set(stableConnectedLayout.map((ln) => ln.layer));
    return Array.from(layers).sort((a, b) => a - b);
  }, [stableConnectedLayout]);

  const containerGroups = useMemo<RenderGroup[]>(() => {
    if (!isContainerView) return [];
    const projects = groupContainersByProject(containerNodes);
    const groups = projects.flatMap((project) => project.typeGroups);
    return groups.map((group) => ({
      ...group,
      isGroup: group.nodes.length > 1,
    }));
  }, [isContainerView, containerNodes]);

  const standaloneGroups = useMemo<RenderGroup[]>(() => {
    if (isContainerView) return containerGroups;
    if (standaloneLayout.length === 0) return [];

    const systemNodes: GraphNode[] = [];
    const singles: RenderGroup[] = [];

    standaloneLayout.forEach((ln) => {
      if (ln.node.type === "service") {
        systemNodes.push(ln.node);
      } else {
        singles.push({
          groupName: ln.node.name,
          nodes: [ln.node],
          isGroup: false,
          groupType: ln.node.type,
        });
      }
    });

    const result: RenderGroup[] = [];
    if (systemNodes.length > 0) {
      result.push({
        groupName: "System Services",
        nodes: systemNodes.sort((a, b) => a.name.localeCompare(b.name)),
        isGroup: systemNodes.length > 1,
        groupType: "service",
      });
    }

    return [...result, ...singles].sort((a, b) =>
      a.groupName.localeCompare(b.groupName),
    );
  }, [containerGroups, isContainerView, standaloneLayout]);

  return {
    layoutNodes,
    layoutEdges,
    projectPathsKey,
    sortedLayers,
    stableConnectedLayout,
    standaloneGroups,
  };
}
