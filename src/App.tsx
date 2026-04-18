import {
  useState,
  useMemo,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
  useReducer,
} from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useSystemSnapshot } from "./hooks/useSystemMonitor";
import { GraphView } from "./components/GraphView";
import { AgentPanel } from "./components/AgentPanel";
import { CurlBuilder } from "./components/CurlBuilder";
import { DatabaseListView } from "./components/DatabaseListView";
import { ContainerLogsTab } from "./components/ContainerLogsTab";
import { AnalyticsView } from "./components/AnalyticsView";
import { WelcomeModal } from "./components/WelcomeModal";
import { ShareModal } from "./components/ShareModal";
import { StackDiffModal } from "./components/StackDiffModal";
import { ErrorBoundary } from "./components/ErrorBoundary";
import {
  CommandPalette,
  CommandPaletteHandle,
} from "./components/CommandPalette";
import {
  useKnownServices,
  serviceKey,
  nodeServiceKey,
  looseServiceIdentity,
} from "./components/checklist/useKnownServices";
import { ServiceDropdown } from "./components/checklist/ServiceDropdown";
import { HEALTH_COLORS } from "./components/graph/constants";
import { initAnalytics, capture, identifyWithMainProcess } from "./analytics";
import {
  TraceContext,
  TraceDispatchContext,
  traceReducer,
} from "./components/graph/traceContext";
import type {
  AlertEvent,
  AuthSession,
  GraphEdge,
  GraphNode,
  ServiceStatus,
} from "./types/electron";
import "./App.css";

// Detect platform for default tab label
const isMacOS = navigator.userAgent.toLowerCase().includes("mac");
const SYSTEM_TAB_LABEL = isMacOS ? "macOS" : "System";
const SYSTEM_TAB_ID = "__system__";
const TAB_GROUPING_KEY = "fere.tabGrouping";
const WELCOME_SEEN_KEY = "fere.hasSeenWelcome";
const THEME_KEY = "fere.theme";
type Theme = "light" | "dark";

const STACK_FRAMEWORK_LABELS: Record<string, string> = {
  nextjs: "Next",
  express: "Express",
  nestjs: "Nest",
  fastapi: "FastAPI",
  flask: "Flask",
  django: "Django",
  koa: "Koa",
  hono: "Hono",
  "node-http": "Node",
};

const BACKEND_FRAMEWORK_ORDER = [
  "express",
  "nestjs",
  "fastapi",
  "flask",
  "django",
  "koa",
  "hono",
  "node-http",
];

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

function getAuthAvatarFallback(label: string | null | undefined): string {
  const source = (label || "").trim();
  if (!source) return "?";

  const parts = source
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
  }

  const condensed = source.replace(/[^a-zA-Z0-9]/g, "");
  return (condensed.slice(0, 2) || source.slice(0, 2)).toUpperCase();
}

const ALERT_CATEGORIES = [
  { key: "down" as const, label: "Down", desc: "Service crashes" },
  { key: "recovery" as const, label: "Recovery", desc: "Service comes back" },
  { key: "degraded" as const, label: "Degraded", desc: "Slow / idle" },
  { key: "container" as const, label: "Container", desc: "State changes" },
] as const;

const ALERT_EVENT_LABELS: Record<string, string> = {
  down: "went down",
  recovery: "recovered",
  degraded: "degraded",
  "container-stopped": "stopped",
  "container-running": "started running",
  "service-discovered": "appeared",
  "service-gone": "disappeared",
};

function normalizeProjectTabPath(projectPath: string): string {
  if (!projectPath) return projectPath;
  // Collapse common compose/monorepo service folders into one project tab.
  return projectPath.replace(/\/services\/[^/]+$/, "");
}

function detectDbLabel(command: string, name: string) {
  if (command.includes("postgres") || name.includes("postgres"))
    return "Postgres";
  if (
    command.includes("mysql") ||
    name.includes("mysql") ||
    command.includes("mariadb")
  )
    return "MySQL";
  if (command.includes("mongo") || name.includes("mongo")) return "MongoDB";
  if (command.includes("sqlite") || name.includes("sqlite")) return "SQLite";
  return "Database";
}

function detectCacheLabel(command: string, name: string) {
  if (command.includes("redis") || name.includes("redis")) return "Redis";
  if (command.includes("memcached") || name.includes("memcached"))
    return "Memcached";
  return "Cache";
}

function detectBrokerLabel(command: string, name: string) {
  if (command.includes("nats") || name.includes("nats")) return "NATS";
  if (command.includes("kafka") || name.includes("kafka")) return "Kafka";
  if (command.includes("rabbit") || name.includes("rabbit")) return "RabbitMQ";
  return "Broker";
}

function detectProjectStack(nodes: GraphNode[]) {
  const frameworks = new Set<string>();
  const dbLabels = new Set<string>();
  const cacheLabels = new Set<string>();
  const brokerLabels = new Set<string>();
  let hasFrontend = false;
  let hasBackend = false;

  nodes.forEach((node) => {
    const command = (node.command || "").toLowerCase();
    const name = (node.name || "").toLowerCase();

    node.routes?.forEach((route) => {
      if (route.framework) frameworks.add(route.framework);
    });

    if (command.includes("next")) frameworks.add("nextjs");
    if (command.includes("express")) frameworks.add("express");
    if (command.includes("nestjs")) frameworks.add("nestjs");
    if (command.includes("fastapi") || command.includes("uvicorn"))
      frameworks.add("fastapi");
    if (command.includes("flask")) frameworks.add("flask");
    if (command.includes("django")) frameworks.add("django");
    if (command.includes("koa")) frameworks.add("koa");
    if (command.includes("hono")) frameworks.add("hono");

    if (node.type === "frontend") hasFrontend = true;
    if (
      node.type === "backend" ||
      node.type === "nodejs" ||
      node.type === "python"
    )
      hasBackend = true;

    if (node.type === "database") dbLabels.add(detectDbLabel(command, name));
    if (node.type === "cache") cacheLabels.add(detectCacheLabel(command, name));
    if (node.type === "broker")
      brokerLabels.add(detectBrokerLabel(command, name));
  });

  const parts: string[] = [];

  if (frameworks.has("nextjs")) {
    parts.push("Next");
  } else if (hasFrontend) {
    parts.push("Frontend");
  }

  BACKEND_FRAMEWORK_ORDER.forEach((framework) => {
    if (frameworks.has(framework)) {
      parts.push(STACK_FRAMEWORK_LABELS[framework]);
    }
  });

  if (!BACKEND_FRAMEWORK_ORDER.some((f) => frameworks.has(f)) && hasBackend) {
    parts.push("Backend");
  }

  parts.push(
    ...Array.from(dbLabels),
    ...Array.from(cacheLabels),
    ...Array.from(brokerLabels),
  );

  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  if (unique.length === 0) return null;
  return unique.slice(0, 4).join(" + ");
}

