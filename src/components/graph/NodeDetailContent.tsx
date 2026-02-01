import { useEffect, useState } from 'react';
import type { GraphNode, GraphEdge, ExternalApi } from '../../types/electron';
import { DatabaseViewer } from '../DatabaseViewer';
import { ContainerLogsPanel } from '../ContainerLogsPanel';
import { getHealthInfo, getServiceColor } from './constants';
import { externalApiCache, EXTERNAL_API_CACHE_TTL_MS } from './externalApis';

interface NodeDetailContentProps {
  node: GraphNode;
  edges: GraphEdge[];
  allNodes: GraphNode[];
}

export function NodeDetailContent({ node, edges, allNodes }: NodeDetailContentProps) {
  const accentColor = getServiceColor(node.type);
  const healthInfo = getHealthInfo(node.healthStatus);
  const routes = node.routes || [];
  const [externalApis, setExternalApis] = useState<ExternalApi[]>([]);
  const [externalApiLoading, setExternalApiLoading] = useState(false);
  const [externalApiError, setExternalApiError] = useState<string | null>(null);

  const formatLastSeen = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 1000) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  };

  const incomingEdges = edges.filter(e => e.target === node.id);
  const outgoingEdges = edges.filter(e => e.source === node.id);
  const getNodeName = (id: string) => allNodes.find(n => n.id === id)?.name || id;

  useEffect(() => {
    let active = true;
    const projectPath = node.projectPath;

    if (!projectPath || node.isDockerContainer) {
      setExternalApis([]);
      setExternalApiLoading(false);
      setExternalApiError(null);
      return () => {
        active = false;
      };
    }

    const cached = externalApiCache.get(projectPath);
    if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) {
      setExternalApis(cached.apis);
      setExternalApiLoading(false);
      setExternalApiError(null);
      return () => {
        active = false;
      };
    }

    setExternalApiLoading(true);
    setExternalApiError(null);

    (async () => {
      try {
        if (!window.electronAPI?.getExternalApis) {
          throw new Error('External API scan unavailable');
        }
        const apis = await window.electronAPI.getExternalApis(projectPath);
        if (!active) return;
        externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
        setExternalApis(apis);
        setExternalApiLoading(false);
      } catch (error) {
        if (!active) return;
        setExternalApis([]);
        setExternalApiLoading(false);
        setExternalApiError(error instanceof Error ? error.message : 'Failed to load external APIs');
      }
    })();

    return () => {
      active = false;
    };
  }, [node.projectPath, node.isDockerContainer]);

  return (
    <div className="node-detail-content">
      <div className="node-detail-section">
        <h3 className="node-detail-section-title">Health Status</h3>
        <div className="node-detail-health">
          <div className="node-detail-health-indicator">
            <div
              className="node-detail-health-dot"
              style={{
                backgroundColor: healthInfo.color,
                boxShadow: healthInfo.glow,
              }}
            />
            <span
              className="node-detail-health-label"
              style={{ color: healthInfo.color }}
            >
              {healthInfo.label}
            </span>
          </div>
          <div className="node-detail-health-meta">
            <span className="node-detail-label">Last seen</span>
            <span className="node-detail-value">{formatLastSeen(node.lastSeen)}</span>
          </div>
        </div>
      </div>

      {node.description && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">About</h3>
          <p className="node-detail-description">{node.description}</p>
        </div>
      )}

      {!node.isDockerContainer && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">Process Information</h3>
          <div className="node-detail-grid">
            <div className="node-detail-item">
              <span className="node-detail-label">PID</span>
              <span className="node-detail-value mono">{node.pid}</span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">User</span>
              <span className="node-detail-value">{node.user}</span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">CPU</span>
              <span className="node-detail-value mono">{node.cpu.toFixed(1)}%</span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">Memory</span>
              <span className="node-detail-value mono">{node.memory.toFixed(1)}%</span>
            </div>
          </div>
        </div>
      )}

      {node.isDockerContainer && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" style={{ marginRight: '6px', verticalAlign: 'middle' }}>
              <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
            </svg>
            Container Information
          </h3>
          <div className="node-detail-grid">
            <div className="node-detail-item">
              <span className="node-detail-label">Container ID</span>
              <span className="node-detail-value mono">{node.containerId?.substring(0, 12)}</span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">State</span>
              <span className={`node-detail-value docker-state docker-state-${node.containerState}`}>
                {node.containerState}
              </span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">CPU</span>
              <span className="node-detail-value mono">{node.cpu.toFixed(1)}%</span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">Memory</span>
              <span className="node-detail-value mono">
                {node.memoryUsage || `${node.memory.toFixed(1)}%`}
              </span>
            </div>
          </div>
          <div className="node-detail-item full-width" style={{ marginTop: '8px' }}>
            <span className="node-detail-label">Image</span>
            <span className="node-detail-value mono small">{node.containerImage}</span>
          </div>
          {node.containerStatus && (
            <div className="node-detail-item full-width" style={{ marginTop: '4px' }}>
              <span className="node-detail-label">Status</span>
              <span className="node-detail-value small">{node.containerStatus}</span>
            </div>
          )}
        </div>
      )}

      {node.isDockerContainer && node.type === 'database' && node.containerId && node.containerImage && (
        <DatabaseViewer
          containerId={node.containerId}
          containerImage={node.containerImage}
        />
      )}

      {node.isDockerContainer && node.containerId && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">Container Logs</h3>
          <ContainerLogsPanel
            containerId={node.containerId}
            containerName={node.name}
          />
        </div>
      )}

      {node.isDockerContainer && node.containerHealth && node.containerHealth.status !== 'unknown' && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">Container Health</h3>
          <div className="node-detail-docker-health">
            <div className={`docker-health-status docker-health-${node.containerHealth.status}`}>
              {node.containerHealth.status}
            </div>
            {node.containerHealth.failingStreak !== undefined && node.containerHealth.failingStreak > 0 && (
              <div className="docker-health-failing">
                Failing streak: {node.containerHealth.failingStreak}
              </div>
            )}
            {node.containerHealth.checks && node.containerHealth.checks.length > 0 && (
              <div className="docker-health-checks">
                <span className="docker-health-checks-label">Recent checks:</span>
                {node.containerHealth.checks.map((check, idx) => (
                  <div key={idx} className={`docker-health-check ${check.exitCode === 0 ? 'success' : 'failure'}`}>
                    <span className="docker-health-check-code">Exit: {check.exitCode}</span>
                    {check.output && (
                      <span className="docker-health-check-output">{check.output.substring(0, 50)}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {node.isDockerContainer && node.containerNetworks && node.containerNetworks.length > 0 && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">
            Networks <span className="node-detail-count">{node.containerNetworks.length}</span>
          </h3>
          <div className="node-detail-docker-networks">
            {node.containerNetworks.map((network, idx) => (
              <div key={idx} className="docker-network-item">
                <div className="docker-network-name">{network.name}</div>
                <div className="docker-network-details">
                  {network.ipAddress && (
                    <span className="docker-network-ip">IP: {network.ipAddress}</span>
                  )}
                  {network.gateway && (
                    <span className="docker-network-gateway">Gateway: {network.gateway}</span>
                  )}
                </div>
                {network.aliases && network.aliases.length > 0 && (
                  <div className="docker-network-aliases">
                    Aliases: {network.aliases.join(', ')}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {node.isDockerContainer && node.containerMounts && node.containerMounts.length > 0 && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">
            Volumes & Mounts <span className="node-detail-count">{node.containerMounts.length}</span>
          </h3>
          <div className="node-detail-docker-mounts">
            {node.containerMounts.map((mount, idx) => (
              <div key={idx} className="docker-mount-item">
                <div className="docker-mount-header">
                  <span className={`docker-mount-type docker-mount-type-${mount.type}`}>
                    {mount.type}
                  </span>
                  {!mount.readWrite && (
                    <span className="docker-mount-readonly">read-only</span>
                  )}
                </div>
                <div className="docker-mount-paths">
                  <div className="docker-mount-source" title={mount.source}>
                    {mount.name || mount.source.split('/').slice(-2).join('/')}
                  </div>
                  <span className="docker-mount-arrow">→</span>
                  <div className="docker-mount-dest" title={mount.destination}>
                    {mount.destination}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {node.isDockerContainer && node.containerPorts && node.containerPorts.length > 0 && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">
            Container Ports <span className="node-detail-count">{node.containerPorts.length}</span>
          </h3>
          <div className="node-detail-docker-ports">
            {node.containerPorts.map((port, idx) => (
              <div key={idx} className="docker-port-item">
                {port.type === 'mapped' ? (
                  <>
                    <span className="docker-port-host">
                      {port.hostIp}:{port.hostPort}
                    </span>
                    <span className="docker-port-arrow">→</span>
                    <span className="docker-port-container">
                      {port.containerPort}/{port.protocol}
                    </span>
                  </>
                ) : (
                  <span className="docker-port-exposed">
                    {port.containerPort}/{port.protocol} (exposed)
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="node-detail-section">
        <h3 className="node-detail-section-title">Command</h3>
        <div className="node-detail-command">{node.command}</div>
      </div>

      {(node.project || node.projectPath) && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">Project</h3>
          <div className="node-detail-grid">
            {node.project && (
              <div className="node-detail-item full-width">
                <span className="node-detail-label">Name</span>
                <span className="node-detail-value">{node.project}</span>
              </div>
            )}
            {node.projectPath && (
              <div className="node-detail-item full-width">
                <span className="node-detail-label">Path</span>
                <span className="node-detail-value mono small">{node.projectPath}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {node.ports.length > 0 && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">
            Ports <span className="node-detail-count">{node.ports.length}</span>
          </h3>
          <div className="node-detail-ports">
            {node.ports.map((port, idx) => (
              <div key={idx} className="node-detail-port">
                <span className="node-detail-port-number" style={{ color: accentColor }}>
                  :{port.port}
                </span>
                <span className="node-detail-port-host">{port.host}</span>
                {port.description && (
                  <span className="node-detail-port-desc">{port.description}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {routes.length > 0 && (
        <div className="node-detail-section">
          <div className="node-detail-section-title-row">
            <h3 className="node-detail-section-title">
              API Routes <span className="node-detail-count">{routes.length}</span>
            </h3>
          </div>
          <div className="node-detail-routes">
            {routes.map((route, idx) => (
              <div key={idx} className="node-detail-route">
                <span className={`route-method route-${route.method.toLowerCase()}`}>
                  {route.method}
                </span>
                <span className="node-detail-route-path">{route.path}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {(externalApiLoading || externalApiError || externalApis.length > 0) && (
        <div className="node-detail-section">
          <div className="node-detail-section-title-row">
            <h3 className="node-detail-section-title">
              External APIs <span className="node-detail-count">{externalApis.length}</span>
            </h3>
            {externalApiLoading && <span className="node-detail-loading">Scanning...</span>}
          </div>
          {externalApiError ? (
            <div className="node-detail-error">{externalApiError}</div>
          ) : (
            <div className="node-detail-apis">
              {externalApis.map(api => (
                <div key={api.name} className="node-detail-api">
                  <span className="node-detail-api-name">{api.name}</span>
                  {api.hosts && api.hosts.length > 0 && (
                    <span className="node-detail-api-hosts">
                      {api.hosts.slice(0, 3).join(', ')}
                      {api.hosts.length > 3 && ` +${api.hosts.length - 3}`}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {(incomingEdges.length > 0 || outgoingEdges.length > 0) && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">Connections</h3>
          <div className="node-detail-connections">
            {incomingEdges.length > 0 && (
              <div className="node-detail-connection-group">
                <span className="node-detail-connection-label">Incoming</span>
                {incomingEdges.map((edge, idx) => (
                  <div key={idx} className="node-detail-connection">
                    <span className="connection-arrow">←</span>
                    <span className="connection-node">{getNodeName(edge.source)}</span>
                    <span className="connection-port">:{edge.sourcePort} → :{edge.targetPort}</span>
                  </div>
                ))}
              </div>
            )}
            {outgoingEdges.length > 0 && (
              <div className="node-detail-connection-group">
                <span className="node-detail-connection-label">Outgoing</span>
                {outgoingEdges.map((edge, idx) => (
                  <div key={idx} className="node-detail-connection">
                    <span className="connection-arrow">→</span>
                    <span className="connection-node">{getNodeName(edge.target)}</span>
                    <span className="connection-port">:{edge.sourcePort} → :{edge.targetPort}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
