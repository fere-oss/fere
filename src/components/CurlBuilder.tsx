import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import type {
  GraphNode,
  ApiRoute,
  HttpResponse,
  HistoryEntry,
  NetworkPolicy,
} from "../types/electron";

interface CurlBuilderProps {
  nodes: GraphNode[];
  onTraceRequest?: (options: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }) => void;
}

let headerIdCounter = 0;

interface Header {
  id: number;
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
  { id: ++headerIdCounter, key: "Content-Type", value: "application/json", enabled: true },
  { id: ++headerIdCounter, key: "Accept", value: "application/json", enabled: true },
  { id: ++headerIdCounter, key: "Authorization", value: "Bearer ", enabled: false },
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

function tokenizeShellArgs(input: string): string[] | null {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && i + 1 < input.length) {
        i += 1;
        current += input[i];
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (char === "\\") {
      if (i + 1 >= input.length) {
        current += char;
      } else {
        i += 1;
        current += input[i];
      }
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (quote) {
    return null;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function parseHeaderToken(value: string): { key: string; val: string } | null {
  const colonIndex = value.indexOf(":");
  if (colonIndex <= 0) {
    return null;
  }

  const key = value.slice(0, colonIndex).trim();
  const val = value.slice(colonIndex + 1).trim();

  if (!key) {
    return null;
  }

  return { key, val };
}

const DATA_FLAGS = [
  "-d",
  "--data",
  "--data-ascii",
  "--data-binary",
  "--data-raw",
  "--data-urlencode",
];

const NO_VALUE_FLAGS = new Set([
  "-i",
  "--include",
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-k",
  "--insecure",
  "-L",
  "--location",
  "--compressed",
  "-v",
  "--verbose",
  "--http1.0",
  "--http1.1",
  "--http2",
  "--http2-prior-knowledge",
]);

const VALUE_FLAGS = new Set([
  "--retry",
  "--retry-delay",
  "--retry-max-time",
  "--connect-timeout",
  "--max-time",
  "--url",
]);

function isShellAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);
}

function parseShellAssignment(
  token: string,
): { name: string; value: string } | null {
  const eqIndex = token.indexOf("=");
  if (eqIndex <= 0) {
    return null;
  }
  const name = token.slice(0, eqIndex);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    return null;
  }
  return { name, value: token.slice(eqIndex + 1) };
}

function substituteShellVariables(
  token: string,
  vars: Record<string, string>,
): string {
  return token.replace(/\$([A-Za-z_][A-Za-z0-9_]*)|\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, plainName, bracedName) => {
    const varName = plainName || bracedName;
    if (!varName) {
      return _match;
    }
    return Object.prototype.hasOwnProperty.call(vars, varName) ? vars[varName] : _match;
  });
}

function getUnresolvedPathParams(requestUrl: string): string[] {
  const params = new Set<string>();
  const addMatches = (value: string) => {
    const pattern = /\{([^{}\/]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(value)) !== null) {
      const name = match[1]?.trim();
      if (name) {
        params.add(name);
      }
    }
  };

  try {
    const parsed = new URL(requestUrl);
    const decodedPath = decodeURIComponent(parsed.pathname);
    addMatches(decodedPath);
  } catch {
    addMatches(requestUrl);
  }

  return Array.from(params);
}

