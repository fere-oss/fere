import React, { useSyncExternalStore, useState, useCallback, useMemo } from "react";
import type { GraphNode } from "../../types/electron";
import type { RenderGroup } from "./types";
import { getHealthInfo, getServiceColor, getTypeBadge } from "./constants";
import {
  externalApiCache,
  supportsExternalApiScan,
  subscribeExternalApiCacheUpdates,
} from "./externalApis";
import { BrandIcon, inferServiceBrand } from "./brandIcons";

// Hoisted to module level — avoids Set recreation on every ServiceNode render
const DOCKER_BADGE_TYPES = new Set(["container", "cache", "database", "broker"]);

function getRemoteAccessKind(node: GraphNode): "SSH" | "SFTP" | "SCP" | null {
  const source = `${node.name || ""} ${node.command || ""}`.toLowerCase();
  if (/(^|\s)sftp(\s|$)/.test(source)) return "SFTP";
  if (/(^|\s)scp(\s|$)/.test(source)) return "SCP";
  if (/(^|\s)(auto)?ssh(d)?(\s|$)/.test(source)) return "SSH";
  return null;
}

function getRemoteAccessTarget(node: GraphNode): string | null {
  if (node.remoteAccess?.host) {
    const userPrefix = node.remoteAccess.user
      ? `${node.remoteAccess.user}@`
      : "";
    const portSuffix = node.remoteAccess.port
      ? `:${node.remoteAccess.port}`
      : "";
    return `${userPrefix}${node.remoteAccess.host}${portSuffix}`;
  }

  const command = node.command || "";
  if (!command) return null;

  const match = command.match(
    /(?:^|\s)(?:sftp|scp|ssh|autossh)\s+(?:-[A-Za-z0-9-]+\s+)*(?:[^@\s]+@)?([A-Za-z0-9._-]+)(?::\S+)?/i,
  );
  if (!match?.[1]) return null;
  return match[1];
}

function getTunnelSummary(node: GraphNode): string | null {
  const tunnels = node.remoteAccess?.tunnels || [];
  if (tunnels.length === 0) return null;

  const summaries = tunnels.slice(0, 2).map((tunnel) => {
    if (tunnel.mode === "D") {
      return `D:${tunnel.listenPort ?? "?"}`;
    }
    const target = `${tunnel.targetHost ?? "?"}:${tunnel.targetPort ?? "?"}`;
    return `${tunnel.mode}:${tunnel.listenPort ?? "?"}->${target}`;
  });
  const extra = tunnels.length > 2 ? ` +${tunnels.length - 2}` : "";
  return `${summaries.join(", ")}${extra}`;
}

function getInboundSshSummary(node: GraphNode): string | null {
  const sessions = node.remoteAccess?.inboundSessions || 0;
  if (sessions <= 0) return null;
  const clients = node.remoteAccess?.inboundClients || [];
  if (clients.length === 0) {
    return `${sessions}`;
  }
  const preview = clients.slice(0, 2).join(", ");
  const extra = clients.length > 2 ? ` +${clients.length - 2}` : "";
  return `${sessions} (${preview}${extra})`;
}

function getRemoteHealthSummary(node: GraphNode): string | null {
  const notes = node.remoteAccess?.healthFlags?.notes || [];
  if (notes.length === 0) return null;
  return notes.join(", ");
}

export function CompactServiceNode({
  node,
  onClick,
  onContextMenu,
  animationIndex = 0,
}: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationIndex?: number;
}) {
  const healthInfo = getHealthInfo(node.healthStatus);
  const mainPort = node.ports[0]?.port;
  const remoteKind = getRemoteAccessKind(node);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(node);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, node);
  };

  return (
    <div
      data-node-id={node.id}
      className="compact-service-node"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={
        {
          animationDelay: `${animationIndex * 40}ms`,
        } as React.CSSProperties
      }
    >
      <div className="compact-node-header">
        <div className="compact-node-status">
          <div
            className="compact-node-health"
            style={{
              backgroundColor: healthInfo.color,
              boxShadow: healthInfo.glow,
            }}
          />
          <span
            className="compact-node-health-label"
            style={{ color: healthInfo.color }}
          >
            {healthInfo.label}
          </span>
        </div>
        <span className="compact-node-badge">
          {remoteKind || getTypeBadge(node.type)}
        </span>
      </div>

      <h4 className="compact-node-name">{node.name}</h4>

      {node.containerImage && (
        <div className="compact-node-image" title={node.containerImage}>
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <span>{node.containerImage.split("/").pop()?.split(":")[0]}</span>
        </div>
      )}

      {mainPort && (
        <div className="compact-node-port">
          <span className="compact-port-host">localhost</span>
          <span className="compact-port-number">:{mainPort}</span>
        </div>
      )}

      {node.containerNetworks && node.containerNetworks.length > 0 && (
        <div className="compact-node-networks">
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="2" y1="12" x2="22" y2="12" />
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
          </svg>
          <span className="compact-networks-list">
            {node.containerNetworks
              .slice(0, 2)
              .map((n) => n.name)
              .join(", ")}
            {node.containerNetworks.length > 2 &&
              ` +${node.containerNetworks.length - 2}`}
          </span>
        </div>
      )}
    </div>
  );
}