// View modes
type ViewMode =
  | "graph"
  | "containers"
  | "api-tester"
  | "database"
  | "analytics";
type ContainerSubTab = "overview" | "logs";
type TabGrouping = "repo" | "subproject";

function getNodeTabPath(node: GraphNode, grouping: TabGrouping): string | null {
  if (!node.projectPath) return null;
  if (grouping === "repo") {
    return node.repoPath || node.projectPath;
  }
  return normalizeProjectTabPath(node.projectPath);
}

const DOCKER_EMPTY_SVG = (
  <svg
    width="48"
    height="48"
    viewBox="0 0 24 24"
    fill="currentColor"
    opacity="0.3"
  >
    <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
  </svg>
);

function DockerEmptyState({ dockerStatus }: { dockerStatus: ServiceStatus }) {
  let message: string;
  let hint: string;

  if (dockerStatus.code === "unavailable") {
    const isNotRunning = dockerStatus.message?.includes("not running");
    if (isNotRunning) {
      message = "Docker Desktop isn't running";
      hint = "Start it to see your containers";
    } else {
      message = "Docker Desktop is not installed";
      hint = "Install Docker Desktop to monitor containers and databases";
    }
  } else if (dockerStatus.code === "permission_denied") {
    message = "Fere can't access Docker";
    hint = "Check your user permissions";
  } else {
    message = "No Docker containers running";
    hint = "Start some containers to see them here";
  }

  return (
    <div className="graph-empty">
      <div className="docker-empty-icon">{DOCKER_EMPTY_SVG}</div>
      <p>{message}</p>
      <span>{hint}</span>
    </div>
  );
}