// Parse a curl command string into its components
function parseCurlCommand(curlStr: string): {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
} | null {
  if (!curlStr || !curlStr.trim()) {
    return null;
  }

  // Normalize newlines and shell line continuations before tokenizing.
  const normalized = curlStr.replace(/\r\n/g, "\n").replace(/\\\n[ \t]*/g, " ");
  const tokens = tokenizeShellArgs(normalized);
  if (!tokens) {
    return null;
  }

  // Accept common shell snippets that define env vars before invoking curl.
  // Examples:
  //   TOKEN=abc curl ...
  //   TOKEN=abc\ncurl ...
  const curlIndex = tokens.indexOf("curl");
  if (curlIndex < 0) {
    return null;
  }

  const shellVars: Record<string, string> = {};
  for (let i = 0; i < curlIndex; i += 1) {
    const token = tokens[i];
    if (!isShellAssignmentToken(token)) {
      return null;
    }
    const assignment = parseShellAssignment(token);
    if (!assignment) {
      return null;
    }
    shellVars[assignment.name] = assignment.value;
  }

  const curlTokens = tokens.slice(curlIndex);
  if (curlTokens[0] !== "curl") {
    return null;
  }
  const resolvedCurlTokens = [
    curlTokens[0],
    ...curlTokens.slice(1).map((token) => substituteShellVariables(token, shellVars)),
  ];

  let method = "GET";
  let url = "";
  const headers: Record<string, string> = {};
  let body: string | undefined;
  const bodyParts: string[] = [];

  for (let i = 1; i < resolvedCurlTokens.length; i += 1) {
    const token = resolvedCurlTokens[i];

    if (token === "-X" || token === "--request") {
      const next = resolvedCurlTokens[i + 1];
      if (!next) {
        return null;
      }
      method = next.toUpperCase();
      i += 1;
      continue;
    }

    if (token.startsWith("--request=")) {
      method = token.slice("--request=".length).toUpperCase();
      continue;
    }

    if (token.startsWith("-X") && token.length > 2) {
      method = token.slice(2).toUpperCase();
      continue;
    }

    if (token === "-H" || token === "--header") {
      const next = resolvedCurlTokens[i + 1];
      if (!next) {
        return null;
      }
      const parsedHeader = parseHeaderToken(next);
      if (!parsedHeader) {
        return null;
      }
      headers[parsedHeader.key] = parsedHeader.val;
      i += 1;
      continue;
    }

    if (token.startsWith("--header=")) {
      const parsedHeader = parseHeaderToken(token.slice("--header=".length));
      if (!parsedHeader) {
        return null;
      }
      headers[parsedHeader.key] = parsedHeader.val;
      continue;
    }

    if (token.startsWith("-H") && token.length > 2) {
      const parsedHeader = parseHeaderToken(token.slice(2));
      if (!parsedHeader) {
        return null;
      }
      headers[parsedHeader.key] = parsedHeader.val;
      continue;
    }

    if (DATA_FLAGS.includes(token)) {
      const next = resolvedCurlTokens[i + 1];
      if (!next) {
        return null;
      }
      bodyParts.push(next);
      i += 1;
      continue;
    }

    const inlineDataFlag = DATA_FLAGS.find(
      (flag) => token.startsWith(flag) && token.length > flag.length,
    );
    if (inlineDataFlag) {
      let nextBody = token.slice(inlineDataFlag.length);
      // Support --data=<value> and -d<value> forms.
      if (nextBody.startsWith("=")) {
        nextBody = nextBody.slice(1);
      }
      bodyParts.push(nextBody);
      continue;
    }

    if (token === "-I" || token === "--head") {
      method = "HEAD";
      continue;
    }

    if (NO_VALUE_FLAGS.has(token)) {
      continue;
    }

    if (VALUE_FLAGS.has(token)) {
      const next = resolvedCurlTokens[i + 1];
      if (!next) {
        return null;
      }
      if (token === "--url" && !url) {
        url = next;
      }
      i += 1;
      continue;
    }

    const inlineValueFlag = Array.from(VALUE_FLAGS).find(
      (flag) => token.startsWith(`${flag}=`),
    );
    if (inlineValueFlag) {
      const value = token.slice(inlineValueFlag.length + 1);
      if (!value) {
        return null;
      }
      if (inlineValueFlag === "--url" && !url) {
        url = value;
      }
      continue;
    }

    if (!url && /^https?:\/\//i.test(token)) {
      url = token;
      continue;
    }

    // Fail fast on unknown/unsupported tokens to avoid malformed requests.
    return null;
  }

  if (!url) {
    return null;
  }

  // Merge multiple -d parts: use & only for form-encoded data, otherwise
  // keep parts as-is (first part wins for JSON, just like real curl).
  if (bodyParts.length > 0) {
    const looksLikeJson = bodyParts.some(
      (p) => p.trimStart().startsWith("{") || p.trimStart().startsWith("["),
    );
    body = looksLikeJson ? bodyParts[0] : bodyParts.join("&");
  }

  // curl sends POST by default when data is present and no explicit method was set.
  if (body && method === "GET") {
    method = "POST";
  }

  return { method, url, headers, body };
}

// Generate unique ID for history entries
let historyIdCounter = 0;
function generateHistoryId(): string {
  historyIdCounter += 1;
  return `${Date.now()}-${historyIdCounter}-${Math.random().toString(36).substr(2, 9)}`;
}

