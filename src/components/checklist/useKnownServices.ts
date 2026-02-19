import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { GraphNode } from "../../types/electron";

export interface KnownService {
  name: string;
  type: string;
  dismissed: boolean;
  addedManually: boolean;
  lastCommand?: string;
  projectPath?: string;
  isDockerContainer?: boolean;
  containerId?: string;
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
const REMOVED_PREFIX = "fere.removedServices.";
const SYSTEM_TAB_ID = "__system__";

function storageKey(tabId: string): string {
  return STORAGE_PREFIX + tabId;
}

function removedStorageKey(tabId: string): string {
  return REMOVED_PREFIX + tabId;
}

function loadRemovedKeys(tabId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(removedStorageKey(tabId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

function persistRemovedKeys(tabId: string, keys: Set<string>) {
  try {
    window.localStorage.setItem(
      removedStorageKey(tabId),
      JSON.stringify(Array.from(keys)),
    );
  } catch {
    /* ignore */
  }
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

// Legacy key format for backward-compatible removedKeys matching
function legacyServiceKey(name: string, type: string): string {
  return `${name}::${type}`;
}

export function serviceKey(svc: {
  name: string;
  type: string;
  containerId?: string;
  projectPath?: string;
  isDockerContainer?: boolean;
}): string {
  const base = `${svc.name}::${svc.type}`;
  if (svc.isDockerContainer && svc.containerId) return `${base}::c:${svc.containerId}`;
  if (svc.projectPath) return `${base}::p:${svc.projectPath}`;
  return base;
}

export function nodeServiceKey(node: GraphNode): string {
  return serviceKey({
    name: node.name,
    type: node.type,
    containerId: node.containerId || undefined,
    projectPath: node.projectPath || undefined,
    isDockerContainer: node.isDockerContainer || false,
  });
}

function looseServiceIdentity(service: {
  name: string;
  type: string;
  isDockerContainer?: boolean;
}) {
  return `${service.name}::${service.type}::${service.isDockerContainer ? "docker" : "native"}`;
}

function dedupeServices(services: KnownService[]): KnownService[] {
  const byLooseId = new Map<string, KnownService>();
  for (const service of services) {
    const key = looseServiceIdentity(service);
    const existing = byLooseId.get(key);
    if (!existing) {
      byLooseId.set(key, service);
      continue;
    }

    // Prefer active entries and entries with richer restart metadata.
    const preferCurrent =
      (!service.dismissed && existing.dismissed) ||
      (!existing.containerId && !!service.containerId) ||
      (!existing.lastCommand && !!service.lastCommand) ||
      (!existing.projectPath && !!service.projectPath);

    if (preferCurrent) {
      byLooseId.set(key, { ...existing, ...service, dismissed: existing.dismissed && service.dismissed });
    }
  }
  return Array.from(byLooseId.values());
}

function findServiceIndexByNode(services: KnownService[], node: GraphNode): number {
  const exactKey = nodeServiceKey(node);
  let idx = services.findIndex((s) => serviceKey(s) === exactKey);
  if (idx !== -1) return idx;
  idx = services.findIndex(
    (s) =>
      s.name === node.name &&
      s.type === node.type &&
      !!s.isDockerContainer === !!node.isDockerContainer,
  );
  return idx;
}

function matchesServiceNodeLoose(service: KnownService, node: GraphNode): boolean {
  return (
    service.name === node.name &&
    service.type === node.type &&
    !!service.isDockerContainer === !!node.isDockerContainer
  );
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
          map.set(tab.id, dedupeServices(loadServices(tab.id)));
        }
      });
      return map;
    },
  );

  // Track permanently removed service keys so auto-learn doesn't re-add them
  const [removedKeys] = useState(() => {
    const map = new Map<string, Set<string>>();
    tabs.forEach((tab) => {
      if (tab.id !== SYSTEM_TAB_ID) {
        const keys = loadRemovedKeys(tab.id);
        if (keys.size > 0) map.set(tab.id, keys);
      }
    });
    return map;
  });

  // Load services for new tabs that appear
  const prevTabIdsRef = useRef(new Set(tabs.map((t) => t.id)));
  useEffect(() => {
    const currentIds = new Set(tabs.map((t) => t.id));
    const prevIds = prevTabIdsRef.current;
    prevTabIdsRef.current = currentIds;

    const newTabIds: string[] = [];
    for (const tab of tabs) {
      if (tab.id === SYSTEM_TAB_ID) continue;
      if (!prevIds.has(tab.id)) {
        newTabIds.push(tab.id);
      }
    }
    if (newTabIds.length === 0) return;

    // Load removed keys for new tabs so the blocklist is available
    for (const id of newTabIds) {
      if (!removedKeys.has(id)) {
        const keys = loadRemovedKeys(id);
        if (keys.size > 0) removedKeys.set(id, keys);
      }
    }

    setServiceMap((prev) => {
      const newMap = new Map(prev);
      let changed = false;
      for (const id of newTabIds) {
        if (!newMap.has(id)) {
          newMap.set(id, dedupeServices(loadServices(id)));
          changed = true;
        }
      }
      return changed ? newMap : prev;
    });
  }, [tabs, removedKeys]);

