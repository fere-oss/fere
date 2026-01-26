import { useState, useMemo, useCallback } from 'react';
import type { GraphNode, ApiRoute, HttpResponse } from '../types/electron';

interface CurlBuilderProps {
  nodes: GraphNode[];
}

interface Header {
  key: string;
  value: string;
  enabled: boolean;
}

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';
type OutputTab = 'curl' | 'response';

const DEFAULT_HEADERS: Header[] = [
  { key: 'Content-Type', value: 'application/json', enabled: true },
  { key: 'Accept', value: 'application/json', enabled: true },
  { key: 'Authorization', value: 'Bearer ', enabled: false },
];

export function CurlBuilder({ nodes }: CurlBuilderProps) {
  // State for request configuration
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(-1);
  const [method, setMethod] = useState<HttpMethod>('GET');
  const [customPath, setCustomPath] = useState<string>('');
  const [headers, setHeaders] = useState<Header[]>(DEFAULT_HEADERS);
  const [body, setBody] = useState<string>('');
  const [copied, setCopied] = useState(false);

  // State for request execution
  const [outputTab, setOutputTab] = useState<OutputTab>('curl');
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  // Get nodes that have ports (can receive HTTP requests)
  const httpNodes = useMemo(() => {
    return nodes.filter(node =>
      node.type !== 'external' &&
      node.ports.length > 0
    );
  }, [nodes]);

  // Get selected node
  const selectedNode = useMemo(() => {
    return httpNodes.find(n => n.id === selectedNodeId);
  }, [httpNodes, selectedNodeId]);

  // Get routes for selected node
  const routes: ApiRoute[] = useMemo(() => {
    return selectedNode?.routes || [];
  }, [selectedNode]);

  // Get base URL for selected node
  const baseUrl = useMemo(() => {
    if (!selectedNode || selectedNode.ports.length === 0) return '';
    const port = selectedNode.ports[0];
    const host = port.host === '0.0.0.0' || port.host === '*' ? 'localhost' : port.host;
    return `http://${host}:${port.port}`;
  }, [selectedNode]);

  // Get current path (from route or custom)
  const currentPath = useMemo(() => {
    if (selectedRouteIndex >= 0 && routes[selectedRouteIndex]) {
      return routes[selectedRouteIndex].path;
    }
    return customPath || '/';
  }, [selectedRouteIndex, routes, customPath]);

  // Full URL
  const fullUrl = useMemo(() => {
    if (!baseUrl) return '';
    return `${baseUrl}${currentPath}`;
  }, [baseUrl, currentPath]);

  // Generate curl command
  const curlCommand = useMemo(() => {
    if (!fullUrl) return '';

    const parts: string[] = ['curl'];

    // Method (only add -X if not GET)
    if (method !== 'GET') {
      parts.push(`-X ${method}`);
    }

    // URL
    parts.push(`'${fullUrl}'`);

    // Headers
    headers.filter(h => h.enabled && h.key && h.value).forEach(h => {
      parts.push(`-H '${h.key}: ${h.value}'`);
    });

    // Body (for POST, PUT, PATCH)
    if (['POST', 'PUT', 'PATCH'].includes(method) && body.trim()) {
      // Escape single quotes in the body
      const escapedBody = body.replace(/'/g, "'\\''");
      parts.push(`-d '${escapedBody}'`);
    }

    // Format with line breaks for readability
    if (parts.length > 3) {
      return parts.join(' \\\n  ');
    }
    return parts.join(' ');
  }, [fullUrl, method, headers, body]);

  // Handle node selection
  const handleNodeSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedRouteIndex(-1);
    setCustomPath('');
    setResponse(null);
    setRequestError(null);
  }, []);

  // Handle route selection
  const handleRouteSelect = useCallback((index: number) => {
    setSelectedRouteIndex(index);
    if (index >= 0 && routes[index]) {
      const routeMethod = routes[index].method.toUpperCase();
      // "ALL" means the route accepts any method - default to GET
      setMethod(routeMethod === 'ALL' ? 'GET' : routeMethod as HttpMethod);
    }
    setResponse(null);
    setRequestError(null);
  }, [routes]);

  // Handle header changes
  const updateHeader = useCallback((index: number, field: keyof Header, value: string | boolean) => {
    setHeaders(prev => {
      const newHeaders = [...prev];
      newHeaders[index] = { ...newHeaders[index], [field]: value };
      return newHeaders;
    });
  }, []);

  const addHeader = useCallback(() => {
    setHeaders(prev => [...prev, { key: '', value: '', enabled: true }]);
  }, []);

  const removeHeader = useCallback((index: number) => {
    setHeaders(prev => prev.filter((_, i) => i !== index));
  }, []);

  // Copy to clipboard
  const copyToClipboard = useCallback(async () => {
    if (!curlCommand) return;
    try {
      await navigator.clipboard.writeText(curlCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, [curlCommand]);

  // Execute the HTTP request
  const executeRequest = useCallback(async () => {
    if (!fullUrl) return;

    setIsLoading(true);
    setResponse(null);
    setRequestError(null);
    setOutputTab('response');

    try {
      // Build headers object
      const headerObj: Record<string, string> = {};
      headers.filter(h => h.enabled && h.key && h.value).forEach(h => {
        headerObj[h.key] = h.value;
      });

      const result = await window.electronAPI.executeHttpRequest({
        method,
        url: fullUrl,
        headers: headerObj,
        body: ['POST', 'PUT', 'PATCH'].includes(method) ? body : undefined,
      });

      if (result.success && result.response) {
        setResponse(result.response);
      } else {
        setRequestError(result.error || 'Unknown error');
      }
    } catch (err) {
      setRequestError(err instanceof Error ? err.message : 'Failed to execute request');
    } finally {
      setIsLoading(false);
    }
  }, [fullUrl, method, headers, body]);

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Get status color
  const getStatusColor = (status: number): string => {
    if (status >= 200 && status < 300) return '#22c55e';
    if (status >= 300 && status < 400) return '#eab308';
    if (status >= 400 && status < 500) return '#f97316';
    return '#ef4444';
  };

  return (
    <div className="curl-builder">
      <div className="curl-builder-content">
        {/* Left Panel - Configuration */}
        <div className="curl-config-panel">
          {/* Service Selector */}
          <div className="curl-section">
            <label className="curl-section-title">Service</label>
            <select
              className="curl-select"
              value={selectedNodeId}
              onChange={(e) => handleNodeSelect(e.target.value)}
            >
              <option value="">Select a service...</option>
              {httpNodes.map(node => (
                <option key={node.id} value={node.id}>
                  {node.name} ({node.ports.map(p => p.port).join(', ')})
                </option>
              ))}
            </select>
          </div>

          {/* Route Selector */}
          {selectedNode && (
            <div className="curl-section">
              <label className="curl-section-title">
                Route
                {routes.length > 0 && (
                  <span className="curl-section-count">{routes.length} discovered</span>
                )}
              </label>
              {routes.length > 0 ? (
                <div className="curl-routes-list">
                  <button
                    className={`curl-route-option ${selectedRouteIndex === -1 ? 'selected' : ''}`}
                    onClick={() => handleRouteSelect(-1)}
                  >
                    <span className="route-method route-custom">CUSTOM</span>
                    <span className="route-path">Custom path</span>
                  </button>
                  {routes.map((route, index) => (
                    <button
                      key={index}
                      className={`curl-route-option ${selectedRouteIndex === index ? 'selected' : ''}`}
                      onClick={() => handleRouteSelect(index)}
                    >
                      <span className={`route-method route-${route.method.toLowerCase()}`}>
                        {route.method}
                      </span>
                      <span className="route-path">{route.path}</span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="curl-no-routes">
                  No routes discovered for this service
                </div>
              )}
            </div>
          )}

          {/* Method & Path */}
          {selectedNode && (
            <div className="curl-section">
              <label className="curl-section-title">Request</label>
              <div className="curl-request-row">
                <select
                  className="curl-method-select"
                  value={method}
                  onChange={(e) => setMethod(e.target.value as HttpMethod)}
                  disabled={selectedRouteIndex >= 0 && routes[selectedRouteIndex]?.method !== 'ALL'}
                  title={selectedRouteIndex >= 0 && routes[selectedRouteIndex]?.method !== 'ALL'
                    ? `This route only supports ${routes[selectedRouteIndex]?.method}`
                    : undefined}
                >
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="PATCH">PATCH</option>
                  <option value="DELETE">DELETE</option>
                  <option value="HEAD">HEAD</option>
                  <option value="OPTIONS">OPTIONS</option>
                </select>
                <input
                  type="text"
                  className="curl-path-input"
                  placeholder="/api/endpoint"
                  value={selectedRouteIndex === -1 ? customPath : currentPath}
                  onChange={(e) => {
                    if (selectedRouteIndex === -1) {
                      setCustomPath(e.target.value);
                    }
                  }}
                  readOnly={selectedRouteIndex !== -1}
                />
              </div>
              <div className="curl-url-preview">
                {fullUrl || 'Select a service to build URL'}
              </div>
            </div>
          )}

          {/* Headers */}
          {selectedNode && (
            <div className="curl-section">
              <div className="curl-section-header">
                <label className="curl-section-title">Headers</label>
                <button className="curl-add-btn" onClick={addHeader}>+ Add</button>
              </div>
              <div className="curl-headers-list">
                {headers.map((header, index) => (
                  <div key={index} className="curl-header-row">
                    <input
                      type="checkbox"
                      checked={header.enabled}
                      onChange={(e) => updateHeader(index, 'enabled', e.target.checked)}
                      className="curl-header-checkbox"
                    />
                    <input
                      type="text"
                      placeholder="Header name"
                      value={header.key}
                      onChange={(e) => updateHeader(index, 'key', e.target.value)}
                      className="curl-header-key"
                    />
                    <input
                      type="text"
                      placeholder="Value"
                      value={header.value}
                      onChange={(e) => updateHeader(index, 'value', e.target.value)}
                      className="curl-header-value"
                    />
                    <button
                      className="curl-remove-btn"
                      onClick={() => removeHeader(index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Body */}
          {selectedNode && ['POST', 'PUT', 'PATCH'].includes(method) && (
            <div className="curl-section">
              <label className="curl-section-title">Request Body</label>
              <textarea
                className="curl-body-input"
                placeholder='{"key": "value"}'
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={6}
              />
            </div>
          )}

          {/* Run Button */}
          {selectedNode && (
            <button
              className={`curl-run-btn ${isLoading ? 'loading' : ''}`}
              onClick={executeRequest}
              disabled={!fullUrl || isLoading}
            >
              {isLoading ? (
                <>
                  <span className="curl-run-spinner" />
                  Sending...
                </>
              ) : (
                <>
                  <span className="curl-run-icon">▶</span>
                  Send Request
                </>
              )}
            </button>
          )}
        </div>

        {/* Right Panel - Output */}
        <div className="curl-output-panel">
          {/* Output Tabs */}
          <div className="curl-output-tabs">
            <button
              className={`curl-output-tab ${outputTab === 'curl' ? 'active' : ''}`}
              onClick={() => setOutputTab('curl')}
            >
              cURL
            </button>
            <button
              className={`curl-output-tab ${outputTab === 'response' ? 'active' : ''}`}
              onClick={() => setOutputTab('response')}
            >
              Response
              {response && (
                <span
                  className="curl-status-badge"
                  style={{ background: getStatusColor(response.status) }}
                >
                  {response.status}
                </span>
              )}
            </button>
            <div className="curl-output-tabs-spacer" />
            {outputTab === 'curl' && (
              <button
                className={`curl-copy-btn ${copied ? 'copied' : ''}`}
                onClick={copyToClipboard}
                disabled={!curlCommand}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
            )}
          </div>

          {/* Output Content */}
          <div className="curl-output-content">
            {outputTab === 'curl' ? (
              <div className="curl-output-code">
                {curlCommand || (
                  <span className="curl-placeholder">
                    Select a service and configure your request to generate a curl command
                  </span>
                )}
              </div>
            ) : (
              <div className="curl-response-panel">
                {isLoading ? (
                  <div className="curl-response-loading">
                    <span className="curl-loading-spinner" />
                    <span>Sending request...</span>
                  </div>
                ) : requestError ? (
                  <div className="curl-response-error">
                    <span className="curl-error-icon">⚠</span>
                    <span className="curl-error-title">Request Failed</span>
                    <span className="curl-error-message">{requestError}</span>
                  </div>
                ) : response ? (
                  <>
                    {/* Response Status Bar */}
                    <div className="curl-response-status">
                      <span
                        className="curl-status-code"
                        style={{ color: getStatusColor(response.status) }}
                      >
                        {response.status} {response.statusText}
                      </span>
                      <span className="curl-response-meta">
                        <span className="curl-meta-item">{response.duration}ms</span>
                        <span className="curl-meta-item">{formatBytes(response.size)}</span>
                      </span>
                    </div>

                    {/* Response Headers (collapsible) */}
                    <details className="curl-response-headers">
                      <summary>
                        Headers ({Object.keys(response.headers).length})
                      </summary>
                      <div className="curl-headers-content">
                        {Object.entries(response.headers).map(([key, value]) => (
                          <div key={key} className="curl-header-item">
                            <span className="curl-header-name">{key}:</span>
                            <span className="curl-header-val">{String(value)}</span>
                          </div>
                        ))}
                      </div>
                    </details>

                    {/* Response Body */}
                    <div className="curl-response-body">
                      <div className="curl-response-body-header">
                        Body
                        {response.isJson && <span className="curl-json-badge">JSON</span>}
                      </div>
                      <pre className="curl-response-body-content">
                        {response.body || '(empty response)'}
                      </pre>
                    </div>
                  </>
                ) : (
                  <div className="curl-response-empty">
                    <span className="curl-empty-icon">↗</span>
                    <span>Send a request to see the response</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Empty State */}
      {httpNodes.length === 0 && (
        <div className="curl-empty-state">
          <p>No services with HTTP ports found</p>
          <span>Start a local development server to see it here</span>
        </div>
      )}
    </div>
  );
}