export function CurlBuilder({ nodes, onTraceRequest }: CurlBuilderProps) {
  // State for request configuration
  const [selectedNodeId, setSelectedNodeId] = useState<string>("");
  const [selectedPortIndex, setSelectedPortIndex] = useState<number>(0);
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
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // State for editable curl
  const [isCurlEditing, setIsCurlEditing] = useState(false);
  const [editedCurl, setEditedCurl] = useState<string>("");

  // State for request history
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // State for network policy
  const [networkPolicy, setNetworkPolicyState] = useState<NetworkPolicy>("local");

  // State for trace toggle
  const [traceEnabled, setTraceEnabled] = useState(false);

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

  // Load network policy on mount
  useEffect(() => {
    window.electronAPI?.getNetworkPolicy?.().then((result) => {
      if (result.success && result.policy) {
        setNetworkPolicyState(result.policy);
      }
    }).catch((err) => console.error("Failed to load network policy:", err));
  }, []);

  const toggleNetworkPolicy = useCallback(async () => {
    if (!window.electronAPI?.setNetworkPolicy) return;
    const next = networkPolicy === "local" ? "public" : "local";
    const result = await window.electronAPI.setNetworkPolicy(next);
    if (result.success) {
      setNetworkPolicyState(next);
    }
  }, [networkPolicy]);

  // Track elapsed time during request execution for timeout indication
  useEffect(() => {
    if (!isLoading) {
      setElapsedSeconds(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsedSeconds((s) => s + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [isLoading]);

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

  // Filter routes based on search, preserving original index for stable selection
  const filteredRoutes = useMemo(() => {
    const tagged = routes.map((route, idx) => ({ ...route, _originalIndex: idx }));
    if (!routeSearch.trim()) return tagged;
    const search = routeSearch.toLowerCase();
    return tagged.filter(
      (route) =>
        route.path.toLowerCase().includes(search) ||
        route.method.toLowerCase().includes(search),
    );
  }, [routes, routeSearch]);

  // Get base URL for selected node using selected port
  const baseUrl = useMemo(() => {
    if (!selectedNode || selectedNode.ports.length === 0) return "";
    const portIdx = Math.min(selectedPortIndex, selectedNode.ports.length - 1);
    const port = selectedNode.ports[portIdx];
    const host =
      port.host === "0.0.0.0" || port.host === "*" ? "localhost" : port.host;
    return `http://${host}:${port.port}`;
  }, [selectedNode, selectedPortIndex]);

  // Get current path (from route or custom)
  const currentPath = useMemo(() => {
    if (selectedRouteIndex >= 0 && routes[selectedRouteIndex]) {
      return routes[selectedRouteIndex].path;
    }
    return customPath || "/";
  }, [selectedRouteIndex, routes, customPath]);

  // Full URL (encode path segments to handle spaces/special chars)
  const fullUrl = useMemo(() => {
    if (!baseUrl) return "";
    try {
      const url = new URL(currentPath, baseUrl);
      return url.href;
    } catch {
      // Fallback for malformed paths
      return `${baseUrl}${currentPath}`;
    }
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

    // Headers (escape single quotes in values to produce valid shell)
    headers
      .filter((h) => h.enabled && h.key && h.value)
      .forEach((h) => {
        const escapedVal = h.value.replace(/'/g, "'\\''");
        parts.push(`-H '${h.key}: ${escapedVal}'`);
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
  // and the user is not actively editing (otherwise their edits would be lost)
  useEffect(() => {
    if (curlCommand !== prevCurlCommand.current) {
      if (!isCurlEditing) {
        setEditedCurl(curlCommand);
      }
      prevCurlCommand.current = curlCommand;
    }
  }, [curlCommand, isCurlEditing]);

  // Check if curl has been modified
  const isCurlModified = editedCurl !== curlCommand;

  // The curl to display - show edited version if modified (even when locked), otherwise generated
  const displayCurl = isCurlModified ? editedCurl : curlCommand;

  // Handle node selection
  const handleNodeSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setSelectedPortIndex(0);
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
    setHeaders((prev) => [...prev, { id: ++headerIdCounter, key: "", value: "", enabled: true }]);
  }, []);

  const removeHeader = useCallback((index: number) => {
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Copy to clipboard
  const copyToClipboard = useCallback(async () => {
    if (!displayCurl) return;
    try {
      if (!window.electronAPI?.copyText) {
        throw new Error("Clipboard API unavailable");
      }
      const result = await window.electronAPI.copyText(displayCurl);
      if (!result.success) {
        throw new Error(result.error || "Failed to copy");
      }
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
    // Build curl command from history entry (escape single quotes in values)
    const headerParts = Object.entries(entry.headers || {})
      .map(([key, value]) => {
        const escapedVal = String(value).replace(/'/g, "'\\''");
        return `-H '${key}: ${escapedVal}'`;
      })
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

      const unresolvedPathParams = getUnresolvedPathParams(requestUrl);
      if (unresolvedPathParams.length > 0) {
        const names = unresolvedPathParams.join(", ");
        const plural = unresolvedPathParams.length > 1 ? "s" : "";
        setRequestError(
          `Unresolved path parameter${plural}: ${names}. Replace placeholder values before sending the request.`,
        );
        setIsLoading(false);
        return;
      }

      // If trace is enabled, fire trace request and switch to graph
      if (traceEnabled && onTraceRequest) {
        onTraceRequest({
          method: requestMethod,
          url: requestUrl,
          headers: requestHeaders,
          body: requestBody,
        });
        // Still fire the normal request for response display
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
  }, [fullUrl, method, headers, body, isCurlModified, editedCurl, traceEnabled, onTraceRequest]);

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

          {/* Port Selector - only show when multiple ports */}
          {selectedNode && selectedNode.ports.length > 1 && (
            <div className="curl-section">
              <label className="curl-section-title">Port</label>
              <div className="curl-port-selector">
                {selectedNode.ports.map((p, idx) => (
                  <button
                    key={`${p.host}-${p.port}`}
                    className={`curl-port-option ${selectedPortIndex === idx ? "selected" : ""}`}
                    onClick={() => setSelectedPortIndex(idx)}
                  >
                    :{p.port}
                  </button>
                ))}
              </div>
            </div>
          )}

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
                  {filteredRoutes.map((route) => {
                    // Use the stable original index stored during filtering
                    const originalIndex = route._originalIndex as number;
                    return (
                      <button
                        key={`${originalIndex}-${route.method}-${route.path}`}
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
                  <div key={header.id} className="curl-header-row">
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

          {/* Network Policy Toggle */}
          <div className="curl-section curl-network-policy">
            <label className="curl-section-title">Network Access</label>
            <button
              className={`curl-policy-toggle ${networkPolicy}`}
              onClick={toggleNetworkPolicy}
              title={
                networkPolicy === "local"
                  ? "Private networks allowed — click to restrict to public only"
                  : "Public only — click to allow private/local networks"
              }
            >
              <span className="curl-policy-indicator" />
              <span className="curl-policy-label">
                {networkPolicy === "local"
                  ? "Local + Public"
                  : "Public Only"}
              </span>
            </button>
            {networkPolicy === "local" && (
              <span className="curl-policy-hint">
                Requests to localhost and private IPs are allowed
              </span>
            )}
          </div>

          {/* Run Button + Trace Toggle */}
          {selectedNode && (
            <div className="curl-run-group">
              <button
                className={`curl-run-btn ${isLoading ? "loading" : ""}`}
                onClick={executeRequest}
                disabled={(!fullUrl && !isCurlModified) || isLoading}
              >
                {isLoading ? (
                  <>
                    <span className="curl-run-spinner" />
                    {traceEnabled ? "Tracing..." : "Sending..."}
                  </>
                ) : (
                  <>
                    <span className="curl-run-icon">▶</span>
                    {traceEnabled ? "Send & Trace" : "Send Request"}
                  </>
                )}
              </button>
              {onTraceRequest && (
                <button
                  className={`curl-trace-toggle ${traceEnabled ? "active" : ""}`}
                  onClick={() => setTraceEnabled(!traceEnabled)}
                  title={traceEnabled ? "Disable request tracing" : "Enable request tracing — visualize request flow on the service map"}
                  aria-label="Toggle request tracing"
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                    <circle cx="4" cy="8" r="2" />
                    <circle cx="12" cy="4" r="2" />
                    <circle cx="12" cy="12" r="2" />
                    <path d="M6 7l4-2M6 9l4 2" />
                  </svg>
                </button>
              )}
            </div>
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
                    <span>
                      Sending request...{elapsedSeconds > 0 ? ` (${elapsedSeconds}s)` : ""}
                      {elapsedSeconds >= 25 && " — timeout at 30s"}
                    </span>
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

      {/* Empty State - only show on curl tab */}
      {httpNodes.length === 0 && outputTab === "curl" && (
        <div className="curl-empty-state">
          <p>No services with HTTP ports found</p>
          <span>Start a local development server to see it here</span>
        </div>
      )}
    </div>
  );
}