  // Auto-learn: add new services from current nodes
  useEffect(() => {
    setServiceMap((prev) => {
      let changed = false;
      const newMap = new Map(prev);

      for (const tab of tabs) {
        if (tab.id === SYSTEM_TAB_ID) continue;

        const tabNodes = nodes.filter(
          (n) => n.type !== "external" && getNodeTabPath(n, tabGrouping) === tab.id,
        );
        if (tabNodes.length === 0) continue;

        const existing = newMap.get(tab.id) || [];
        const existingKeys = new Set(existing.map((s) => serviceKey(s)));

        let tabChanged = false;
        const updated = [...existing];

        const tabRemoved = removedKeys.get(tab.id);

        for (const node of tabNodes) {
          const key = nodeServiceKey(node);
          const legacy = legacyServiceKey(node.name, node.type);
          const idx = findServiceIndexByNode(updated, node);

          if (idx === -1) {
            if (!existingKeys.has(key) && (!tabRemoved || (!tabRemoved.has(key) && !tabRemoved.has(legacy)))) {
              updated.push({
                name: node.name,
                type: node.type,
                dismissed: false,
                addedManually: false,
                lastCommand: node.command || undefined,
                projectPath: node.projectPath || undefined,
                isDockerContainer: node.isDockerContainer || false,
                containerId: node.containerId || undefined,
              });
              existingKeys.add(key);
              tabChanged = true;
            }
            continue;
          }

          const prev = updated[idx];
          if (
            prev.containerId !== (node.containerId || undefined) ||
            prev.lastCommand !== (node.command || undefined) ||
            prev.projectPath !== (node.projectPath || undefined) ||
            prev.isDockerContainer !== (node.isDockerContainer || false)
          ) {
            updated[idx] = {
              ...prev,
              containerId: node.containerId || undefined,
              lastCommand: node.command || undefined,
              projectPath: node.projectPath || undefined,
              isDockerContainer: node.isDockerContainer || false,
            };
            tabChanged = true;
          }
        }

        const deduped = dedupeServices(updated);
        if (deduped.length !== updated.length) {
          tabChanged = true;
        }

        if (tabChanged) {
          newMap.set(tab.id, deduped);
          persistServices(tab.id, deduped);
          changed = true;
        }
      }

      return changed ? newMap : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- removedKeys is a mutated Map ref, not React state; its identity never changes
  }, [nodes, tabs, tabGrouping]);

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
          const svcKey = serviceKey(svc);
          const matchingNode = tabNodes.find((n) => nodeServiceKey(n) === svcKey)
            || tabNodes.find((n) => matchesServiceNodeLoose(svc, n));
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
    (tabId: string, key: string) => {
      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        const idx = services.findIndex(
          (s) => serviceKey(s) === key,
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
    (tabId: string, key: string) => {
      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        const idx = services.findIndex(
          (s) => serviceKey(s) === key,
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
    (tabId: string, node: {
      name: string;
      type: string;
      containerId?: string;
      projectPath?: string;
      isDockerContainer?: boolean;
      command?: string;
    }) => {
      const key = serviceKey(node);

      // Remove from blocklist if it was previously permanently removed
      const tabRemoved = removedKeys.get(tabId);
      if (tabRemoved) {
        let blocklist_changed = false;
        if (tabRemoved.delete(key)) blocklist_changed = true;
        // Also clear legacy-format key for backward compat
        const legacy = legacyServiceKey(node.name, node.type);
        if (tabRemoved.delete(legacy)) blocklist_changed = true;
        if (blocklist_changed) persistRemovedKeys(tabId, tabRemoved);
      }

      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        if (services.some((s) => serviceKey(s) === key)) {
          // Already exists — just un-dismiss it
          const idx = services.findIndex(
            (s) => serviceKey(s) === key,
          );
          if (idx !== -1 && services[idx].dismissed) {
            services[idx] = { ...services[idx], dismissed: false };
            newMap.set(tabId, services);
            persistServices(tabId, services);
          }
          return newMap;
        }
        services.push({
          name: node.name,
          type: node.type,
          dismissed: false,
          addedManually: true,
          projectPath: node.projectPath,
          containerId: node.containerId,
          isDockerContainer: node.isDockerContainer || false,
          lastCommand: node.command,
        });
        newMap.set(tabId, services);
        persistServices(tabId, services);
        return newMap;
      });
    },
    [removedKeys],
  );

  const removeService = useCallback(
    (tabId: string, key: string) => {
      // Add to removed blocklist so auto-learn won't re-add
      const tabRemoved = removedKeys.get(tabId) || new Set<string>();
      tabRemoved.add(key);
      removedKeys.set(tabId, tabRemoved);
      persistRemovedKeys(tabId, tabRemoved);

      setServiceMap((prev) => {
        const newMap = new Map(prev);
        const services = [...(newMap.get(tabId) || [])];
        const filtered = services.filter(
          (s) => serviceKey(s) !== key,
        );
        if (filtered.length !== services.length) {
          newMap.set(tabId, filtered);
          persistServices(tabId, filtered);
        }
        return newMap;
      });
    },
    [removedKeys],
  );

  return {
    getProjectStatus,
    getDismissedServices,
    dismissService,
    restoreService,
    addService,
    removeService,
  };
}