export function NodeGroupContainer({
  group,
  onNodeClick,
  onContextMenu,
  baseIndex = 0,
}: {
  group: RenderGroup;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  baseIndex?: number;
}) {
  if (!group.isGroup) {
    return (
      <ServiceNode
        node={group.nodes[0]}
        onClick={onNodeClick}
        onContextMenu={onContextMenu}
        animationIndex={baseIndex}
      />
    );
  }

  const groupCount = group.nodes.length;
  const columnCount = Math.max(2, Math.ceil(Math.sqrt(groupCount)));
  const groupStyle = {
    ["--group-columns" as string]: columnCount,
    ["--group-span" as string]: columnCount,
    animationDelay: `${baseIndex * 50}ms`,
  } as React.CSSProperties;

  return (
    <div className="node-group" style={groupStyle}>
      <div className="node-group-label">{group.groupName}</div>
      <div className="node-group-nodes">
        {group.nodes.map((node, idx) => (
          <ServiceNode
            key={node.id}
            node={node}
            onClick={onNodeClick}
            onContextMenu={onContextMenu}
            animationIndex={baseIndex + idx}
          />
        ))}
      </div>
    </div>
  );
}

export const ServiceNode = React.memo(function ServiceNode({
  node,
  onClick,
  onContextMenu,
  animationIndex = 0,
}: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationIndex?: number;
}) {
  const isGhost = !!node.isGhost;
  const isDownLike = isGhost || node.healthStatus === "red";
  const accentColor = getServiceColor(node.type);
  const healthInfo = isDownLike
    ? { color: "var(--text-muted)", glow: "none", label: "Not running" }
    : getHealthInfo(node.healthStatus);
  const showDockerBadge =
    node.isDockerContainer &&
    DOCKER_BADGE_TYPES.has((node.type || "").toLowerCase());
  const mainPort = node.ports[0]?.port;
  const remoteKind = getRemoteAccessKind(node);
  const remoteTarget = useMemo(
    () => getRemoteAccessTarget(node),
    [node],
  );
  const tunnelSummary = useMemo(
    () => getTunnelSummary(node),
    [node],
  );
  const inboundSshSummary = useMemo(
    () => getInboundSshSummary(node),
    [node],
  );
  const remoteHealthSummary = useMemo(
    () => getRemoteHealthSummary(node),
    [node],
  );
  const routes = useMemo(() => node.routes || [], [node.routes]);
  const visibleRoutes = useMemo(() => {
    if (routes.length <= 3) return routes;

    const routeMethodRank = (method: string): number => {
      switch (method.toUpperCase()) {
        case "DELETE": return 0;
        case "POST": return 1;
        case "PUT": return 2;
        case "PATCH": return 3;
        case "GET": return 4;
        default: return 5;
      }
    };

    const sorted = [...routes].sort((a, b) => {
      const methodDiff = routeMethodRank(a.method) - routeMethodRank(b.method);
      if (methodDiff !== 0) return methodDiff;
      return a.path.localeCompare(b.path);
    });

    const gets = sorted.filter((r) => r.method.toUpperCase() === "GET");
    const mutating = sorted.filter((r) => r.method.toUpperCase() !== "GET");
    const picked: typeof routes = [];
    const seen = new Set<string>();

    const pushUnique = (route: (typeof routes)[number] | undefined) => {
      if (!route) return;
      const key = `${route.method}:${route.path}`;
      if (seen.has(key)) return;
      seen.add(key);
      picked.push(route);
    };

    pushUnique(gets[0]);
    for (const route of mutating) {
      if (picked.length >= 3) break;
      pushUnique(route);
    }
    for (const route of sorted) {
      if (picked.length >= 3) break;
      pushUnique(route);
    }
    return picked;
  }, [routes]);
  const shouldShowApis = supportsExternalApiScan(node);
  // Subscribe to the external API cache via useSyncExternalStore so that
  // ServiceNode re-renders whenever the cache entry for this node changes,
  // without depending on ReactFlow's internal re-render propagation.
  const apiEntry = useSyncExternalStore(subscribeExternalApiCacheUpdates, () =>
    shouldShowApis && node.projectPath
      ? (externalApiCache.get(node.projectPath) ?? null)
      : null,
  );
  const externalApis = shouldShowApis ? apiEntry?.apis || [] : [];
  const visibleApis = externalApis.slice(0, 3);
  const apiCount = externalApis.length;
  const isApiLoading = shouldShowApis && !apiEntry;
  const projectLabel = useMemo(
    () => (node.projectPath ? node.projectPath.split("/").pop() : null),
    [node.projectPath],
  );
  // Container-type Docker nodes show the Docker logo by default — they are
  // generic containers without a specific recognized runtime brand.
  const serviceBrand =
    node.isDockerContainer && node.type === "container"
      ? "docker"
      : inferServiceBrand(node);

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(node);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, node);
  };

  const [starting, setStarting] = useState(false);
  const startCommand = node.startCommand || node.command || "";
  const startProjectPath = node.startProjectPath || node.projectPath || "";

  const handleStartService = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      if (starting) return;
      setStarting(true);
      let started = false;
      try {
        if (node.isDockerContainer) {
          const id = node.containerId || node.name;
          const result = await window.electronAPI.startContainer(id);
          started = !!result?.success;
        } else if (startCommand && startProjectPath) {
          const result = await window.electronAPI.startProcess(
            startCommand,
            startProjectPath,
          );
          started = !!result?.success;
        }
      } catch {
        // silently fail — snapshot will reflect actual state
      } finally {
        if (started) {
          window.dispatchEvent(new CustomEvent("fere:refresh-snapshot"));
        }
        setTimeout(() => setStarting(false), 3000);
      }
    },
    [node, startCommand, startProjectPath, starting],
  );

  const canStart =
    isDownLike &&
    (node.isDockerContainer || (startCommand && startProjectPath));

  return (
    <div
      data-node-id={node.id}
      className={`service-node${isDownLike ? " service-node-ghost" : ""}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={
        {
          "--node-color": accentColor,
          animationDelay: `${animationIndex * 50}ms`,
        } as React.CSSProperties
      }
    >
      <div className="service-node-header">
        <div className="service-node-status-row">
          <div
            className="service-node-health-dot"
            style={{
              backgroundColor: healthInfo.color,
              boxShadow: healthInfo.glow,
            }}
            title={healthInfo.label}
          />
          <span
            className="service-node-health-label"
            style={{ color: healthInfo.color }}
          >
            {healthInfo.label}
          </span>
          {showDockerBadge && (
            <span
              className="service-node-docker-badge"
              title="Docker Container"
            >
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
              </svg>
            </span>
          )}
        </div>
        <span
          className="service-node-badge"
          style={{
            backgroundColor: `${accentColor}15`,
            color: accentColor,
          }}
        >
          {remoteKind || getTypeBadge(node.type)}
        </span>
      </div>

      <h3 className="service-node-name">
        {serviceBrand && (
          <BrandIcon
            value={serviceBrand}
            className="service-node-brand-icon"
            size={15}
          />
        )}
        <span>{node.name}</span>
      </h3>
      {node.isDockerContainer && node.containerImage && (
        <div className="service-node-docker-image" title={node.containerImage}>
          {node.containerImage.split("/").pop()?.split(":")[0] ||
            node.containerImage}
        </div>
      )}
      {!node.isDockerContainer && projectLabel && (
        <div className="service-node-project">{projectLabel}</div>
      )}
      {!node.isDockerContainer && !projectLabel && remoteTarget && (
        <div className="service-node-port service-node-remote-target">
          <span className="service-node-port-host">remote</span>
          <span className="service-node-port-number" title={remoteTarget}>
            {remoteTarget}
          </span>
        </div>
      )}
      {!node.isDockerContainer && tunnelSummary && (
        <div className="service-node-remote-meta">
          <span className="service-node-remote-meta-label">Tunnel</span>
          <span className="service-node-remote-meta-value" title={tunnelSummary}>
            {tunnelSummary}
          </span>
        </div>
      )}
      {!node.isDockerContainer && inboundSshSummary && (
        <div className="service-node-remote-meta">
          <span className="service-node-remote-meta-label">Inbound</span>
          <span className="service-node-remote-meta-value" title={inboundSshSummary}>
            {inboundSshSummary}
          </span>
        </div>
      )}
      {!node.isDockerContainer && remoteHealthSummary && (
        <div className="service-node-remote-meta">
          <span className="service-node-remote-meta-label">Status</span>
          <span className="service-node-remote-meta-value" title={remoteHealthSummary}>
            {remoteHealthSummary}
          </span>
        </div>
      )}

      {canStart && (
        <button
          className="service-node-start-btn"
          onClick={handleStartService}
          disabled={starting}
        >
          {starting ? (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                className="service-node-start-spinner"
              >
                <path d="M8 1v3M8 12v3M1 8h3M12 8h3" strokeLinecap="round" />
              </svg>
              Starting...
            </>
          ) : (
            <>
              <svg
                width="12"
                height="12"
                viewBox="0 0 16 16"
                fill="currentColor"
              >
                <path d="M4 2l10 6-10 6V2z" />
              </svg>
              Start
            </>
          )}
        </button>
      )}

      {!isDownLike && mainPort && (
        <div className="service-node-port">
          <span className="service-node-port-host">localhost</span>
          <span
            className="service-node-port-number"
            style={{ color: accentColor }}
          >
            :{mainPort}
          </span>
        </div>
      )}

      {!isDownLike &&
        node.isDockerContainer &&
        node.containerNetworks &&
        node.containerNetworks.length > 0 && (
          <div className="service-node-docker-networks">
            <span className="service-node-docker-networks-label">
              Networks:
            </span>
            <span className="service-node-docker-networks-list">
              {node.containerNetworks
                .slice(0, 2)
                .map((n) => n.name)
                .join(", ")}
              {node.containerNetworks.length > 2 &&
                ` +${node.containerNetworks.length - 2}`}
            </span>
          </div>
        )}

      {!isDownLike && routes.length > 0 && (
        <div className="service-node-routes">
          <div className="service-node-routes-header">
            <span className="service-node-routes-title">API routes</span>
            <span className="service-node-routes-count">{routes.length}</span>
          </div>
          <div className="service-node-routes-list">
            {visibleRoutes.map((route) => (
              <div
                key={`${route.method}-${route.path}`}
                className="service-route"
              >
                <span
                  className={`route-method route-${route.method.toLowerCase()}`}
                >
                  {route.method}
                </span>
                <span className="route-path">{route.path}</span>
              </div>
            ))}
            {routes.length > visibleRoutes.length && (
              <div className="service-route-more">
                +{routes.length - visibleRoutes.length} more
              </div>
            )}
          </div>
        </div>
      )}

      {!isDownLike && shouldShowApis && (
        <div
          className={`service-node-apis${apiCount === 0 ? " is-empty" : ""}`}
        >
          <div className="service-node-apis-header">
            <span className="service-node-apis-title">External APIs</span>
            <span className="service-node-apis-count">
              {isApiLoading ? "…" : apiCount}
            </span>
          </div>
          <div className="service-node-apis-list">
            {apiCount === 0 ? (
              isApiLoading ? (
                <div className="service-api-loading" aria-hidden="true">
                  <span className="service-api-loading-dot" />
                  <span className="service-api-loading-line" />
                  <span className="service-api-loading-line service-api-loading-line-short" />
                </div>
              ) : (
                <div className="service-api-placeholder">
                  No external APIs detected
                </div>
              )
            ) : (
              <>
                {visibleApis.map((api) => (
                  <div key={api.name} className="service-api">
                    <BrandIcon value={api.name} size={12} />
                    <span>{api.name}</span>
                  </div>
                ))}
                {apiCount > visibleApis.length && (
                  <div className="service-api-more">
                    +{apiCount - visibleApis.length} more
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
