import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { GraphNode } from "../../types/electron";

export interface KnownService {
  name: string;
  type: string;
  dismissed: boolean;
  addedManually: boolean;
}

export interface ServiceStatus {
  service: KnownService;
  running: boolean;
}

export interface ProjectStatus {
  running: number;
  total: number;
  services: ServiceStatus[];
}

interface Tab {
  id: string;
  label: string;
}

const STORAGE_PREFIX = "fere.knownServices.";
const SYSTEM_TAB_ID = "__system__";

function storageKey(tabId: string): string {
  return STORAGE_PREFIX + tabId;
}

function loadServices(tabId: string): KnownService[] {
  try {
    const raw = window.localStorage.getItem(storageKey(tabId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistServices(tabId: string, services: KnownService[]) {
  try {
    window.localStorage.setItem(storageKey(tabId), JSON.stringify(services));
  } catch {
    /* ignore */
  }
}

function serviceKey(name: string, type: string): string {
  return `${name}::${type}`;
}

type TabGrouping = "repo" | "subproject";

function getNodeTabPath(
  node: GraphNode,
  grouping: TabGrouping,
): string | null {
  if (!node.projectPath) return null;
  if (grouping === "repo") {
    return node.repoPath || node.projectPath;
  }
  return node.projectPath.replace(/\/services\/[^/]+$/, "");
}

function isNodeRunning(node: GraphNode): boolean {
  if (node.healthStatus === "red") return false;
  if (node.isDockerContainer && node.containerState !== "running") return false;
  return true;
}

export function useKnownServices(
  tabs: Tab[],
  nodes: GraphNode[],
  tabGrouping: TabGrouping,
) {
  // Map<tabId, KnownService[]>
  const [serviceMap, setServiceMap] = useState<Map<string, KnownService[]>>(
    () => {
      const map = new Map<string, KnownService[]>();
      tabs.forEach((tab) => {
        if (tab.id !== SYSTEM_TAB_ID) {
          map.set(tab.id, loadServices(tab.id));
        }
      });
      return map;
    },
  );

  // Load services for new tabs that appear
  const prevTabIdsRef = useRef(new Set(tabs.map((t) => t.id)));
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    let changed = false;
    const newMap = new Map(serviceMap);
    for (const tab of tabs) {
      if (tab.id === SYSTEM_TAB_ID) continue;
      if (!prevTabIdsRef.current.has(tab.id) && !newMap.has(tab.id)) {
        newMap.set(tab.id, loadServices(tab.id));
        changed = true;
      }
    }
    prevTabIdsRef.current = currentIds;
    if (changed) setServiceMap(newMap);
  }, [tabs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-learn: add new services from current nodes
  useEffect(() => {
    let changed = false;
    const newMap = new Map(serviceMap);

    for (const tab of tabs) {
      if (tab.id === SYSTEM_TAB_ID) continue;

      const tabNodes = nodes.filter(
        (n) => n.type !== "external" && getNodeTabPath(n, tabGrouping) === tab.id,
      );
      if (tabNodes.length === 0) continue;

      const existing = newMap.get(tab.id) || [];
      const existingKeys = new Set(
        existing.map((s) => serviceKey(s.name, s.type)),
      );

      let tabChanged = false;
      const updated = [...existing];

      for (const node of tabNodes) {
        const key = serviceKey(node.name, node.type);
        if (!existingKeys.has(key)) {
          updated.push({
            name: node.name,
            type: node.type,
            dismissed: false,
            addedManually: false,
          });
          existingKeys.add(key);
          tabChanged = true;
        }
      }

      if (tabChanged) {
        newMap.set(tab.id, updated);
        persistServices(tab.id, updated);
        changed = true;
      }
    }

    if (changed) setServiceMap(newMap);
  }, [nodes, tabs, tabGrouping]); // eslint-disable-line react-hooks/exhaustive-deps

  // Evaluate status for all tabs
  const statusCache = useMemo(() => {
    const cache = new Map<string, ProjectStatus>();

    serviceMap.forEach((services: KnownService[], tabId: string) => {
      const activeServices = services.filter(
        (s: KnownService) => !s.dismissed,
      );
      if (activeServices.length === 0) {
        cache.set(tabId, { running: 0, total: 0, services: [] });
        return;
      }

      const tabNodes = nodes.filter(
        (n) =>
          n.type !== "external" && getNodeTabPath(n, tabGrouping) === tabId,
      );

      const evaluated: ServiceStatus[] = activeServices.map(
        (svc: KnownService) => {
          const matchingNode = tabNodes.find(
            (n) => n.name === svc.name && n.type === svc.type,
          );
          return {
            service: svc,
            running: matchingNode ? isNodeRunning(matchingNode) : false,
          };
        },
      );

      cache.set(tabId, {
        running: evaluated.filter((e) => e.running).length,
        total: evaluated.length,
        services: evaluated,
      });
    });

    return cache;
  }, [serviceMap, nodes, tabGrouping]);

  const getProjectStatus = useCallback(
    (tabId: string): ProjectStatus => {
      return statusCache.get(tabId) || { running: 0, total: 0, services: [] };
    },
    [statusCache],
  );

  const getDismissedServices = useCallback(
    (tabId: string): KnownService[] => {
      const services = serviceMap.get(tabId) || [];
      return services.filter((s) => s.dismissed);
    },
    [serviceMap],
  );

  const dismissService = useCallback(
    (tabId: string, name: string, type: string) => {
      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        const key = serviceKey(name, type);
        const idx = services.findIndex(
          (s) => serviceKey(s.name, s.type) === key,
        );
        if (idx !== -1) {
          services[idx] = { ...services[idx], dismissed: true };
          newMap.set(tabId, services);
          persistServices(tabId, services);
        }
        return newMap;
      });
    },
    [],
  );

  const restoreService = useCallback(
    (tabId: string, name: string, type: string) => {
      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        const key = serviceKey(name, type);
        const idx = services.findIndex(
          (s) => serviceKey(s.name, s.type) === key,
        );
        if (idx !== -1) {
          services[idx] = { ...services[idx], dismissed: false };
          newMap.set(tabId, services);
          persistServices(tabId, services);
        }
        return newMap;
      });
    },
    [],
  );

  const addService = useCallback(
    (tabId: string, name: string, type: string) => {
      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        const key = serviceKey(name, type);
        if (services.some((s) => serviceKey(s.name, s.type) === key)) {
          // Already exists — just un-dismiss it
          const idx = services.findIndex(
            (s) => serviceKey(s.name, s.type) === key,
          );
          if (idx !== -1 && services[idx].dismissed) {
            services[idx] = { ...services[idx], dismissed: false };
            newMap.set(tabId, services);
            persistServices(tabId, services);
          }
          return newMap;
        }
        services.push({
          name,
          type,
          dismissed: false,
          addedManually: true,
        });
        newMap.set(tabId, services);
        persistServices(tabId, services);
        return newMap;
      });
    },
    [],
  );

  return {
    getProjectStatus,
    getDismissedServices,
    dismissService,
    restoreService,
    addService,
  };
}
