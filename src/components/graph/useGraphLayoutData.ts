import { useMemo, useRef } from "react";
import type { GraphNode, GraphEdge } from "../../types/electron";
import { computeHierarchicalLayout } from "./layout";
import { groupContainersByProject } from "./grouping";
import { buildStableConnectedLayout } from "./flowLayout";
import { supportsExternalApiScan } from "./externalApis";
import { SERVICE_COLORS, getTypePriority } from "./constants";
import type { LayoutNode, RenderGroup } from "./types";

const isSyntheticDockerNetworkEdge = (edge: GraphEdge): boolean =>
  typeof edge.protocol === "string" && edge.protocol.startsWith("docker-network:");

const shouldProfileLayout = (): boolean => {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem("fere.perf.layout") === "1";
  } catch {
    return false;
  }
};

const isRemoteAccessNode = (node: GraphNode): boolean => {
  const source = `${node.name || ""} ${node.command || ""}`.toLowerCase();
  return /(^|\s)(ssh|autossh|sftp|scp|sshd)(\s|$)/.test(source);
};

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
  const localNodeById = useMemo(
    () => new Map(localNodes.map((node) => [node.id, node])),
    [localNodes],
  );

  const localEdges = useMemo(() => {
    const localNodeIds = new Set(localNodes.map((n) => n.id));
    return stableEdges.filter(
      (e) => localNodeIds.has(e.source) && localNodeIds.has(e.target),
    );
  }, [localNodes, stableEdges]);

  const structuralEdges = useMemo(
    () => localEdges.filter((edge) => !isSyntheticDockerNetworkEdge(edge)),
    [localEdges],
  );

  const effectiveHierarchyEdges = useMemo(
    () => (structuralEdges.length > 0 ? structuralEdges : localEdges),
    [structuralEdges, localEdges],
  );

  const hierarchyEdges = useMemo(() => {
    const usingFallbackDockerOnly = structuralEdges.length === 0;
    if (!usingFallbackDockerOnly) return effectiveHierarchyEdges;

    const normalized = new Map<string, GraphEdge>();
    for (const edge of effectiveHierarchyEdges) {
      if (!isSyntheticDockerNetworkEdge(edge)) {
        normalized.set(edge.id, edge);
        continue;
      }

      const sourceNode = localNodeById.get(edge.source);
      const targetNode = localNodeById.get(edge.target);
      if (!sourceNode || !targetNode) continue;

      const sourcePriority = getTypePriority(sourceNode.type);
      const targetPriority = getTypePriority(targetNode.type);
      if (sourcePriority === targetPriority) continue;

      const [lowNode, highNode] =
        sourcePriority < targetPriority
          ? [sourceNode, targetNode]
          : [targetNode, sourceNode];
      const lowPriority = Math.min(sourcePriority, targetPriority);
      const highPriority = Math.max(sourcePriority, targetPriority);

      // Keep layering signal clean when we only have Docker mesh edges.
      // Frontends should point to app tier, and app tier can point to infra tiers.
      if (lowPriority === 0 && highPriority !== 1) continue;
      if (lowPriority === 1 && highPriority > 3) continue;
      if (highPriority - lowPriority > 2) continue;

      const normalizedId = `hier-${lowNode.id}-${highNode.id}`;
      normalized.set(normalizedId, {
        ...edge,
        id: normalizedId,
        source: lowNode.id,
        target: highNode.id,
      });
    }

    return Array.from(normalized.values());
  }, [effectiveHierarchyEdges, structuralEdges.length, localNodeById]);

  const containerNodes = useMemo(
    () => localNodes.filter((node) => node.isDockerContainer),
    [localNodes],
  );

  const layoutNodes = isContainerView ? containerNodes : localNodes;
  // Deduplicate edges to at most one per source→target pair.
  // The backend may create multiple edges between the same pair on different
  // ports (e.g. A→B:5432, A→B:6379).  Layout only needs unique pairs.
  const layoutEdges = useMemo(() => {
    if (isContainerView) return [];
    const seen = new Set<string>();
    return hierarchyEdges.filter((edge) => {
      const key = `${edge.source}->${edge.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [isContainerView, hierarchyEdges]);

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
      const start = performance.now();
      const result = computeHierarchicalLayout(localNodes, hierarchyEdges);
      if (shouldProfileLayout()) {
        console.log(
          `[PERF] computeHierarchicalLayout: ${(performance.now() - start).toFixed(2)}ms (${localNodes.length} nodes, ${hierarchyEdges.length} edges)`,
        );
      }
      layoutCacheRef.current = { key: topologyKey, ...result };
      return result;
    },
    [topologyKey, isContainerView, localNodes, hierarchyEdges],
  );

  const stableConnectedLayout = useMemo<LayoutNode[]>(
    () => {
      const start = performance.now();
      const result = buildStableConnectedLayout(
        connectedLayout,
        orderCache,
        groupOrderCache,
      );
      if (shouldProfileLayout()) {
        console.log(
          `[PERF] buildStableConnectedLayout: ${(performance.now() - start).toFixed(2)}ms (${connectedLayout.length} connected nodes)`,
        );
      }
      return result;
    },
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

    const groupsByKey = new Map<string, GraphNode[]>();
    standaloneLayout.forEach((ln) => {
      const type = ln.node.type || "service";
      // Separate Docker containers into their own group
      let key = ln.node.isDockerContainer ? `docker:${type}` : type;
      if (!ln.node.isDockerContainer && isRemoteAccessNode(ln.node)) {
        key = "remote-access";
      }
      const existing = groupsByKey.get(key) || [];
      existing.push(ln.node);
      groupsByKey.set(key, existing);
    });

    return Array.from(groupsByKey.entries())
      .sort((a, b) => {
        const aDocker = a[0].startsWith("docker:") ? 1 : 0;
        const bDocker = b[0].startsWith("docker:") ? 1 : 0;
        // Non-docker groups first, then docker groups
        if (aDocker !== bDocker) return aDocker - bDocker;
        const aType = a[0].replace("docker:", "");
        const bType = b[0].replace("docker:", "");
        const aPriorityType = aType === "remote-access" ? "client" : aType;
        const bPriorityType = bType === "remote-access" ? "client" : bType;
        const priorityDiff =
          getTypePriority(aPriorityType) - getTypePriority(bPriorityType);
        if (priorityDiff !== 0) return priorityDiff;
        return aType.localeCompare(bType);
      })
      .map(([key, nodes]) => {
        const isDocker = key.startsWith("docker:");
        const type = isDocker ? key.replace("docker:", "") : key;
        let groupName: string;
        if (isDocker) {
          groupName = "Docker Containers";
        } else if (type === "remote-access") {
          groupName = "Remote Access";
        } else if (type === "service") {
          groupName = "System Services";
        } else {
          groupName =
            SERVICE_COLORS[type]?.label ||
            type.charAt(0).toUpperCase() + type.slice(1);
        }
        return {
          groupName,
          nodes: nodes.sort((a, b) => a.name.localeCompare(b.name)),
          isGroup: isDocker || nodes.length > 1,
          groupType: type,
        };
      });
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
