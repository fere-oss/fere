import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type {
  GraphNode,
  ApiRoute,
  HttpResponse,
  HistoryEntry,
} from "../types/electron";

interface CurlBuilderProps {
  nodes: GraphNode[];
}

interface Header {
  key: string;
  value: string;
  enabled: boolean;
}

type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";
type OutputTab = "curl" | "response" | "history";

const DEFAULT_HEADERS: Header[] = [
  { key: "Content-Type", value: "application/json", enabled: true },
  { key: "Accept", value: "application/json", enabled: true },
  { key: "Authorization", value: "Bearer ", enabled: false },
];

// Syntax highlight a curl command for display
function highlightCurl(curlStr: string): React.ReactNode {
  if (!curlStr) return null;

  const lines = curlStr.split("\n");
  const elements: React.ReactNode[] = [];

  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0) {
      elements.push(<br key={`br-${lineIndex}`} />);
    }

    // Process each line
    let remaining = line;
    const lineElements: React.ReactNode[] = [];
    let keyIndex = 0;

    // Match 'curl' command
    if (remaining.startsWith("curl")) {
      lineElements.push(
        <span key={`cmd-${lineIndex}`} className="curl-hl-command">
          curl
        </span>,
      );
      remaining = remaining.slice(4);
    }

    // Process the rest of the line
    while (remaining.length > 0) {
      // Match line continuation
      if (remaining.match(/^\s*\\$/)) {
        lineElements.push(
          <span
            key={`cont-${lineIndex}-${keyIndex++}`}
            className="curl-hl-continuation"
          >
            {remaining}
          </span>,
        );
        remaining = "";
        continue;
      }

      // Match -X METHOD
      const methodMatch = remaining.match(
        /^(\s*)(-X)(\s+)(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/,
      );
      if (methodMatch) {
        lineElements.push(
          <span key={`ws-${lineIndex}-${keyIndex++}`}>{methodMatch[1]}</span>,
        );
        lineElements.push(
          <span
            key={`flag-${lineIndex}-${keyIndex++}`}
            className="curl-hl-flag"
          >
            {methodMatch[2]}
          </span>,
        );
        lineElements.push(
          <span key={`ws2-${lineIndex}-${keyIndex++}`}>{methodMatch[3]}</span>,
        );
        lineElements.push(
          <span
            key={`method-${lineIndex}-${keyIndex++}`}
            className="curl-hl-method"
          >
            {methodMatch[4]}
          </span>,
        );
        remaining = remaining.slice(methodMatch[0].length);
        continue;
      }

      // Match -H flag with header
      const headerMatch = remaining.match(
        /^(\s*)(-H)(\s+)'([^:]+):\s*([^']*)'/,
      );
      if (headerMatch) {
        lineElements.push(
          <span key={`ws-${lineIndex}-${keyIndex++}`}>{headerMatch[1]}</span>,
        );
        lineElements.push(
          <span
            key={`flag-${lineIndex}-${keyIndex++}`}
            className="curl-hl-flag"
          >
            {headerMatch[2]}
          </span>,
        );
        lineElements.push(
          <span key={`ws2-${lineIndex}-${keyIndex++}`}>{headerMatch[3]}</span>,
        );
        lineElements.push(
          <span
            key={`hq1-${lineIndex}-${keyIndex++}`}
            className="curl-hl-quote"
          >
            '
          </span>,
        );
        lineElements.push(
          <span
            key={`hkey-${lineIndex}-${keyIndex++}`}
            className="curl-hl-header-key"
          >
            {headerMatch[4]}
          </span>,
        );
        lineElements.push(
          <span
            key={`hcolon-${lineIndex}-${keyIndex++}`}
            className="curl-hl-punctuation"
          >
            :{" "}
          </span>,
        );
        lineElements.push(
          <span
            key={`hval-${lineIndex}-${keyIndex++}`}
            className="curl-hl-header-value"
          >
            {headerMatch[5]}
          </span>,
        );
        lineElements.push(
          <span
            key={`hq2-${lineIndex}-${keyIndex++}`}
            className="curl-hl-quote"
          >
            '
          </span>,
        );
        remaining = remaining.slice(headerMatch[0].length);
        continue;
      }

      // Match -d flag with body
      const bodyMatch = remaining.match(/^(\s*)(-d)(\s+)'((?:[^'\\]|\\.)*)'/);
      if (bodyMatch) {
        lineElements.push(
          <span key={`ws-${lineIndex}-${keyIndex++}`}>{bodyMatch[1]}</span>,
        );
        lineElements.push(
          <span
            key={`flag-${lineIndex}-${keyIndex++}`}
            className="curl-hl-flag"
          >
            {bodyMatch[2]}
          </span>,
        );
        lineElements.push(
          <span key={`ws2-${lineIndex}-${keyIndex++}`}>{bodyMatch[3]}</span>,
        );
        lineElements.push(
          <span
            key={`bq1-${lineIndex}-${keyIndex++}`}
            className="curl-hl-quote"
          >
            '
          </span>,
        );
        lineElements.push(
          <span
            key={`body-${lineIndex}-${keyIndex++}`}
            className="curl-hl-body"
          >
            {bodyMatch[4]}
          </span>,
        );
        lineElements.push(
          <span
            key={`bq2-${lineIndex}-${keyIndex++}`}
            className="curl-hl-quote"
          >
            '
          </span>,
        );
        remaining = remaining.slice(bodyMatch[0].length);
        continue;
      }

      // Match URL in quotes
      const urlMatch = remaining.match(/^(\s*)'(https?:\/\/[^']+)'/);
      if (urlMatch) {
        lineElements.push(
          <span key={`ws-${lineIndex}-${keyIndex++}`}>{urlMatch[1]}</span>,
        );
        lineElements.push(
          <span
            key={`uq1-${lineIndex}-${keyIndex++}`}
            className="curl-hl-quote"
          >
            '
          </span>,
        );
        lineElements.push(
          <span key={`url-${lineIndex}-${keyIndex++}`} className="curl-hl-url">
            {urlMatch[2]}
          </span>,
        );
        lineElements.push(
          <span
            key={`uq2-${lineIndex}-${keyIndex++}`}
            className="curl-hl-quote"
          >
            '
          </span>,
        );
        remaining = remaining.slice(urlMatch[0].length);
        continue;
      }

      // Match any other flag
      const flagMatch = remaining.match(/^(\s*)(-\w+)/);
      if (flagMatch) {
        lineElements.push(
          <span key={`ws-${lineIndex}-${keyIndex++}`}>{flagMatch[1]}</span>,
        );
        lineElements.push(
          <span
            key={`flag-${lineIndex}-${keyIndex++}`}
            className="curl-hl-flag"
          >
            {flagMatch[2]}
          </span>,
        );
        remaining = remaining.slice(flagMatch[0].length);
        continue;
      }

      // Take one character and continue
      lineElements.push(
        <span key={`char-${lineIndex}-${keyIndex++}`}>{remaining[0]}</span>,
      );
      remaining = remaining.slice(1);
    }

    elements.push(...lineElements);
  });

  return <>{elements}</>;
}

