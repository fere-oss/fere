import { useEffect, useState, useMemo, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import type { GraphNode, GraphEdge, ExternalApi } from '../../types/electron';
import { DatabaseViewer } from '../DatabaseViewer';
import { getHealthInfo, getServiceColor } from './constants';
import {
  externalApiCache,
  EXTERNAL_API_CACHE_TTL_MS,
  setExternalApiCacheEntry,
  supportsExternalApiScan,
} from './externalApis';
import { BrandIcon } from './brandIcons';

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
  const [serviceExplanation, setServiceExplanation] = useState<string | null>(null);
  const [serviceExplanationLoading, setServiceExplanationLoading] = useState(false);
  const [serviceExplanationError, setServiceExplanationError] = useState<string | null>(null);

  const formatLastSeen = (timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    if (diff < 1000) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return new Date(timestamp).toLocaleTimeString();
  };

  const incomingEdges = useMemo(() => edges.filter(e => e.target === node.id), [edges, node.id]);
  const outgoingEdges = useMemo(() => edges.filter(e => e.source === node.id), [edges, node.id]);
  const nodeNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of allNodes) map.set(n.id, n.name);
    return map;
  }, [allNodes]);
  const getNodeName = useCallback((id: string) => nodeNameMap.get(id) || id, [nodeNameMap]);
  const shouldShowExternalApis = supportsExternalApiScan(node);
  const remoteAccess = node.remoteAccess;

  useEffect(() => {
    let active = true;
    const projectPath = node.projectPath;

    if (!projectPath || !shouldShowExternalApis) {
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
        setExternalApiCacheEntry(projectPath, apis);
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
  }, [node.projectPath, shouldShowExternalApis]);

  useEffect(() => {
    setServiceExplanation(null);
    setServiceExplanationError(null);
    setServiceExplanationLoading(false);
  }, [node.id]);

  const handleExplainService = useCallback(async () => {
    setServiceExplanationLoading(true);
    setServiceExplanationError(null);
    const result = await window.electronAPI.explainService({
      serviceId: node.id,
      serviceName: node.name,
    });
    if (!result.success) {
      setServiceExplanationError(result.error || 'Failed to explain service');
      setServiceExplanationLoading(false);
      return;
    }
    setServiceExplanation(result.explanation || '');
    setServiceExplanationLoading(false);
  }, [node.id, node.name]);

  const handleDiagnoseService = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('fere:debug-diagnose-service', {
        detail: {
          nodeId: node.id,
          serviceName: node.name,
        },
      }),
    );
  }, [node.id, node.name]);

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

      <div className="node-detail-section">
        <div className="node-detail-section-title-row">
          <h3 className="node-detail-section-title">AI Tools</h3>
        </div>
        <div className="node-detail-actions-card">
          <button
            type="button"
            className="node-detail-ai-button"
            onClick={handleExplainService}
            disabled={serviceExplanationLoading}
          >
            <span className="node-detail-ai-button-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M8 2.5L9.3 6.1L12.9 7.4L9.3 8.7L8 12.3L6.7 8.7L3.1 7.4L6.7 6.1L8 2.5Z" />
              </svg>
            </span>
            {serviceExplanationLoading
              ? 'Explaining...'
              : serviceExplanation
                ? 'Refresh explain'
                : 'Explain service'}
          </button>
          <button
            type="button"
            className="node-detail-ai-button node-detail-ai-button-secondary"
            onClick={handleDiagnoseService}
          >
            <span className="node-detail-ai-button-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8H11" />
                <path d="M8.5 4.8L11.7 8L8.5 11.2" />
              </svg>
            </span>
            Diagnose service
          </button>
        </div>
      </div>

      {(node.description || serviceExplanation || serviceExplanationError) && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">About</h3>
          {serviceExplanationError ? (
            <div className="node-detail-error">{serviceExplanationError}</div>
          ) : serviceExplanation ? (
            <div className="node-detail-ai-copy">
              <ReactMarkdown>{serviceExplanation}</ReactMarkdown>
            </div>
          ) : node.description ? (
            <p className="node-detail-description">{node.description}</p>
          ) : (
            <div className="node-detail-ai-placeholder">
              Generate a concise explanation of how this service fits into the current stack.
            </div>
          )}
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

      {!node.isDockerContainer && remoteAccess && (
        <div className="node-detail-section">
          <h3 className="node-detail-section-title">Remote Session</h3>
          <div className="node-detail-grid">
            <div className="node-detail-item">
              <span className="node-detail-label">Tool</span>
              <span className="node-detail-value mono">{remoteAccess.tool.toUpperCase()}</span>
            </div>
            <div className="node-detail-item">
              <span className="node-detail-label">Source</span>
              <span className="node-detail-value">{remoteAccess.source}</span>
            </div>
            {remoteAccess.alias && (
              <div className="node-detail-item">
                <span className="node-detail-label">Alias</span>
                <span className="node-detail-value mono">{remoteAccess.alias}</span>
              </div>
            )}
            {remoteAccess.user && (
              <div className="node-detail-item">
                <span className="node-detail-label">Remote User</span>
                <span className="node-detail-value mono">{remoteAccess.user}</span>
              </div>
            )}
            {remoteAccess.host && (
              <div className="node-detail-item full-width">
                <span className="node-detail-label">Remote Host</span>
                <span className="node-detail-value mono small">{remoteAccess.host}</span>
              </div>
            )}
            {remoteAccess.port && (
              <div className="node-detail-item">
                <span className="node-detail-label">Remote Port</span>
                <span className="node-detail-value mono">:{remoteAccess.port}</span>
              </div>
            )}
            {remoteAccess.startTime && (
              <div className="node-detail-item">
                <span className="node-detail-label">Process Start</span>
                <span className="node-detail-value mono">{remoteAccess.startTime}</span>
              </div>
            )}
            {!!remoteAccess.inboundSessions && (
              <div className="node-detail-item">
                <span className="node-detail-label">Inbound Sessions</span>
                <span className="node-detail-value mono">{remoteAccess.inboundSessions}</span>
              </div>
            )}
          </div>

          {remoteAccess.tunnels && remoteAccess.tunnels.length > 0 && (
            <div className="node-detail-remote-list">
              <div className="node-detail-label">Tunnels</div>
              {remoteAccess.tunnels.map((tunnel, idx) => (
                <div key={`${tunnel.mode}-${idx}`} className="node-detail-remote-row">
                  <span className="node-detail-remote-mode">{tunnel.mode}</span>
                  {tunnel.mode === 'D' ? (
                    <span className="node-detail-value mono">
                      {tunnel.listenHost ? `${tunnel.listenHost}:` : ''}{tunnel.listenPort ?? '?'}
                    </span>
                  ) : (
                    <span className="node-detail-value mono small">
                      {tunnel.listenHost ? `${tunnel.listenHost}:` : ''}{tunnel.listenPort ?? '?'} -&gt; {tunnel.targetHost ?? '?'}:{tunnel.targetPort ?? '?'}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {remoteAccess.inboundClients && remoteAccess.inboundClients.length > 0 && (
            <div className="node-detail-remote-list">
              <div className="node-detail-label">Inbound Clients</div>
              {remoteAccess.inboundClients.map((client) => (
                <div key={client} className="node-detail-remote-row">
                  <span className="node-detail-value mono small">{client}</span>
                </div>
              ))}
            </div>
          )}

          {remoteAccess.healthFlags && remoteAccess.healthFlags.notes.length > 0 && (
            <div className="node-detail-remote-list">
              <div className="node-detail-label">Session Status</div>
              {remoteAccess.healthFlags.notes.map((note, idx) => (
                <div key={`${note}-${idx}`} className="node-detail-remote-row">
                  <span className="node-detail-value">{note}</span>
                </div>
              ))}
            </div>
          )}
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

      {shouldShowExternalApis && (externalApiLoading || externalApiError || externalApis.length > 0) && (
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
                  <span className="node-detail-api-name">
                    <BrandIcon value={api.name} size={13} />
                    <span>{api.name}</span>
                  </span>
                  {api.hosts && api.hosts.length > 0 && !(
                    api.kind === 'host' &&
                    api.hosts.length === 1 &&
                    api.hosts[0].toLowerCase() === api.name.toLowerCase()
                  ) && (
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