function App() {
  const { snapshot, loading, error, serviceStatus, monitoringStartedAt } =
    useSystemSnapshot(2000);
  const { graph, ports } = snapshot;

  // Welcome modal state — initialize synchronously to avoid showing toast before modal
  const [showWelcome, setShowWelcome] = useState(() => {
    try {
      return !window.localStorage.getItem(WELCOME_SEEN_KEY);
    } catch {
      return false;
    }
  });

  // Theme state — persisted to localStorage, applied via data-theme attribute on <html>
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return window.localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light";
    } catch {
      return "light";
    }
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch { /* ignore */ }
    window.electronAPI?.setNativeTheme?.(theme);
  }, [theme]);

  // First detection toast
  // View mode state - graph or api-tester
  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  const [analyticsBadge, setAnalyticsBadge] = useState(false);

  useEffect(() => {
    if (viewMode === "analytics") {
      setAnalyticsBadge(false);
    }
  }, [viewMode]);

  useEffect(() => {
    const unsub = window.electronAPI?.onActivityEvent?.((event) => {
      if (
        viewMode !== "analytics" &&
        (event.severity === "critical" || event.severity === "warning")
      ) {
        setAnalyticsBadge(true);
      }
    });
    return () => unsub?.();
  }, [viewMode]);

  // Trace state (shared between CurlBuilder and GraphView)
  const [traceState, traceDispatch] = useReducer(traceReducer, {
    phase: "idle",
    activeHopIndex: -1,
    traceNodeIds: new Set<string>(),
    traceEdgeIds: new Set<string>(),
    result: null,
    entryNodeId: null,
  });

  // Selected tab state - default to system tab
  const [selectedTab, setSelectedTab] = useState<string>(SYSTEM_TAB_ID);
  const [tabGrouping, setTabGrouping] = useState<TabGrouping>(() => {
    try {
      const saved = window.localStorage.getItem(TAB_GROUPING_KEY);
      return saved === "subproject" ? "subproject" : "repo";
    } catch {
      return "repo";
    }
  });

  // Database node for database page
  const [databaseNode, setDatabaseNode] = useState<GraphNode | null>(null);

  // Sub-tab for containers view
  const [containerSubTab, setContainerSubTab] =
    useState<ContainerSubTab>("overview");

  // Initial container ID to select in logs view (when navigating from context menu)
  const [initialLogContainerId, setInitialLogContainerId] = useState<
    string | undefined
  >();

  // Alert preferences state
  const [alertsEnabled, setAlertsEnabled] = useState(true);
  const [categoryToggles, setCategoryToggles] = useState({
    down: true,
    recovery: true,
    degraded: true,
    container: true,
  });
  const [alertPanelOpen, setAlertPanelOpen] = useState(false);
  const [alertHistory, setAlertHistory] = useState<AlertEvent[]>([]);
  const alertPanelRef = useRef<HTMLDivElement>(null);
  const [optimisticDownNodes, setOptimisticDownNodes] = useState<
    Map<string, GraphNode>
  >(() => new Map());
  const optimisticDownTimersRef = useRef<
    Map<string, ReturnType<typeof setTimeout>>
  >(new Map());
  const lastNodeIdByServiceRef = useRef<Map<string, string>>(new Map());

  // Tab button refs for dropdown positioning
  const tabButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const appTabsRef = useRef<HTMLDivElement | null>(null);

  // Sliding indicator for view-mode tabs
  const viewModeTabsRef = useRef<HTMLDivElement>(null);
  const commandPaletteRef = useRef<CommandPaletteHandle>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{
    left: number;
    width: number;
  } | null>(null);

  useLayoutEffect(() => {
    const container = viewModeTabsRef.current;
    if (!container) return;
    const activeBtn = container.querySelector<HTMLButtonElement>(
      ".view-mode-tab-active",
    );
    if (!activeBtn) return;
    setIndicatorStyle({
      left: activeBtn.offsetLeft,
      width: activeBtn.offsetWidth,
    });
  }, [viewMode]);

  // Share modal state
  const [showShare, setShowShare] = useState(false);
  const [showStackDiff, setShowStackDiff] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);

  const setIsAgentOpen = useCallback((open: boolean) => {
    window.dispatchEvent(
      new CustomEvent("fere:set-agent-open", { detail: { open } }),
    );
  }, []);

  const handleHeaderDoubleClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'button, a, input, textarea, select, [role="button"], [data-no-window-drag-zoom="true"]',
        )
      ) {
        return;
      }
      window.electronAPI?.toggleWindowMaximize?.();
    },
    [],
  );

  useEffect(() => {
    if (window.electronAPI?.getAlertPreferences) {
      window.electronAPI
        .getAlertPreferences()
        .then((prefs) => {
          setAlertsEnabled(prefs.alertsEnabled);
          if (prefs.categoryToggles) {
            setCategoryToggles(prefs.categoryToggles);
          }
        })
        .catch((err) =>
          console.error("Failed to load alert preferences:", err),
        );
    }
  }, []);

  useEffect(() => {
    window.electronAPI.authGetSession().then(setAuthSession).catch(() => {});
    const cleanup = window.electronAPI.onAuthSessionChanged((session) => {
      setAuthSession(session);
    });
    return cleanup;
  }, []);

  // Initialize analytics and link to main process ID
  useEffect(() => {
    initAnalytics();
    capture("app_opened");
    if (window.electronAPI?.getAnalyticsId) {
      window.electronAPI
        .getAnalyticsId()
        .then((id) => {
          if (id) identifyWithMainProcess(id);
        })
        .catch((err) => console.error("Failed to get analytics ID:", err));
    }
  }, []);

  useEffect(() => {
    const handleOptimisticDown = (event: Event) => {
      const customEvent = event as CustomEvent<{ node?: GraphNode }>;
      const node = customEvent.detail?.node;
      if (!node) return;

      const downNode: GraphNode = {
        ...node,
        pid: 0,
        cpu: 0,
        memory: 0,
        ports: [],
        healthStatus: "red",
        lastSeen: Date.now(),
        isGhost: true,
        startCommand: node.startCommand || node.command || undefined,
        startProjectPath:
          node.startProjectPath || node.projectPath || undefined,
      };

      setOptimisticDownNodes((current) => {
        const next = new Map(current);
        next.set(node.id, downNode);
        return next;
      });

      const existing = optimisticDownTimersRef.current.get(node.id);
      if (existing) {
        clearTimeout(existing);
      }
      const timer = setTimeout(() => {
        setOptimisticDownNodes((current) => {
          if (!current.has(node.id)) return current;
          const next = new Map(current);
          next.delete(node.id);
          return next;
        });
        optimisticDownTimersRef.current.delete(node.id);
      }, 15000);
      optimisticDownTimersRef.current.set(node.id, timer);
    };

    window.addEventListener(
      "fere:optimistic-mark-down",
      handleOptimisticDown as EventListener,
    );
    const timersRef = optimisticDownTimersRef.current;
    return () => {
      window.removeEventListener(
        "fere:optimistic-mark-down",
        handleOptimisticDown as EventListener,
      );
      timersRef.forEach((timer) => clearTimeout(timer));
      timersRef.clear();
    };
  }, []);

  // Navigate to container logs when triggered from the graph context menu
  useEffect(() => {
    const handleViewLogs = (e: Event) => {
      const { containerId } = (e as CustomEvent).detail;
      setViewMode("containers");
      setContainerSubTab("logs");
      setInitialLogContainerId(containerId);
    };
    window.addEventListener("fere:view-container-logs", handleViewLogs);
    return () =>
      window.removeEventListener("fere:view-container-logs", handleViewLogs);
  }, []);

  // Navigate to service map when Fere chat focuses a node
  useEffect(() => {
    const handler = () => setViewMode("graph");
    window.addEventListener("fere:show-graph", handler);
    return () => window.removeEventListener("fere:show-graph", handler);
  }, []);

  // Cmd+K / Ctrl+K to focus command palette
  useEffect(() => {
    const handleCmdK = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        commandPaletteRef.current?.focus();
      }
    };
    window.addEventListener("keydown", handleCmdK);
    return () => window.removeEventListener("keydown", handleCmdK);
  }, []);

  useEffect(() => {
    if (optimisticDownNodes.size === 0) return;
    const liveNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const runningServiceKeys = new Set(
      graph.nodes
        .filter(
          (node) =>
            node.type !== "external" &&
            !node.isGhost &&
            node.healthStatus !== "red" &&
            (!node.isDockerContainer || node.containerState === "running"),
        )
        .map((node) => nodeServiceKey(node)),
    );
    setOptimisticDownNodes((current) => {
      let changed = false;
      const next = new Map(current);
      current.forEach((optimisticNode, id) => {
        const liveNode = liveNodeById.get(id);
        const serviceRecovered = runningServiceKeys.has(
          nodeServiceKey(optimisticNode),
        );
        const idRecovered =
          !!liveNode &&
          !liveNode.isGhost &&
          liveNode.healthStatus !== "red" &&
          (!liveNode.isDockerContainer ||
            liveNode.containerState === "running");
        if (serviceRecovered || idRecovered) {
          next.delete(id);
          changed = true;
          const timer = optimisticDownTimersRef.current.get(id);
          if (timer) clearTimeout(timer);
          optimisticDownTimersRef.current.delete(id);
        }
      });
      return changed ? next : current;
    });
  }, [graph.nodes, optimisticDownNodes.size]);

  const visibleGraphNodes = useMemo(() => {
    const merged = graph.nodes.map(
      (node) => optimisticDownNodes.get(node.id) || node,
    );
    const mergedIds = new Set(merged.map((node) => node.id));
    optimisticDownNodes.forEach((node, id) => {
      if (!mergedIds.has(id)) {
        merged.push(node);
      }
    });
    return merged;
  }, [graph.nodes, optimisticDownNodes]);

  const graphIndex = useMemo(() => {
    const nodeById = new Map<string, GraphNode>();
    const nonExternalNodes: GraphNode[] = [];
    const systemNodes: GraphNode[] = [];
    const nodesByTabPath = new Map<string, GraphNode[]>();
    const nodeByService = new Map<string, GraphNode>();
    // Loose-keyed map for fallback when exact serviceKey doesn't match
    // (e.g. stale containerId in KnownService vs new containerId in node) (Bug 31/32).
    const nodeByServiceLoose = new Map<string, GraphNode>();

    visibleGraphNodes.forEach((node) => {
      nodeById.set(node.id, node);

      if (node.type === "external") return;
      nonExternalNodes.push(node);

      const serviceKeyValue = nodeServiceKey(node);
      const existing = nodeByService.get(serviceKeyValue);
      // Prefer a concrete running node over a ghost/down fallback.
      if (!existing || (existing.isGhost && !node.isGhost)) {
        nodeByService.set(serviceKeyValue, node);
      }

      const looseKey = looseServiceIdentity({
        ...node,
        projectPath: node.projectPath || undefined,
      });
      const existingLoose = nodeByServiceLoose.get(looseKey);
      if (!existingLoose || (existingLoose.isGhost && !node.isGhost)) {
        nodeByServiceLoose.set(looseKey, node);
      }

      const tabPath = getNodeTabPath(node, tabGrouping);
      if (!tabPath) {
        systemNodes.push(node);
        return;
      }
      const list = nodesByTabPath.get(tabPath);
      if (list) {
        list.push(node);
      } else {
        nodesByTabPath.set(tabPath, [node]);
      }
    });

    return {
      nodeById,
      nonExternalNodes,
      systemNodes,
      nodesByTabPath,
      nodeByService,
      nodeByServiceLoose,
    };
  }, [visibleGraphNodes, tabGrouping]);

  const edgeIndex = useMemo(() => {
    const byNodeId = new Map<string, GraphEdge[]>();
    graph.edges.forEach((edge) => {
      const sourceList = byNodeId.get(edge.source);
      if (sourceList) sourceList.push(edge);
      else byNodeId.set(edge.source, [edge]);

      if (edge.target !== edge.source) {
        const targetList = byNodeId.get(edge.target);
        if (targetList) targetList.push(edge);
        else byNodeId.set(edge.target, [edge]);
      }
    });
    return { byNodeId };
  }, [graph.edges]);

  useEffect(() => {
    const next = new Map(lastNodeIdByServiceRef.current);
    visibleGraphNodes.forEach((node) => {
      if (node.type === "external") return;
      next.set(nodeServiceKey(node), node.id);
      // Also index by loose key so ghost nodes can find the last-seen node ID
      // even when containerId changes across container restarts (Bug 31/32).
      const loose = looseServiceIdentity({
        ...node,
        projectPath: node.projectPath || undefined,
      });
      next.set(loose, node.id);
    });
    lastNodeIdByServiceRef.current = next;
  }, [visibleGraphNodes]);

  const handleToggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const handleToggleAlerts = useCallback(async () => {
    setAlertsEnabled((prev) => {
      const newValue = !prev;
      window.electronAPI?.setAlertPreferences?.({ alertsEnabled: newValue });
      return newValue;
    });
  }, []);

  const handleToggleCategory = useCallback(
    async (category: keyof typeof categoryToggles) => {
      setCategoryToggles((prev) => {
        const newToggles = { ...prev, [category]: !prev[category] };
        window.electronAPI?.setAlertPreferences?.({
          categoryToggles: newToggles,
        });
        return newToggles;
      });
    },
    [],
  );

  const loadAlertHistory = useCallback(async () => {
    if (window.electronAPI?.getAlertHistory) {
      const result = await window.electronAPI.getAlertHistory();
      if (result.success) {
        setAlertHistory(result.events);
      }
    }
  }, []);

  const handleClearHistory = useCallback(async () => {
    if (window.electronAPI?.clearAlertHistory) {
      await window.electronAPI.clearAlertHistory();
      setAlertHistory([]);
    }
  }, []);

  // Load history when alert panel opens
  useEffect(() => {
    if (alertPanelOpen) {
      loadAlertHistory();
    }
  }, [alertPanelOpen, loadAlertHistory]);

  // Click-outside to close alert panel
  useEffect(() => {
    if (!alertPanelOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        alertPanelRef.current &&
        !alertPanelRef.current.contains(e.target as Node)
      ) {
        const target = e.target as HTMLElement;
        if (target.closest(".alert-toggle")) return;
        setAlertPanelOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick, true);
    return () => document.removeEventListener("mousedown", handleClick, true);
  }, [alertPanelOpen]);

  const handleCloseWelcome = useCallback(() => {
    setShowWelcome(false);
    try {
      window.localStorage.setItem(WELCOME_SEEN_KEY, "true");
    } catch {
      // Ignore localStorage write errors
    }
  }, []);

  // Handle database container click - navigate to database page
  const handleDatabaseClick = useCallback((node: GraphNode) => {
    setDatabaseNode(node);
    setViewMode("database");
  }, []);

  // Handle trace request from CurlBuilder
  const handleTraceRequest = useCallback(
    async (options: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    }) => {
      // Find the target node from URL port and switch to its project tab
      let targetPort: number | null = null;
      try {
        const parsed = new URL(options.url);
        targetPort =
          parseInt(parsed.port, 10) ||
          (parsed.protocol === "https:" ? 443 : 80);
      } catch {
        /* ignore */
      }

      // Find the entry node and switch to its tab
      let entryNodeId: string | null = null;
      if (targetPort) {
        let found = false;
        graphIndex.nodesByTabPath.forEach((tabNodes, tabPath) => {
          if (found) return;
          const match = tabNodes.find((n: GraphNode) =>
            n.ports.some((p: { port: number }) => p.port === targetPort),
          );
          if (match) {
            setSelectedTab(tabPath);
            entryNodeId = match.id;
            found = true;
          }
        });
        if (!found) {
          const sysMatch = graphIndex.systemNodes.find((n: GraphNode) =>
            n.ports.some((p: { port: number }) => p.port === targetPort),
          );
          if (sysMatch) {
            setSelectedTab(SYSTEM_TAB_ID);
            entryNodeId = sysMatch.id;
          }
        }
      }

      // Switch to graph view and start capture
      setViewMode("graph");
      traceDispatch({ type: "start-capture", entryNodeId });

      try {
        // Send ALL graph nodes/edges so backend can BFS across the full topology
        const result = await window.electronAPI.executeTracedRequest({
          method: options.method,
          url: options.url,
          headers: options.headers,
          body: options.body,
          graphNodes: graph.nodes,
          graphEdges: graph.edges,
        });

        if (result.success && result.trace) {
          traceDispatch({ type: "set-result", result: result.trace });
        } else {
          console.error("Trace failed:", result.error);
          traceDispatch({ type: "dismiss" });
        }
      } catch (err) {
        console.error("Trace error:", err);
        traceDispatch({ type: "dismiss" });
      }
    },
    [
      graph.nodes,
      graph.edges,
      graphIndex.nodesByTabPath,
      graphIndex.systemNodes,
    ],
  );

  // Reconcile databaseNode with live data when containers change
  // (e.g., container restarts get a new containerId)
  useEffect(() => {
    if (!databaseNode || databaseNode.id.startsWith("__saved_")) return;
    const live = graphIndex.nonExternalNodes.find(
      (n) => n.id === databaseNode.id,
    );
    if (live) {
      // Update with fresh data (new containerId, ports, state, etc.)
      if (
        live.containerId !== databaseNode.containerId ||
        live.containerState !== databaseNode.containerState
      ) {
        setDatabaseNode(live);
      }
    }
  }, [graphIndex.nonExternalNodes, databaseNode]);

  // Open database view directly from top tabs (show database list)
  const handleOpenDatabaseView = useCallback(() => {
    setViewMode("database");
    capture("tab_switched", { to: "database" });
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(TAB_GROUPING_KEY, tabGrouping);
    } catch {
      // Ignore storage write issues
    }
  }, [tabGrouping]);

  // Build tabs from unique projectPaths
  const tabs = useMemo(() => {
    const projectPaths = new Map<string, string>(); // path -> label
    graphIndex.nodesByTabPath.forEach((_, tabPath) => {
      const label = tabPath.split("/").pop() || tabPath;
      projectPaths.set(tabPath, label);
    });

    const systemCount = graphIndex.systemNodes.length;

    const stackByProject = new Map<string, string | null>();
    projectPaths.forEach((_, path) => {
      const projectNodes = graphIndex.nodesByTabPath.get(path) || [];
      stackByProject.set(path, detectProjectStack(projectNodes));
    });

    // Sort project tabs alphabetically by label and include counts per project
    const projectTabs = Array.from(projectPaths.entries())
      .map(([path, label]) => ({
        id: path,
        label,
        count: graphIndex.nodesByTabPath.get(path)?.length || 0,
        stackLabel: stackByProject.get(path) || null,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    // System tab first, then project tabs
    return [
      {
        id: SYSTEM_TAB_ID,
        label: SYSTEM_TAB_LABEL,
        count: systemCount,
        stackLabel: null,
      },
      ...projectTabs,
    ];
  }, [graphIndex]);

  // Per-project service tracking
  const {
    getProjectStatus,
    getDismissedServices,
    dismissService,
    restoreService,
    addService,
    removeService,
  } = useKnownServices(tabs, visibleGraphNodes, tabGrouping);
  const [serviceDropdownTab, setServiceDropdownTab] = useState<string | null>(
    null,
  );
  const [serviceActionError, setServiceActionError] = useState<string | null>(
    null,
  );
  const nodesForTab = useCallback(
    (tabId: string) => {
      if (tabId === SYSTEM_TAB_ID) return graphIndex.systemNodes;
      return graphIndex.nodesByTabPath.get(tabId) || [];
    },
    [graphIndex],
  );

  // Auto-select first available tab if current selection becomes invalid
  useEffect(() => {
    const tabIds = tabs.map((t) => t.id);
    if (!tabIds.includes(selectedTab) && tabs.length > 0) {
      setSelectedTab(tabs[0].id);
    }
  }, [tabs, selectedTab]);

  // Filter nodes based on selected tab
  const filteredData = useMemo(() => {
    const isSystemTab = selectedTab === SYSTEM_TAB_ID;

    // Get primary nodes for this tab (non-external nodes matching the filter)
    const primaryNodes = isSystemTab
      ? graphIndex.systemNodes
      : graphIndex.nodesByTabPath.get(selectedTab) || [];

    const primaryNodeIds = new Set(primaryNodes.map((n) => n.id));

    // Find external nodes connected to primary nodes
    const connectedExternalIds = new Set<string>();
    const inspectedEdgeIds = new Set<string>();
    primaryNodeIds.forEach((nodeId) => {
      const connectedEdges = edgeIndex.byNodeId.get(nodeId);
      if (!connectedEdges) return;
      connectedEdges.forEach((edge) => {
        if (inspectedEdgeIds.has(edge.id)) return;
        inspectedEdgeIds.add(edge.id);
        const sourceNode = graphIndex.nodeById.get(edge.source);
        const targetNode = graphIndex.nodeById.get(edge.target);

        if (sourceNode?.type === "external")
          connectedExternalIds.add(sourceNode.id);
        if (targetNode?.type === "external")
          connectedExternalIds.add(targetNode.id);
      });
    });

    // Include external nodes that are connected
    const externalNodes: GraphNode[] = [];
    connectedExternalIds.forEach((id) => {
      const node = graphIndex.nodeById.get(id);
      if (node) externalNodes.push(node);
    });

    // Inject tracked service nodes not already in the primary view.
    // Use both exact and loose keys so stale containerId in KnownService
    // doesn't cause duplicates or missed lookups (Bug 31/32).
    const trackedExtra: GraphNode[] = [];
    if (!isSystemTab) {
      const status = getProjectStatus(selectedTab);
      const primaryKeysExact = new Set(
        primaryNodes.map((n) => nodeServiceKey(n)),
      );
      const primaryKeysLoose = new Set(
        primaryNodes.map((n) =>
          looseServiceIdentity({
            ...n,
            projectPath: n.projectPath || undefined,
          }),
        ),
      );
      for (const svc of status.services) {
        const key = serviceKey(svc.service);
        const loose = looseServiceIdentity(svc.service);
        if (primaryKeysExact.has(key) || primaryKeysLoose.has(loose)) continue;

        // Look for a live node anywhere in the system — try exact then loose
        const liveNode =
          graphIndex.nodeByService.get(key) ||
          graphIndex.nodeByServiceLoose.get(loose);
        if (liveNode) {
          trackedExtra.push(liveNode);
        } else {
          // Create ghost node for tracked service that isn't running.
          // Try loose key too so stale containerId in `key` doesn't prevent
          // finding the last-seen node ID (Bug 31/32).
          trackedExtra.push({
            id:
              lastNodeIdByServiceRef.current.get(key) ||
              lastNodeIdByServiceRef.current.get(loose) ||
              `ghost-${key}`,
            pid: 0,
            name: svc.service.name,
            command: svc.service.lastCommand || "",
            type: svc.service.type as GraphNode["type"],
            cpu: 0,
            memory: 0,
            user: "",
            ports: [],
            healthStatus: "red",
            lastSeen: 0,
            isGhost: true,
            isDockerContainer: svc.service.isDockerContainer,
            containerId: svc.service.containerId,
            startCommand: svc.service.lastCommand,
            startProjectPath: svc.service.projectPath,
          });
        }
      }
    }

    const filteredNodes = [...primaryNodes, ...externalNodes, ...trackedExtra];
    const filteredNodeIds = new Set(filteredNodes.map((n) => n.id));

    // Filter edges to only include those between filtered nodes.
    // Build from adjacency index to avoid scanning the entire edge list each update.
    const filteredEdges: GraphEdge[] = [];
    const seenEdgeIds = new Set<string>();
    filteredNodeIds.forEach((nodeId) => {
      const connectedEdges = edgeIndex.byNodeId.get(nodeId);
      if (!connectedEdges) return;
      connectedEdges.forEach((edge) => {
        if (seenEdgeIds.has(edge.id)) return;
        if (
          !filteredNodeIds.has(edge.source) ||
          !filteredNodeIds.has(edge.target)
        )
          return;
        seenEdgeIds.add(edge.id);
        filteredEdges.push(edge);
      });
    });

    // Filter ports to only include those from primary nodes (not external)
    const primaryPorts = new Set<number>();
    primaryNodes.forEach((node) => {
      node.ports.forEach((p) => primaryPorts.add(p.port));
    });
    const filteredPorts = ports.filter((p) => primaryPorts.has(p.port));

    return {
      nodes: filteredNodes,
      edges: filteredEdges,
      ports: filteredPorts,
    };
  }, [graphIndex, edgeIndex, ports, selectedTab, getProjectStatus]);

  // Filter to show only running Docker containers
  const dockerContainerData = useMemo(() => {
    // Get only running Docker container nodes (exclude exited, dead, etc.)
    const containerNodes = graphIndex.nonExternalNodes.filter(
      (node) => node.isDockerContainer && node.containerState === "running",
    );
    const containerNodeIds = new Set(containerNodes.map((n) => n.id));

    // Filter edges to only include those between Docker containers
    const edgeIds = new Set<string>();
    const containerEdges: GraphEdge[] = [];
    containerNodeIds.forEach((nodeId) => {
      const connectedEdges = edgeIndex.byNodeId.get(nodeId);
      if (!connectedEdges) return;
      connectedEdges.forEach((edge) => {
        if (edgeIds.has(edge.id)) return;
        if (
          !containerNodeIds.has(edge.source) ||
          !containerNodeIds.has(edge.target)
        )
          return;
        edgeIds.add(edge.id);
        containerEdges.push(edge);
      });
    });

    // Get ports from containers
    const containerPorts = new Set<number>();
    containerNodes.forEach((node) => {
      node.ports.forEach((p) => containerPorts.add(p.port));
    });
    const filteredPorts = ports.filter((p) => containerPorts.has(p.port));

    return {
      nodes: containerNodes,
      edges: containerEdges,
      ports: filteredPorts,
    };
  }, [graphIndex.nonExternalNodes, edgeIndex, ports]);

  // Running database containers for the database list view
  const databaseNodes = useMemo(() => {
    return graphIndex.nonExternalNodes.filter(
      (node) =>
        node.isDockerContainer &&
        node.type === "database" &&
        node.containerState === "running",
    );
  }, [graphIndex.nonExternalNodes]);

  return (
    <div className="app">
      <div
        className="app-window-top-hitbox"
        onDoubleClick={handleHeaderDoubleClick}
      />
      <div className="app-profile-slot">
        {authSession?.signedIn && (
          <div className="app-profile-chip app-profile-chip-slot">
            {authSession.avatarUrl ? (
              <img
                src={authSession.avatarUrl}
                alt=""
                className="app-profile-avatar"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="app-profile-avatar app-profile-avatar-fallback" aria-hidden="true">
                {getAuthAvatarFallback(authSession.displayName || authSession.email)}
              </div>
            )}
            <div className="app-profile-copy">
              <span className="app-profile-name">
                {authSession.displayName || authSession.email}
              </span>
              <span className="app-profile-meta">
                Signed in with {authSession.provider === "google" ? "Google" : authSession.provider || "account"}
              </span>
            </div>
            <button
              className="app-profile-signout"
              onClick={() => window.electronAPI.authSignOut()}
            >
              Sign out
            </button>
          </div>
        )}
      </div>

      {/* Unified App Header */}
      <div className="app-header" onDoubleClick={handleHeaderDoubleClick}>
        <h1 className="app-title">fere</h1>

        {/* View Mode Tabs — inline in header */}
        <div className="view-mode-tabs" ref={viewModeTabsRef}>
          {indicatorStyle && (
            <div
              className="view-mode-indicator"
              style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
            />
          )}
          <button
            className={`view-mode-tab ${viewMode === "graph" ? "view-mode-tab-active" : ""}`}
            onClick={() => {
              setViewMode("graph");
              capture("tab_switched", { to: "graph" });
            }}
          >
            <span className="view-mode-icon">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <circle cx="3" cy="8" r="2" fill="currentColor" />
                <circle cx="13" cy="4" r="2" fill="currentColor" />
                <circle cx="13" cy="12" r="2" fill="currentColor" />
                <path
                  d="M5 8L11 5M5 8L11 11"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </span>
            Localhost Map
            {traceState.phase !== "idle" && viewMode !== "graph" && (
              <span className="trace-tab-indicator" />
            )}
          </button>
          <button
            className={`view-mode-tab ${viewMode === "containers" ? "view-mode-tab-active" : ""}`}
            onClick={() => {
              setViewMode("containers");
              capture("tab_switched", { to: "containers" });
            }}
          >
            <span className="view-mode-icon">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.185.185 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z" />
              </svg>
            </span>
            Containers
          </button>
          <button
            className={`view-mode-tab ${viewMode === "api-tester" ? "view-mode-tab-active" : ""}`}
            onClick={() => {
              setViewMode("api-tester");
              capture("tab_switched", { to: "api-tester" });
            }}
          >
            <span className="view-mode-icon">
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  d="M2 4L6 8L2 12"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 12H14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            Requests
          </button>
          <button
            className={`view-mode-tab ${viewMode === "database" ? "view-mode-tab-active" : ""}`}
            onClick={handleOpenDatabaseView}
          >
            <span className="view-mode-icon">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <ellipse cx="12" cy="5" rx="7" ry="3" />
                <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
              </svg>
            </span>
            Database
          </button>
          <button
            className={`view-mode-tab ${viewMode === "analytics" ? "view-mode-tab-active" : ""}`}
            onClick={() => {
              setViewMode("analytics");
              capture("tab_switched", { to: "analytics" });
            }}
          >
            <span className="view-mode-icon">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <polyline points="12 6 12 12 16 14" />
              </svg>
            </span>
            Analytics
            {analyticsBadge && <span className="analytics-tab-badge" />}
          </button>
        </div>

        {/* Command Palette */}
        <CommandPalette
          ref={commandPaletteRef}
          graph={graph}
          tabs={tabs}
          selectedTab={selectedTab}
          setSelectedTab={setSelectedTab}
          setViewMode={setViewMode}
          setIsAgentOpen={setIsAgentOpen}
        />

        {/* Header Actions */}
        <div className="app-header-actions">
          <AgentPanel
            nodes={filteredData.nodes}
            edges={filteredData.edges}
            tabLabel={
              selectedTab === SYSTEM_TAB_ID
                ? null
                : (tabs.find((t) => t.id === selectedTab)?.label ?? null)
            }
          />
          <button
            className="feedback-btn"
            onClick={() =>
              window.electronAPI?.openUrl?.(
                "https://docs.google.com/forms/d/e/1FAIpQLSdssI3HquKKE7Cskm797E24jKmfjdihUXKxEttJDQCw7HL4Mw/viewform",
              )
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M11.5 2.5a1.5 1.5 0 0 1 2.1 2.1L5 13.2l-3 .8.8-3Z" />
            </svg>
            Feedback
          </button>
          <button
            className="alert-toggle"
            onClick={() => setShowShare(true)}
            title="Share service map"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="3" r="1.5" />
              <circle cx="3" cy="8" r="1.5" />
              <circle cx="12" cy="13" r="1.5" />
              <line x1="4.4" y1="7.1" x2="10.6" y2="4.4" />
              <line x1="4.4" y1="8.9" x2="10.6" y2="11.6" />
            </svg>
          </button>
          <button
            className="alert-toggle"
            onClick={() => setShowStackDiff(true)}
            title="Stack Diff — compare your dev stack with a teammate"
            aria-label="Stack Diff"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              {/* two overlapping squares */}
              <rect x="1.5" y="4.5" width="8" height="8" rx="1.5" />
              <path d="M6.5 4.5V3a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 15.5 3v6a1.5 1.5 0 0 1-1.5 1.5h-1.5" />
            </svg>
          </button>
          <button
            className="alert-toggle"
            onClick={handleToggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? (
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="8" cy="8" r="2.8" />
                <line x1="8" y1="1.2" x2="8" y2="2.8" />
                <line x1="8" y1="13.2" x2="8" y2="14.8" />
                <line x1="1.2" y1="8" x2="2.8" y2="8" />
                <line x1="13.2" y1="8" x2="14.8" y2="8" />
                <line x1="3.3" y1="3.3" x2="4.4" y2="4.4" />
                <line x1="11.6" y1="11.6" x2="12.7" y2="12.7" />
                <line x1="12.7" y1="3.3" x2="11.6" y2="4.4" />
                <line x1="4.4" y1="11.6" x2="3.3" y2="12.7" />
              </svg>
            ) : (
              <svg
                width="15"
                height="15"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M13.2 10.4A6 6 0 0 1 5.6 2.8a6.2 6.2 0 1 0 7.6 7.6Z" />
              </svg>
            )}
          </button>
          <div style={{ position: "relative" } as React.CSSProperties}>
            <button
              className={`alert-toggle${alertsEnabled ? "" : " alert-toggle-off"}`}
              onClick={() => setAlertPanelOpen((v) => !v)}
              title={alertsEnabled ? "Notifications on" : "Notifications off"}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
              >
                <path d="M8 1.5C5.5 1.5 4 3.5 4 5.5V8L2.5 10.5V11.5H13.5V10.5L12 8V5.5C12 3.5 10.5 1.5 8 1.5Z" />
                <path d="M6 12.5C6 13.6 6.9 14.5 8 14.5C9.1 14.5 10 13.6 10 12.5" />
                {!alertsEnabled && <line x1="2" y1="14" x2="14" y2="2" />}
              </svg>
            </button>

            {alertPanelOpen && (
              <div className="alert-panel" ref={alertPanelRef}>
                {/* Master toggle */}
                <div className="alert-panel-master">
                  <span className="alert-panel-label">Notifications</span>
                  <button
                    className={`alert-panel-master-toggle${alertsEnabled ? " alert-panel-master-on" : ""}`}
                    onClick={handleToggleAlerts}
                  >
                    <span className="alert-panel-master-knob" />
                  </button>
                </div>

                {/* Category toggles */}
                <div className="alert-panel-categories">
                  {ALERT_CATEGORIES.map((cat) => (
                    <label className="alert-panel-category" key={cat.key}>
                      <input
                        type="checkbox"
                        checked={categoryToggles[cat.key]}
                        onChange={() => handleToggleCategory(cat.key)}
                        disabled={!alertsEnabled}
                        className="alert-panel-checkbox"
                      />
                      <div className="alert-panel-category-text">
                        <span className="alert-panel-category-label">
                          {cat.label}
                        </span>
                        <span className="alert-panel-category-desc">
                          {cat.desc}
                        </span>
                      </div>
                    </label>
                  ))}
                </div>

                <div className="alert-panel-divider" />

                {/* Event history */}
                <div className="alert-panel-history-header">
                  <span className="alert-panel-label">Recent Events</span>
                  {alertHistory.length > 0 && (
                    <button
                      className="alert-panel-clear"
                      onClick={handleClearHistory}
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="alert-panel-history">
                  {alertHistory.length === 0 ? (
                    <div className="alert-panel-history-empty">
                      No events yet
                    </div>
                  ) : (
                    alertHistory.slice(0, 50).map((event) => (
                      <div className="alert-panel-event" key={event.id}>
                        <span
                          className={`alert-panel-event-dot alert-panel-event-dot-${event.category}`}
                        />
                        <div className="alert-panel-event-content">
                          <span className="alert-panel-event-title">
                            {event.serviceName}
                            {!event.notified &&
                              event.category !== "discovery" && (
                                <span className="alert-panel-event-muted">
                                  {" "}
                                  (muted)
                                </span>
                              )}
                          </span>
                          <span className="alert-panel-event-desc">
                            {event.type === "container-stopped" && event.details
                              ? `stopped (${event.details})`
                              : ALERT_EVENT_LABELS[event.type] || event.type}
                          </span>
                        </div>
                        <span className="alert-panel-event-time">
                          {formatRelativeTime(event.timestamp)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="error-banner">
          <span className="error-title">Error:</span>
          <span className="error-message">{error}</span>
        </div>
      )}
      {serviceActionError && (
        <div className="error-banner">
          <span className="error-title">Action Error:</span>
          <span className="error-message">{serviceActionError}</span>
        </div>
      )}

      {/* Project Tabs - only show for graph view */}
      {viewMode === "graph" && tabs.length > 1 && (
        <div className="app-tabs" ref={appTabsRef}>
          <div className="app-tabs-scroll">
            {tabs.map((tab) => {
              const status = getProjectStatus(tab.id);
              const hasServices = status.total > 0;
              const allRunning = hasServices && status.running === status.total;
              const noneRunning = hasServices && status.running === 0;
              const statusColor = allRunning
                ? HEALTH_COLORS.green.color
                : noneRunning
                  ? HEALTH_COLORS.red.color
                  : HEALTH_COLORS.yellow.color;

              return (
                <div key={tab.id} className="app-tab-wrapper">
                  <button
                    ref={(el) => {
                      tabButtonRefs.current[tab.id] = el;
                    }}
                    className={`app-tab ${selectedTab === tab.id ? "app-tab-active" : ""}`}
                    onClick={() => {
                      if (selectedTab === tab.id) {
                        setServiceDropdownTab(
                          serviceDropdownTab === tab.id ? null : tab.id,
                        );
                      } else {
                        setSelectedTab(tab.id);
                        setServiceDropdownTab(null);
                      }
                    }}
                  >
                    {tab.label}
                    {tab.stackLabel && (
                      <span className="app-tab-stack">{tab.stackLabel}</span>
                    )}
                    {hasServices && (
                      <span className="app-tab-services">
                        <span
                          className="app-tab-services-dot"
                          style={{ backgroundColor: statusColor }}
                        />
                        {status.running}/{status.total}
                      </span>
                    )}
                    <span className="app-tab-count">{tab.count ?? 0}</span>
                  </button>
                </div>
              );
            })}
          </div>
          {serviceDropdownTab !== null &&
            (() => {
              const activeTab = tabs.find((t) => t.id === serviceDropdownTab);
              if (!activeTab) return null;
              const activeStatus = getProjectStatus(activeTab.id);
              const btnEl = tabButtonRefs.current[activeTab.id];
              const tabsEl = appTabsRef.current;
              let dropdownLeft = 16;
              if (btnEl && tabsEl) {
                const btnRect = btnEl.getBoundingClientRect();
                const tabsRect = tabsEl.getBoundingClientRect();
                dropdownLeft = btnRect.left - tabsRect.left;
              }
              return (
                <div
                  style={{
                    position: "absolute",
                    top: "100%",
                    left: dropdownLeft,
                    zIndex: 1000,
                  }}
                >
                  <ServiceDropdown
                    services={activeStatus.services}
                    dismissedServices={getDismissedServices(activeTab.id)}
                    onDismiss={(key) => dismissService(activeTab.id, key)}
                    onRestore={(key) => restoreService(activeTab.id, key)}
                    onRemove={(key) => removeService(activeTab.id, key)}
                    onAdd={(node) =>
                      addService(activeTab.id, {
                        name: node.name,
                        type: node.type,
                        containerId: node.containerId || undefined,
                        projectPath: node.projectPath || undefined,
                        isDockerContainer: node.isDockerContainer || false,
                        command: node.command || undefined,
                      })
                    }
                    onStart={async (service) => {
                      try {
                        let started = false;
                        let failureReason: string | undefined;
                        if (service.isDockerContainer) {
                          const id = service.containerId || service.name;
                          const result =
                            await window.electronAPI.startContainer(id);
                          started = !!result?.success;
                          failureReason = result?.error;
                        } else if (service.lastCommand && service.projectPath) {
                          const result = await window.electronAPI.startProcess(
                            service.lastCommand,
                            service.projectPath,
                          );
                          started = !!result?.success;
                          failureReason = result?.error;
                        } else {
                          failureReason =
                            "Missing start command or project path";
                        }
                        if (started) {
                          setServiceActionError(null);
                          window.dispatchEvent(
                            new CustomEvent("fere:refresh-snapshot"),
                          );
                        } else if (failureReason) {
                          setServiceActionError(failureReason);
                        }
                      } catch (err) {
                        setServiceActionError(
                          err instanceof Error
                            ? err.message
                            : "Failed to start service",
                        );
                      }
                    }}
                    allNodes={nodesForTab(activeTab.id)}
                    onClose={() => setServiceDropdownTab(null)}
                  />
                </div>
              );
            })()}
          <div className="app-tabs-controls">
            <div
              className="tab-grouping-toggle"
              role="group"
              aria-label="Tab grouping mode"
            >
              <button
                className={`tab-grouping-btn ${tabGrouping === "repo" ? "tab-grouping-btn-active" : ""}`}
                onClick={() => setTabGrouping("repo")}
              >
                Repo
              </button>
              <button
                className={`tab-grouping-btn ${tabGrouping === "subproject" ? "tab-grouping-btn-active" : ""}`}
                onClick={() => setTabGrouping("subproject")}
              >
                Subproject
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main Content */}
      <div className="app-body">
        <main className="main-content">
          <TraceContext.Provider value={traceState}>
            <TraceDispatchContext.Provider value={traceDispatch}>
              <ErrorBoundary>
                <div
                  className={`main-view ${viewMode === "graph" ? "main-view-active" : ""}`}
                >
                  <div className="graph-container">
                    {loading ? (
                      <div className="loading">Scanning localhost...</div>
                    ) : (
                      <GraphView
                        nodes={filteredData.nodes}
                        edges={filteredData.edges}
                        serviceStatus={serviceStatus}
                        monitoringStartedAt={monitoringStartedAt}
                      />
                    )}
                  </div>
                </div>

                <div
                  className={`main-view ${viewMode === "containers" ? "main-view-active" : ""}`}
                >
                  <div className="containers-view">
                    <div className="app-tabs app-tabs-inline">
                      <button
                        className={`app-tab ${containerSubTab === "overview" ? "app-tab-active" : ""}`}
                        onClick={() => setContainerSubTab("overview")}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 16 16"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <rect x="2.5" y="3" width="11" height="10" rx="2" />
                          <line x1="2.5" y1="6" x2="13.5" y2="6" />
                        </svg>
                        Overview
                      </button>
                      <button
                        className={`app-tab ${containerSubTab === "logs" ? "app-tab-active" : ""}`}
                        onClick={() => setContainerSubTab("logs")}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                          <line x1="16" y1="13" x2="8" y2="13" />
                          <line x1="16" y1="17" x2="8" y2="17" />
                        </svg>
                        Logs
                      </button>
                    </div>

                    <div
                      className={`containers-overview containers-sub-view ${containerSubTab === "overview" ? "containers-sub-view-active" : ""}`}
                    >
                      <div
                        className={`graph-container${!loading && dockerContainerData.nodes.length === 0 ? " graph-container-empty" : ""}`}
                      >
                        {loading ? (
                          <div className="loading">
                            Scanning Docker containers...
                          </div>
                        ) : dockerContainerData.nodes.length === 0 ? (
                          <DockerEmptyState
                            dockerStatus={serviceStatus.docker}
                          />
                        ) : (
                          <GraphView
                            nodes={dockerContainerData.nodes}
                            edges={dockerContainerData.edges}
                            isContainerView={true}
                            onDatabaseClick={handleDatabaseClick}
                          />
                        )}
                      </div>
                    </div>
                    <div
                      className={`containers-logs containers-sub-view ${containerSubTab === "logs" ? "containers-sub-view-active" : ""}`}
                    >
                      <ContainerLogsTab
                        containers={dockerContainerData.nodes}
                        initialSelectedId={initialLogContainerId}
                      />
                    </div>
                  </div>
                </div>

                <div
                  className={`main-view main-view-single ${viewMode === "database" ? "main-view-active" : ""}`}
                >
                  <div className="api-tester-container">
                    <DatabaseListView
                      databaseNodes={databaseNodes}
                      selectedNode={databaseNode}
                      onSelectNode={setDatabaseNode}
                    />
                  </div>
                </div>

                <div
                  className={`main-view main-view-single ${viewMode === "api-tester" ? "main-view-active" : ""}`}
                >
                  <div className="api-tester-container">
                    {loading ? (
                      <div className="loading">Scanning localhost...</div>
                    ) : (
                      <CurlBuilder
                        nodes={visibleGraphNodes}
                        onTraceRequest={handleTraceRequest}
                      />
                    )}
                  </div>
                </div>

                <div
                  className={`main-view main-view-single ${viewMode === "analytics" ? "main-view-active" : ""}`}
                >
                  <AnalyticsView tabs={tabs} graphNodes={visibleGraphNodes} />
                </div>
              </ErrorBoundary>
            </TraceDispatchContext.Provider>
          </TraceContext.Provider>
        </main>
      </div>

      {/* Welcome Modal */}
      {showWelcome && <WelcomeModal onClose={handleCloseWelcome} />}

      {/* Share Modal */}
      {showShare && (
        <ShareModal
          onClose={() => setShowShare(false)}
          graphNodes={filteredData.nodes}
          graphEdges={filteredData.edges}
          activeTabLabel={
            tabs.find((t) => t.id === selectedTab)?.label ?? SYSTEM_TAB_LABEL
          }
        />
      )}

      {/* Stack Diff Modal */}
      {showStackDiff && (
        <StackDiffModal onClose={() => setShowStackDiff(false)} />
      )}
    </div>
  );
}

export default App;