// Parse a curl command string into its components
function parseCurlCommand(curlStr: string): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
} | null {
  if (!curlStr || !curlStr.trim().startsWith("curl")) {
    return null;
  }

  // Normalize the curl command - remove line continuations and extra whitespace
  let remaining = curlStr
    .replace(/\\\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let method = "GET";
  let url = "";
  const headers: Record<string, string> = {};
  let body: string | undefined;

  // Remove 'curl' from the beginning
  remaining = remaining.replace(/^curl\s*/, "");

  // Extract method from -X flag
  const methodMatch = remaining.match(/^(.*?)-X\s+(\w+)(.*)$/);
  if (methodMatch) {
    method = methodMatch[2].toUpperCase();
    remaining = (methodMatch[1] + methodMatch[3]).trim();
  }

  // Extract URL - it's typically in single quotes
  const urlMatch = remaining.match(/^(.*?)'(https?:\/\/[^']+)'(.*)$/);
  if (urlMatch) {
    url = urlMatch[2];
    remaining = (urlMatch[1] + urlMatch[3]).trim();
  } else {
    // Try without quotes - URL is a non-whitespace sequence starting with http
    const urlMatchNoQuotes = remaining.match(/^(.*?)(https?:\/\/\S+)(.*)$/);
    if (urlMatchNoQuotes) {
      url = urlMatchNoQuotes[2];
      remaining = (urlMatchNoQuotes[1] + urlMatchNoQuotes[3]).trim();
    }
  }

  // Extract all headers from -H flags
  let headerMatch;
  while (
    (headerMatch = remaining.match(/^(.*?)-H\s+'([^:]+):\s*([^']*)'(.*)$/)) !==
    null
  ) {
    headers[headerMatch[2]] = headerMatch[3];
    remaining = (headerMatch[1] + headerMatch[4]).trim();
  }

  // Extract body from -d flag
  const bodyMatch = remaining.match(/^(.*?)-d\s+'((?:[^'\\]|\\.)*)'(.*)$/);
  if (bodyMatch) {
    // Unescape single quotes in the body
    body = bodyMatch[2].replace(/'\\''/g, "'");
    remaining = (bodyMatch[1] + bodyMatch[3]).trim();
  }

  // If there's any remaining non-whitespace content, the curl is invalid
  if (remaining.trim()) {
    return null;
  }

  if (!url) {
    return null;
  }

  return { method, url, headers, body };
}

// Generate unique ID for history entries
function generateHistoryId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export function CurlBuilder({ nodes }: CurlBuilderProps) {
  // State for request configuration
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [selectedRouteIndex, setSelectedRouteIndex] = useState<number>(-1);
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [customPath, setCustomPath] = useState<string>("");
  const [headers, setHeaders] = useState<Header[]>(DEFAULT_HEADERS);
  const [body, setBody] = useState<string>("");
  const [copied, setCopied] = useState(false);

  // State for custom dropdowns
  const [serviceDropdownOpen, setServiceDropdownOpen] = useState(false);
  const [routeSearch, setRouteSearch] = useState("");
  const serviceDropdownRef = useRef<HTMLDivElement>(null);

  // State for request execution
  const [outputTab, setOutputTab] = useState<OutputTab>("curl");
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);

  // State for editable curl
  const [isCurlEditing, setIsCurlEditing] = useState(false);
  const [editedCurl, setEditedCurl] = useState<string>("");

  // State for request history
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        serviceDropdownRef.current &&
        !serviceDropdownRef.current.contains(event.target as Node)
      ) {
        setServiceDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Load request history on mount
  useEffect(() => {
    const loadHistory = async () => {
      setHistoryLoading(true);
      try {
        const result = await window.electronAPI.loadRequestHistory();
        if (result.success && result.history) {
          setHistory(result.history);
        }
      } catch (err) {
        console.error("Failed to load history:", err);
      } finally {
        setHistoryLoading(false);
      }
    };
    loadHistory();
  }, []);

  // Get nodes that have ports AND discovered routes (actually testable with curl)
  const httpNodes = useMemo(() => {
    return nodes.filter(
      (node) =>
        node.type !== "external" &&
        node.ports.length > 0 &&
        node.routes &&
        node.routes.length > 0,
    );
  }, [nodes]);

  // Get selected node
  const selectedNode = useMemo(() => {
    return httpNodes.find((n) => n.id === selectedNodeId);
  }, [httpNodes, selectedNodeId]);

  // Get routes for selected node
  const routes: ApiRoute[] = useMemo(() => {
    return selectedNode?.routes || [];
  }, [selectedNode]);

  // Filter routes based on search
  const filteredRoutes = useMemo(() => {
    if (!routeSearch.trim()) return routes;
    const search = routeSearch.toLowerCase();
    return routes.filter(
      (route) =>
        route.path.toLowerCase().includes(search) ||
        route.method.toLowerCase().includes(search),
    );
  }, [routes, routeSearch]);

  // Get base URL for selected node
  const baseUrl = useMemo(() => {
    if (!selectedNode || selectedNode.ports.length === 0) return "";
    const port = selectedNode.ports[0];
    const host =
      port.host === "0.0.0.0" || port.host === "*" ? "localhost" : port.host;
    return `http://${host}:${port.port}`;
  }, [selectedNode]);

  // Get current path (from route or custom)
  const currentPath = useMemo(() => {
    if (selectedRouteIndex >= 0 && routes[selectedRouteIndex]) {
      return routes[selectedRouteIndex].path;
    }
    return customPath || "/";
  }, [selectedRouteIndex, routes, customPath]);

  // Full URL
  const fullUrl = useMemo(() => {
    if (!baseUrl) return "";
    return `${baseUrl}${currentPath}`;
  }, [baseUrl, currentPath]);

  // Generate curl command
  const curlCommand = useMemo(() => {
    if (!fullUrl) return "";

    const parts: string[] = ["curl"];

    // Method (only add -X if not GET)
    if (method !== "GET") {
      parts.push(`-X ${method}`);
    }

    // URL
    parts.push(`'${fullUrl}'`);

    // Headers
    headers
      .filter((h) => h.enabled && h.key && h.value)
      .forEach((h) => {
        parts.push(`-H '${h.key}: ${h.value}'`);
      });

    // Body (for POST, PUT, PATCH)
    if (["POST", "PUT", "PATCH"].includes(method) && body.trim()) {
      // Escape single quotes in the body
      const escapedBody = body.replace(/'/g, "'\\''");
      parts.push(`-d '${escapedBody}'`);
    }

    // Format with line breaks for readability
    if (parts.length > 3) {
      return parts.join(" \\\n  ");
    }
    return parts.join(" ");
  }, [fullUrl, method, headers, body]);

  // Track previous curl command to detect actual changes
  const prevCurlCommand = useRef(curlCommand);

  // Sync edited curl with generated curl only when the generated command changes
  // (not when toggling edit mode - that would lose user edits)
  useEffect(() => {
    if (curlCommand !== prevCurlCommand.current) {
      setEditedCurl(curlCommand);
      prevCurlCommand.current = curlCommand;
    }
  }, [curlCommand]);

  // Check if curl has been modified
  const isCurlModified = editedCurl !== curlCommand;

  // The curl to display - show edited version if modified (even when locked), otherwise generated
  const displayCurl = isCurlModified ? editedCurl : curlCommand;

  // Handle node selection
  const handleNodeSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedRouteIndex(-1);
    setCustomPath("");
    setRouteSearch("");
    setResponse(null);
    setRequestError(null);
    setServiceDropdownOpen(false);
  }, []);

  // Handle route selection
  const handleRouteSelect = useCallback(
    (index: number) => {
      setSelectedRouteIndex(index);
      if (index >= 0 && routes[index]) {
        const routeMethod = routes[index].method.toUpperCase();
        // "ALL" means the route accepts any method - default to GET
        setMethod(routeMethod === "ALL" ? "GET" : (routeMethod as HttpMethod));
      } else {
        // Custom path selected - default to GET
        setMethod("GET");
      }
      setResponse(null);
      setRequestError(null);
    },
    [routes],
  );

  // Handle header changes
  const updateHeader = useCallback(
    (index: number, field: keyof Header, value: string | boolean) => {
      setHeaders((prev) => {
        const newHeaders = [...prev];
        newHeaders[index] = { ...newHeaders[index], [field]: value };
        return newHeaders;
      });
    },
    [],
  );

  const addHeader = useCallback(() => {
    setHeaders((prev) => [...prev, { key: "", value: "", enabled: true }]);
  }, []);

  const removeHeader = useCallback((index: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Copy to clipboard
  const copyToClipboard = useCallback(async () => {
    if (!displayCurl) return;
    try {
      await navigator.clipboard.writeText(displayCurl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [displayCurl]);

  // Toggle curl editing mode
  const toggleCurlEditing = useCallback(() => {
    if (isCurlEditing) {
      // Exiting edit mode
      setIsCurlEditing(false);
    } else {
      // Entering edit mode - copy current curl to edited
      setEditedCurl(curlCommand);
      setIsCurlEditing(true);
    }
  }, [isCurlEditing, curlCommand]);

  // Reset curl to generated command
  const resetCurl = useCallback(() => {
    setEditedCurl(curlCommand);
    setIsCurlEditing(false);
  }, [curlCommand]);

  // Load a request from history into the builder
  const loadFromHistory = useCallback((entry: HistoryEntry) => {
    // Build curl command from history entry
    const headerParts = Object.entries(entry.headers || {})
      .map(([key, value]) => `-H '${key}: ${value}'`)
      .join(" \\\n  ");

    let curlParts = [`curl -X ${entry.method}`, `'${entry.url}'`];
    if (headerParts) {
      curlParts.push(headerParts);
    }
    if (entry.body) {
      const escapedBody = entry.body.replace(/'/g, "'\\''");
      curlParts.push(`-d '${escapedBody}'`);
    }

    const curl = curlParts.join(" \\\n  ");
    setEditedCurl(curl);
    setIsCurlEditing(true);
    setOutputTab("curl");
  }, []);

  // Clear all history
  const handleClearHistory = useCallback(async () => {
    const result = await window.electronAPI.clearRequestHistory();
    if (result.success) {
      setHistory([]);
    }
  }, []);

  // Execute the HTTP request
  const executeRequest = useCallback(async () => {
    setIsLoading(true);
    setResponse(null);
    setRequestError(null);
    setOutputTab("response");

    try {
      let requestMethod: string;
      let requestUrl: string;
      let requestHeaders: Record<string, string>;
      let requestBody: string | undefined;

      // If curl has been modified, parse it and use those values
      if (isCurlModified && editedCurl) {
        const parsed = parseCurlCommand(editedCurl);
        if (!parsed) {
          setRequestError("Failed to parse edited curl command");
          setIsLoading(false);
          return;
        }
        requestMethod = parsed.method;
        requestUrl = parsed.url;
        requestHeaders = parsed.headers;
        requestBody = parsed.body;
      } else {
        // Use the form values
        if (!fullUrl) {
          setIsLoading(false);
          return;
        }
        requestMethod = method;
        requestUrl = fullUrl;
        requestHeaders = {};
        headers
          .filter((h) => h.enabled && h.key && h.value)
          .forEach((h) => {
            requestHeaders[h.key] = h.value;
          });
        requestBody = ["POST", "PUT", "PATCH"].includes(method)
          ? body
          : undefined;
      }

      const result = await window.electronAPI.executeHttpRequest({
        method: requestMethod,
        url: requestUrl,
        headers: requestHeaders,
        body: requestBody,
      });

      if (result.success && result.response) {
        setResponse(result.response);

        // Save to history
        const historyEntry: HistoryEntry = {
          id: generateHistoryId(),
          timestamp: Date.now(),
          method: requestMethod,
          url: requestUrl,
          headers: requestHeaders,
          body: requestBody,
          response: {
            status: result.response.status,
            statusText: result.response.statusText,
            duration: result.response.duration,
            size: result.response.size,
          },
        };

        // Save to file
        await window.electronAPI.saveRequestHistory(historyEntry);

        // Update local state (prepend to show most recent first)
        setHistory((prev) => [historyEntry, ...prev].slice(0, 100));
      } else {
        setRequestError(result.error || "Unknown error");
      }
    } catch (err) {
      setRequestError(
        err instanceof Error ? err.message : "Failed to execute request",
      );
    } finally {
      setIsLoading(false);
    }
  }, [fullUrl, method, headers, body, isCurlModified, editedCurl]);

  // Format bytes to human readable
  const formatBytes = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  // Get status color
  const getStatusColor = (status: number): string => {
    if (status >= 200 && status < 300) return "#22c55e";
    if (status >= 300 && status < 400) return "#eab308";
    if (status >= 400 && status < 500) return "#f97316";
    return "#ef4444";
  };

  return (
    <div className="curl-builder">
      <div className="curl-builder-content">
        {/* Left Panel - Configuration */}
        <div className="curl-config-panel">
          {/* Service Selector - Custom Dropdown */}
          <div className="curl-section">
            <label className="curl-section-title">Service</label>
            <div className="curl-custom-dropdown" ref={serviceDropdownRef}>
              <button
                className="curl-dropdown-trigger"
                onClick={() => setServiceDropdownOpen(!serviceDropdownOpen)}
              >
                <span className="curl-dropdown-value">
                  {selectedNode ? (
                    <>
                      <span className="curl-dropdown-node-name">
                        {selectedNode.name}
                      </span>
                      <span className="curl-dropdown-port">
                        :{selectedNode.ports[0]?.port}
                      </span>
                    </>
                  ) : (
                    <span className="curl-dropdown-placeholder">
                      Select a service...
                    </span>
                  )}
                </span>
                <span
                  className={`curl-dropdown-arrow ${serviceDropdownOpen ? "open" : ""}`}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                    <path
                      d="M3 4.5L6 7.5L9 4.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </button>
              {serviceDropdownOpen && (
                <div className="curl-dropdown-menu">
                  {httpNodes.length === 0 ? (
                    <div className="curl-dropdown-empty">
                      No services available
                    </div>
                  ) : (
                    httpNodes.map((node) => (
                      <button
                        key={node.id}
                        className={`curl-dropdown-item ${node.id === selectedNodeId ? "selected" : ""}`}
                        onClick={() => handleNodeSelect(node.id)}
                      >
                        <span className="curl-dropdown-item-name">
                          {node.name}
                        </span>
                        <span className="curl-dropdown-item-port">
                          :{node.ports.map((p) => p.port).join(", ")}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Route Selector with Search */}
          {selectedNode && (
            <div className="curl-section">
              <label className="curl-section-title">
                Route
                {routes.length > 0 && (
                  <span className="curl-section-count">
                    {routes.length} discovered
                  </span>
                )}
              </label>
              {routes.length > 0 && (
                <div className="curl-route-search">
                  <svg
                    className="curl-search-icon"
                    width="14"
                    height="14"
                    viewBox="0 0 14 14"
                    fill="none"
                  >
                    <path
                      d="M6.5 11C9.26142 11 11.5 8.76142 11.5 6C11.5 3.23858 9.26142 1 6.5 1C3.73858 1 1.5 3.23858 1.5 6C1.5 8.76142 3.73858 11 6.5 11Z"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                    <path
                      d="M12.5 12L10 9.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  <input
                    type="text"
                    className="curl-route-search-input"
                    placeholder="Search routes..."
                    value={routeSearch}
                    onChange={(e) => setRouteSearch(e.target.value)}
                  />
                  {routeSearch && (
                    <button
                      className="curl-search-clear"
                      onClick={() => setRouteSearch("")}
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path
                          d="M9 3L3 9M3 3L9 9"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              )}
              {routes.length > 0 ? (
                <div className="curl-routes-list">
                  {!routeSearch && (
                    <button
                      className={`curl-route-option ${selectedRouteIndex === -1 ? "selected" : ""}`}
                      onClick={() => handleRouteSelect(-1)}
                    >
                      <span className="route-method route-custom">CUSTOM</span>
                      <span className="route-path">Custom path</span>
                    </button>
                  )}
                  {filteredRoutes.map((route, index) => {
                    // Find original index in routes array
                    const originalIndex = routes.findIndex(
                      (r) => r.path === route.path && r.method === route.method,
                    );
                    return (
                      <button
                        key={`${route.method}-${route.path}`}
                        className={`curl-route-option ${selectedRouteIndex === originalIndex ? "selected" : ""}`}
                        onClick={() => handleRouteSelect(originalIndex)}
                      >
                        <span
                          className={`route-method route-${route.method.toLowerCase()}`}
                        >
                          {route.method}
                        </span>
                        <span className="route-path">{route.path}</span>
                      </button>
                    );
                  })}
                  {filteredRoutes.length === 0 && routeSearch && (
                    <div className="curl-no-routes">
                      No routes match "{routeSearch}"
                    </div>
                  )}
                </div>
              ) : (
                <div className="curl-no-routes">
                  No routes discovered for this service
                </div>
              )}
            </div>
          )}

          {/* Request Path */}
          {selectedNode && (
            <div className="curl-section">
              <label className="curl-section-title">Request</label>
              <div className="curl-request-row">
                <span
                  className={`curl-method-badge route-method route-${method.toLowerCase()}`}
                >
                  {method}
                </span>
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
                {fullUrl || "Select a service to build URL"}
              </div>
            </div>
          )}

          {/* Headers */}
          {selectedNode && (
            <div className="curl-section">
              <div className="curl-section-header">
                <label className="curl-section-title">Headers</label>
                <button className="curl-add-btn" onClick={addHeader}>
                  + Add
                </button>
              </div>
              <div className="curl-headers-list">
                {headers.map((header, index) => (
                  <div key={index} className="curl-header-row">
                    <input
                      type="checkbox"
                      checked={header.enabled}
                      onChange={(e) =>
                        updateHeader(index, "enabled", e.target.checked)
                      }
                      className="curl-header-checkbox"
                    />
                    <input
                      type="text"
                      placeholder="Header name"
                      value={header.key}
                      onChange={(e) =>
                        updateHeader(index, "key", e.target.value)
                      }
                      className="curl-header-key"
                    />
                    <input
                      type="text"
                      placeholder="Value"
                      value={header.value}
                      onChange={(e) =>
                        updateHeader(index, "value", e.target.value)
                      }
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
          {selectedNode && ["POST", "PUT", "PATCH"].includes(method) && (
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
              className={`curl-run-btn ${isLoading ? "loading" : ""}`}
              onClick={executeRequest}
              disabled={(!fullUrl && !isCurlModified) || isLoading}
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
              className={`curl-output-tab ${outputTab === "curl" ? "active" : ""}`}
              onClick={() => setOutputTab("curl")}
            >
              cURL
            </button>
            <button
              className={`curl-output-tab ${outputTab === "response" ? "active" : ""}`}
              onClick={() => setOutputTab("response")}
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
            <button
              className={`curl-output-tab ${outputTab === "history" ? "active" : ""}`}
              onClick={() => setOutputTab("history")}
            >
              History
              {history.length > 0 && (
                <span className="curl-history-count">{history.length}</span>
              )}
            </button>
            <div className="curl-output-tabs-spacer" />
            {outputTab === "curl" && (
              <div className="curl-output-actions">
                {isCurlModified && (
                  <button
                    className="curl-reset-btn"
                    onClick={resetCurl}
                    title="Reset to generated command"
                  >
                    Reset
                  </button>
                )}
                <button
                  className={`curl-edit-btn ${isCurlEditing ? "active" : ""}`}
                  onClick={toggleCurlEditing}
                  disabled={!curlCommand}
                  title={isCurlEditing ? "Lock editing" : "Enable editing"}
                >
                  {isCurlEditing ? "Lock" : "Edit"}
                </button>
                <button
                  className={`curl-copy-btn ${copied ? "copied" : ""}`}
                  onClick={copyToClipboard}
                  disabled={!displayCurl}
                >
                  {copied ? "Copied!" : "Copy"}
                </button>
              </div>
            )}
          </div>

          {/* Output Content */}
          <div className="curl-output-content">
            {outputTab === "history" ? (
              <div className="curl-history-panel">
                {historyLoading ? (
                  <div className="curl-response-loading">
                    <span className="curl-loading-spinner" />
                    <span>Loading history...</span>
                  </div>
                ) : history.length === 0 ? (
                  <div className="curl-response-empty">
                    <span>No request history yet</span>
                  </div>
                ) : (
                  <>
                    <div className="curl-history-header">
                      <span className="curl-history-title">
                        Recent Requests ({history.length})
                      </span>
                      <button
                        className="curl-clear-history-btn"
                        onClick={handleClearHistory}
                      >
                        Clear All
                      </button>
                    </div>
                    <div className="curl-history-list">
                      {history.map((entry) => (
                        <button
                          key={entry.id}
                          className="curl-history-item"
                          onClick={() => loadFromHistory(entry)}
                        >
                          <div className="curl-history-item-main">
                            <span
                              className={`route-method route-${entry.method.toLowerCase()}`}
                            >
                              {entry.method}
                            </span>
                            <span className="curl-history-url">
                              {entry.url}
                            </span>
                          </div>
                          <div className="curl-history-item-meta">
                            <span
                              className="curl-history-status"
                              style={{
                                color: getStatusColor(entry.response.status),
                              }}
                            >
                              {entry.response.status}
                            </span>
                            <span className="curl-history-duration">
                              {entry.response.duration}ms
                            </span>
                            <span className="curl-history-time">
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                          </div>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            ) : outputTab === "curl" ? (
              <div
                className={`curl-output-code ${isCurlEditing ? "editing" : ""}`}
              >
                {isCurlEditing ? (
                  <div className="curl-editor-container">
                    <pre className="curl-editor-highlight">
                      {highlightCurl(editedCurl)}
                    </pre>
                    <textarea
                      className="curl-editor-textarea"
                      value={editedCurl}
                      onChange={(e) => setEditedCurl(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                ) : displayCurl ? (
                  <pre className="curl-output-pre">
                    {highlightCurl(displayCurl)}
                  </pre>
                ) : (
                  <span className="curl-placeholder">
                    Select a service and configure your request to generate a
                    curl command
                  </span>
                )}
                {isCurlModified && !isCurlEditing && (
                  <span className="curl-modified-badge">Modified</span>
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
                        <span className="curl-meta-item">
                          {response.duration}ms
                        </span>
                        <span className="curl-meta-item">
                          {formatBytes(response.size)}
                        </span>
                      </span>
                    </div>

                    {/* Response Headers (collapsible) */}
                    <details className="curl-response-headers">
                      <summary>
                        Headers ({Object.keys(response.headers).length})
                      </summary>
                      <div className="curl-headers-content">
                        {Object.entries(response.headers).map(
                          ([key, value]) => (
                            <div key={key} className="curl-header-item">
                              <span className="curl-header-name">{key}:</span>
                              <span className="curl-header-val">
                                {String(value)}
                              </span>
                            </div>
                          ),
                        )}
                      </div>
                    </details>

                    {/* Response Body */}
                    <div className="curl-response-body">
                      <div className="curl-response-body-header">
                        Body
                        {response.isJson && (
                          <span className="curl-json-badge">JSON</span>
                        )}
                      </div>
                      <pre className="curl-response-body-content">
                        {response.body || "(empty response)"}
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
