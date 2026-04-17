const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  nativeImage,
  Notification,
  clipboard,
  powerMonitor,
  dialog,
  safeStorage,
  nativeTheme,
} = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const os = require("os");
const crypto = require("crypto");
require("dotenv").config({ path: path.join(__dirname, "../.env") });

function loadRuntimeConfig() {
  const configPath = path.join(__dirname, "runtime-config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

const runtimeConfig = loadRuntimeConfig();

// Import security utilities
const {
  validateExternalUrl,
  validateHttpRequestUrl,
  isPrivateHost,
  setupNavigationBlocking,
  setupWindowOpenHandler,
  setupPermissionHandlers,
  setupCSP,
  MAX_RESPONSE_SIZE,
  getNetworkPolicy,
  setNetworkPolicy,
} = require("./security");

/**
 * Extract hostname from a database connection URI and reject private/internal addresses.
 * Supports mongodb://, mongodb+srv://, postgresql://, postgres://, http://, https://.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
function validateRemoteDbUri(uri) {
  if (!uri || typeof uri !== "string") {
    return { valid: false, reason: "URI must be a non-empty string" };
  }

  let parsed;
  try {
    // mongodb+srv:// isn't recognized by URL natively, normalize to https for parsing
    const normalized = uri.replace(/^mongodb(\+srv)?:\/\//, "https://");
    parsed = new URL(normalized);
  } catch {
    return { valid: false, reason: "Invalid URI format" };
  }

  if (isPrivateHost(parsed.hostname)) {
    return {
      valid: false,
      reason:
        "Connections to private/internal addresses are not allowed for remote URIs",
    };
  }

  return { valid: true };
}

// Import services
const {
  getDevProcesses,
  getAllProcesses,
  getProcessByPid,
  killProcess,
  clearProcessCache,
} = require("./services/processMonitor");
const {
  getListeningPorts,
  getEstablishedConnections,
  clearPortCache,
} = require("./services/portMonitor");
const {
  buildConnectionGraph,
  getEnvironmentSummary,
} = require("./services/connectionGraph");
const { getSystemSnapshot } = require("./services/systemSnapshot");
const { SnapshotScheduler } = require("./services/snapshotScheduler");
const {
  scanExternalApis,
  getExternalApiProviders,
} = require("./services/externalApiScanner");
const {
  scanRoutes,
  clearRouteCache,
  getRouteCacheTimestamp,
} = require("./services/routeScanner");
const {
  loadHistory,
  saveHistoryEntry,
  clearHistory,
} = require("./services/requestHistory");
const {
  getDatabaseTables,
  getTableData,
  executeQuery,
  createTable,
  connectMongoUri,
  getMongoUriCollectionData,
  executeMongoUriQuery,
  connectPostgresUri,
  getPostgresUriTableData,
  executePostgresUriQuery,
  connectElasticsearchUri,
  getElasticsearchUriIndexData,
  executeElasticsearchUriQuery,
} = require("./services/databaseQuery");
const {
  isDockerAvailable,
  getDockerContainers,
  getDockerNetworks,
  getDockerSnapshot,
  stopContainer,
  startContainer,
  restartContainer,
  startComposeProject,
} = require("./services/dockerMonitor");
const {
  startLogStream,
  stopLogStream,
  stopContainerStreams,
  stopAllStreams,
  getActiveStreams,
} = require("./services/containerLogs");
const {
  initAlertManager,
  evaluateAlerts,
  getAlertPreferences,
  setAlertPreferences,
  getAlertHistory,
  clearAlertHistory,
  markIntentionalStopForPid,
  markIntentionalStopForContainer,
} = require("./services/alertManager");
const {
  initActivityLog,
  shutdownActivityLog,
  logEvent: logActivityEvent,
  getActivityLog,
  activityEmitter,
} = require("./services/activityLog");
const {
  feedFromSnapshot,
  getMetricHistory,
  checkAnomalies,
} = require("./services/metricHistory");
const analytics = require("./analytics");
const {
  runScan,
  executeAction,
  buildChatContext,
  buildNodeDetails,
} = require("./services/fereAgent");
const { openInClaudeCode } = require("./services/claudeCodeBrief");
const OpenAI = require("openai").default;
const sentry = require("./sentry");
const { generateHTML } = require("./services/graphExporter");
const {
  createGist,
  updateGist,
  buildPreviewUrl,
} = require("./services/gistPublisher");
const { executeTracedRequest } = require("./services/traceCapture");

app.setName("Fere");
app.name = "Fere";
process.title = "Fere";

// Keep a global reference of the window object
let mainWindow;
let snapshotScheduler = null;
let snapshotHandler = null;
let activityEventHandler = null;
let alertNodeMap = new Map();
const _surfacedFindingIds = new Set();
// id → severity of last surfaced finding, for worsened detection
const _surfacedFindingSeverity = new Map();
// Suppress repeated critical notifications within 60s per finding id
const _notifiedCriticalAt = new Map();
const logStreamsBySender = new Map();

function logSentinelActivity(title, detail = "", projectName = null) {
  logActivityEvent({
    category: "sentinel",
    severity: "info",
    title,
    detail,
    serviceName: null,
    serviceId: null,
    projectName,
  });
}

function registerSenderLogStream(sender, streamId) {
  if (!sender || sender.isDestroyed() || !streamId) return;
  const senderId = sender.id;
  let entry = logStreamsBySender.get(senderId);

  if (!entry) {
    const streamIds = new Set();
    const onDestroyed = () => {
      const current = logStreamsBySender.get(senderId);
      if (!current) return;
      current.streamIds.forEach((id) => stopLogStream(id));
      logStreamsBySender.delete(senderId);
    };

    sender.once("destroyed", onDestroyed);
    entry = { sender, streamIds, onDestroyed };
    logStreamsBySender.set(senderId, entry);
  }

  entry.streamIds.add(streamId);
}

function unregisterSenderLogStream(sender, streamId) {
  if (!sender || !streamId) return;
  const entry = logStreamsBySender.get(sender.id);
  if (!entry) return;

  entry.streamIds.delete(streamId);
  if (entry.streamIds.size === 0) {
    entry.sender.removeListener("destroyed", entry.onDestroyed);
    logStreamsBySender.delete(sender.id);
  }
}

function unregisterLogStreamEverywhere(streamId) {
  for (const [senderId, entry] of logStreamsBySender.entries()) {
    if (!entry.streamIds.delete(streamId)) continue;
    if (entry.streamIds.size === 0) {
      entry.sender.removeListener("destroyed", entry.onDestroyed);
      logStreamsBySender.delete(senderId);
    }
  }
}

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

process.on("uncaughtException", (err) => {
  sentry.captureException(err);
  console.error("Uncaught exception:", err);
});

process.on("unhandledRejection", (reason) => {
  sentry.captureException(
    reason instanceof Error ? reason : new Error(String(reason)),
  );
  console.error("Unhandled rejection:", reason);
});

function resolveAppIconPath() {
  const devIconPath = path.join(__dirname, "../public/icon.png");
  const prodIconPath = path.join(__dirname, "../build/icon.png");
  const legacyIconPath = path.join(__dirname, "../assets/icon.png");

  if (isDev) return devIconPath;
  if (fs.existsSync(prodIconPath)) return prodIconPath;
  return legacyIconPath;
}

function createWindow() {
  const appIconPath = resolveAppIconPath();
  const platformUI = require("./services/platform");
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Fere",
    icon: appIconPath,
    ...platformUI.getWindowOptions(),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      // Security hardening
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL("http://localhost:3001");
  } else {
    mainWindow.loadFile(path.join(__dirname, "../build/index.html"));
  }

  // Guard against Chromium/Electron page zoom getting stuck across launches.
  // React Flow handles in-canvas zoom itself; the shell should stay at 100%.
  mainWindow.webContents.setZoomFactor(1);
  mainWindow.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow?.webContents.setZoomFactor(1);
  });

  // Security: Set up navigation blocking
  // Allow only dev server in development, file:// protocol in production
  const allowedOrigins = isDev
    ? [
        "http://localhost:3001",
        "http://127.0.0.1:3001",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
      ]
    : ["file://"];
  setupNavigationBlocking(mainWindow.webContents, allowedOrigins);

  // Security: Block new windows, open http/https in external browser
  setupWindowOpenHandler(mainWindow.webContents);

  // Throttle snapshot collection when app is not visible
  mainWindow.on("minimize", () => {
    if (snapshotScheduler) snapshotScheduler.throttle();
  });
  mainWindow.on("hide", () => {
    if (snapshotScheduler) snapshotScheduler.throttle();
  });
  mainWindow.on("focus", () => {
    if (snapshotScheduler) snapshotScheduler.unthrottle();
  });
  mainWindow.on("restore", () => {
    if (snapshotScheduler) snapshotScheduler.unthrottle();
  });
  mainWindow.on("show", () => {
    if (snapshotScheduler) snapshotScheduler.unthrottle();
  });

  // Hide instead of close — keeps process alive for background notifications
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
      if (snapshotScheduler) snapshotScheduler.throttle();
    }
  });

  mainWindow.on("closed", () => {
    if (snapshotScheduler) {
      snapshotScheduler.stop();
      snapshotScheduler.removeAllListeners();
      snapshotScheduler = null;
      snapshotHandler = null;
      alertNodeMap = new Map();
    }
    mainWindow = null;
  });
}

// Keep Chromium's smoother scrolling path without forcing unlimited redraws.
app.commandLine.appendSwitch("enable-smooth-scrolling");
app.commandLine.appendSwitch("enable-gpu-rasterization");

app.setAsDefaultProtocolClient("fere");

app.on("open-url", (event, url) => {
  event.preventDefault();
  if (url.startsWith("fere://auth/callback")) {
    handleAuthCallback(url);
  }
});

app.whenReady().then(() => {
  // Security: Set up default-deny permission handlers
  setupPermissionHandlers();

  // Security: Set up CSP (different for dev vs production)
  setupCSP(isDev);

  // Initialize alert manager (loads preferences from disk)
  initAlertManager();
  initActivityLog();

  // Initialize error reporting
  sentry.init(isDev);

  // Initialize analytics
  analytics.init();
  analytics.capture("app_launched", { is_dev: isDev });

  if (process.platform === "darwin" && isDev) {
    const platformUI = require("./services/platform");
    platformUI.setupDockIcon(app, nativeImage, resolveAppIconPath());
  }
  // Power-aware scheduling: slow down on battery
  powerMonitor.on("on-ac", () => {
    if (snapshotScheduler) snapshotScheduler.setBattery(false);
  });
  powerMonitor.on("on-battery", () => {
    if (snapshotScheduler) snapshotScheduler.setBattery(true);
  });

  createWindow();

  // Refresh auth token on launch and every 30 minutes
  refreshAuthToken().catch(() => {});
  setInterval(() => refreshAuthToken().catch(() => {}), 30 * 60 * 1000);

  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify();
  }
});

app.on("window-all-closed", () => {
  const platformUI = require("./services/platform");
  if (platformUI.shouldQuitOnAllWindowsClosed()) {
    app.quit();
  }
});

app.on("before-quit", () => {
  app.isQuitting = true;
});

app.on("will-quit", async () => {
  await sentry.flush();
  try {
    shutdownActivityLog();
    await analytics.shutdown();
  } catch (err) {
    console.error("Error shutting down analytics:", err);
  }
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  } else {
    mainWindow.show();
    if (snapshotScheduler) snapshotScheduler.unthrottle();
  }
});

/**
 * Maintain a shadow copy of all graph nodes from snapshot deltas
 * for alert evaluation purposes.
 */
function updateAlertNodeMap(delta) {
  if (
    delta.type === "full" &&
    delta.graph &&
    Array.isArray(delta.graph.nodes)
  ) {
    alertNodeMap = new Map(delta.graph.nodes.map((n) => [n.id, n]));
    return;
  }
  if (delta.graph && delta.graph.nodes) {
    const nd = delta.graph.nodes;
    if (nd.removed) {
      for (const id of nd.removed) alertNodeMap.delete(id);
    }
    if (nd.added) {
      for (const node of nd.added) alertNodeMap.set(node.id, node);
    }
    if (nd.modified) {
      for (const patch of nd.modified) {
        const existing = alertNodeMap.get(patch.id);
        if (existing) Object.assign(existing, patch);
      }
    }
  }
}

// ============================================
// IPC Handlers - System Monitoring API
// ============================================

// Get all dev-related processes (filtered)
ipcMain.handle("get-dev-processes", async () => {
  try {
    return await getDevProcesses();
  } catch (error) {
    console.error("Error getting dev processes:", error);
    return [];
  }
});

// Get all processes (unfiltered)
ipcMain.handle("get-all-processes", async () => {
  try {
    return await getAllProcesses();
  } catch (error) {
    console.error("Error getting all processes:", error);
    return [];
  }
});

// Get listening ports
ipcMain.handle("get-listening-ports", async () => {
  try {
    return await getListeningPorts();
  } catch (error) {
    console.error("Error getting listening ports:", error);
    return [];
  }
});

// Get established connections
ipcMain.handle("get-connections", async () => {
  try {
    return await getEstablishedConnections();
  } catch (error) {
    console.error("Error getting connections:", error);
    return [];
  }
});

// Get the full connection graph (nodes + edges)
ipcMain.handle("get-connection-graph", async () => {
  try {
    return await buildConnectionGraph();
  } catch (error) {
    console.error("Error building connection graph:", error);
    return { nodes: [], edges: [] };
  }
});

// Get a full system snapshot (processes, ports, connections, graph)
ipcMain.handle("get-system-snapshot", async () => {
  try {
    // Prefer the scheduler's last cached snapshot — it includes source-analysis edges,
    // CWD cache, and edge memory. Fall back to getSystemSnapshot() only on cold start
    // before the scheduler has produced its first snapshot.
    if (snapshotScheduler && snapshotScheduler.previousSnapshot) {
      return snapshotScheduler.previousSnapshot;
    }
    return await getSystemSnapshot();
  } catch (error) {
    console.error("Error getting system snapshot:", error);
    return {
      processes: [],
      ports: [],
      connections: [],
      graph: { nodes: [], edges: [] },
    };
  }
});

// Start push-based snapshot stream (event-driven pipeline)
ipcMain.handle("start-snapshot-stream", async (event) => {
  try {
    // Clean up any existing scheduler
    if (snapshotScheduler) {
      if (snapshotHandler) {
        snapshotScheduler.removeListener("snapshot", snapshotHandler);
      }
      snapshotScheduler.stop();
    }

    snapshotScheduler = new SnapshotScheduler();
    if (typeof powerMonitor.isOnBatteryPower === "function") {
      snapshotScheduler.setBattery(powerMonitor.isOnBatteryPower());
    }

    // Persistent listener: evaluate alerts even when window is hidden
    snapshotScheduler.on("snapshot", (delta) => {
      try {
        updateAlertNodeMap(delta);
        evaluateAlerts(Array.from(alertNodeMap.values()));
      } catch (err) {
        console.error("[AlertManager] Error evaluating alerts:", err);
      }
      try {
        const nodes =
          delta.type === "full" && delta.graph && Array.isArray(delta.graph.nodes)
            ? delta.graph.nodes
            : Array.from(alertNodeMap.values());
        feedFromSnapshot(nodes);
        checkAnomalies();
      } catch (err) {
        console.error("[MetricHistory] Error feeding metrics:", err);
      }
    });

    // Proactive scan: diff findings and surface new/worsened/resolved issues
    snapshotScheduler.on("snapshot", async (delta) => {
      if (delta.type !== "full") return; // only run on full snapshots
      try {
        const snap = await getSystemSnapshot();
        const findings = await runScan(snap);
        const currentIds = new Set(findings.map((f) => f.id));
        const severityRank = { critical: 2, warning: 1, suggestion: 0 };

        // Detect resolved findings (previously surfaced, no longer present)
        const resolvedIds = [];
        for (const id of _surfacedFindingIds) {
          if (!currentIds.has(id)) {
            resolvedIds.push(id);
            _surfacedFindingIds.delete(id);
            _surfacedFindingSeverity.delete(id);
          }
        }

        // Detect new findings and worsened findings
        const newFindings = [];
        const worsenedFindings = [];
        for (const f of findings) {
          if (f.severity !== "critical" && f.severity !== "warning") continue;
          const prevSev = _surfacedFindingSeverity.get(f.id);
          if (!_surfacedFindingIds.has(f.id)) {
            newFindings.push(f);
            _surfacedFindingIds.add(f.id);
            _surfacedFindingSeverity.set(f.id, f.severity);
          } else if (
            prevSev &&
            (severityRank[f.severity] ?? 0) > (severityRank[prevSev] ?? 0)
          ) {
            worsenedFindings.push(f);
            _surfacedFindingSeverity.set(f.id, f.severity);
          }
        }

        const windows = BrowserWindow.getAllWindows().filter(
          (w) => !w.isDestroyed(),
        );

        // Broadcast resolved finding IDs
        if (resolvedIds.length > 0) {
          windows.forEach((win) =>
            win.webContents.send("agent:finding-resolved", resolvedIds),
          );
        }

        // Broadcast worsened findings
        if (worsenedFindings.length > 0) {
          windows.forEach((win) =>
            win.webContents.send("agent:finding-worsened", worsenedFindings),
          );
        }

        // Broadcast new findings
        if (newFindings.length > 0) {
          windows.forEach((win) =>
            win.webContents.send("agent:proactive-finding", newFindings),
          );

          // OS notification for critical findings when window is not focused
          const criticals = newFindings.filter(
            (f) => f.severity === "critical",
          );
          const now = Date.now();
          const notifyThrottle = 60_000; // 1 notification per finding per minute
          for (const f of criticals) {
            const lastNotified = _notifiedCriticalAt.get(f.id) ?? 0;
            if (now - lastNotified < notifyThrottle) continue;
            const focused = windows.some((w) => w.isFocused());
            if (!focused) {
              try {
                new Notification({
                  title: `Sentinel — ${f.severity === "critical" ? "Critical" : "Warning"}`,
                  body: `${f.service}: ${f.summary}`,
                  silent: false,
                }).show();
              } catch (_) {}
            }
            _notifiedCriticalAt.set(f.id, now);
          }
        }
      } catch (_) {}
    });

    // Renderer listener: forward deltas to the window (removed when window goes away)
    snapshotHandler = (delta) => {
      if (event.sender.isDestroyed()) {
        snapshotScheduler.removeListener("snapshot", snapshotHandler);
        return;
      }
      event.sender.send("snapshot-delta", delta);
    };

    snapshotScheduler.on("snapshot", snapshotHandler);

    activityEventHandler = (activityEvent) => {
      if (event.sender.isDestroyed()) {
        activityEmitter.removeListener("event", activityEventHandler);
        return;
      }
      event.sender.send("activity-event", activityEvent);
    };
    activityEmitter.on("event", activityEventHandler);
    snapshotScheduler.start();

    return { success: true };
  } catch (error) {
    console.error("Error starting snapshot stream:", error);
    return { success: false, error: error.message };
  }
});

// Stop push-based snapshot stream
ipcMain.handle("stop-snapshot-stream", async () => {
  if (activityEventHandler) {
    activityEmitter.removeListener("event", activityEventHandler);
    activityEventHandler = null;
  }
  if (snapshotScheduler) {
    if (snapshotHandler) {
      snapshotScheduler.removeListener("snapshot", snapshotHandler);
      snapshotHandler = null;
    }
    try {
      snapshotScheduler.stop();
    } catch (err) {
      console.error("Error stopping snapshot scheduler:", err);
    }
    snapshotScheduler = null;
  }
  return { success: true };
});

// Get environment summary
ipcMain.handle("get-environment-summary", async () => {
  try {
    return await getEnvironmentSummary();
  } catch (error) {
    console.error("Error getting environment summary:", error);
    return { totalServices: 0, totalConnections: 0, services: [] };
  }
});

// Rescan routes for a project path (clears cache, returns fresh routes + timestamp)
ipcMain.handle("rescan-routes", async (event, projectPath) => {
  try {
    if (!projectPath || typeof projectPath !== "string") {
      return { routes: [], scannedAt: null };
    }
    const resolvedPath = path.resolve(projectPath);
    clearRouteCache(resolvedPath);
    const routes = await scanRoutes(resolvedPath);
    return { routes, scannedAt: getRouteCacheTimestamp(resolvedPath) };
  } catch (error) {
    console.error("Error rescanning routes:", error);
    return { routes: [], scannedAt: null };
  }
});

// Get external APIs for a project path (on-demand, with TTL cache)
const _externalApisCache = new Map(); // path → { data, time }
const _EXTERNAL_APIS_CACHE_TTL = 30000; // 30s

ipcMain.handle("get-external-apis", async (event, projectPath) => {
  try {
    if (!projectPath || typeof projectPath !== "string") {
      return [];
    }
    const resolvedPath = path.resolve(projectPath);

    // Check TTL cache — evict stale entries to prevent unbounded growth
    const now = Date.now();
    const cached = _externalApisCache.get(resolvedPath);
    if (cached && now - cached.time < _EXTERNAL_APIS_CACHE_TTL) {
      return cached.data;
    }
    if (cached) _externalApisCache.delete(resolvedPath);
    // Periodic sweep: if the cache has grown large, prune all expired entries
    if (_externalApisCache.size > 50) {
      for (const [k, v] of _externalApisCache) {
        if (now - v.time >= _EXTERNAL_APIS_CACHE_TTL)
          _externalApisCache.delete(k);
      }
    }

    if (!fs.existsSync(resolvedPath)) {
      return [];
    }
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return [];
    }
    const data = await scanExternalApis(resolvedPath);
    _externalApisCache.set(resolvedPath, { data, time: Date.now() });
    return data;
  } catch (error) {
    console.error("Error getting external APIs:", error);
    return [];
  }
});

ipcMain.handle("get-external-api-providers", async () => {
  try {
    return getExternalApiProviders();
  } catch (error) {
    console.error("Error getting external API providers:", error);
    return [];
  }
});

// Kill a process by PID
ipcMain.handle("kill-process", async (event, pid) => {
  try {
    // Validate PID is a positive integer
    if (!Number.isInteger(pid) || pid <= 0) {
      return { success: false, error: "Invalid PID" };
    }

    const proc = await getProcessByPid(pid);
    if (!proc) {
      return {
        success: false,
        error: "Process not found or already terminated",
      };
    }

    // Allow killing any process shown in the graph (they all have listening ports)
    // The graph only shows dev-related processes and processes with network activity
    const result = await killProcess(pid);
    analytics.capture("process_killed", { success: result.success });
    if (result.success) {
      logActivityEvent({
        category: "user-action",
        severity: "info",
        title: `Killed process ${proc.name || pid} (PID ${pid})`,
        serviceName: proc.name || null,
        serviceId: null,
        projectName: proc.project || null,
      });
      markIntentionalStopForPid(pid);
      // Force next snapshot to bypass stale 5s caches.
      clearProcessCache();
      clearPortCache();
      if (snapshotScheduler) {
        // Trigger immediate reconciliation so UI reflects kill quickly.
        setImmediate(() => snapshotScheduler.reconcile());
      }
    }
    return result;
  } catch (error) {
    console.error("Error killing process:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("stop-container", async (event, containerId) => {
  try {
    if (!containerId || typeof containerId !== "string") {
      return { success: false, error: "Invalid container ID" };
    }
    const result = await stopContainer(containerId);
    if (result.success) {
      const node = alertNodeMap.get(containerId);
      logActivityEvent({
        category: "user-action",
        severity: "info",
        title: `Stopped container ${node?.name || containerId.slice(0, 12)}`,
        serviceName: node?.name || null,
        serviceId: null,
        projectName: node?.project || null,
      });
      markIntentionalStopForContainer(containerId);
      clearProcessCache();
      clearPortCache();
      if (snapshotScheduler) {
        setImmediate(() => snapshotScheduler.reconcile());
      }
    }
    return result;
  } catch (error) {
    console.error("Error stopping container:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("start-container", async (event, containerId) => {
  try {
    if (!containerId || typeof containerId !== "string") {
      return { success: false, error: "Invalid container ID" };
    }
    const result = await startContainer(containerId);
    if (result.success) {
      const node = alertNodeMap.get(containerId);
      logActivityEvent({
        category: "user-action",
        severity: "info",
        title: `Started container ${node?.name || containerId.slice(0, 12)}`,
        serviceName: node?.name || null,
        serviceId: null,
        projectName: node?.project || null,
      });
      clearProcessCache();
      clearPortCache();
      if (snapshotScheduler) {
        setImmediate(() => snapshotScheduler.reconcile());
      }
    }
    return result;
  } catch (error) {
    console.error("Error starting container:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("restart-container", async (event, containerId) => {
  try {
    if (!containerId || typeof containerId !== "string") {
      return { success: false, error: "Invalid container ID" };
    }
    const result = await restartContainer(containerId);
    if (result.success) {
      clearProcessCache();
      clearPortCache();
      if (snapshotScheduler) {
        setImmediate(() => snapshotScheduler.reconcile());
      }
    }
    return result;
  } catch (error) {
    console.error("Error restarting container:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("start-compose-project", async (event, composeFilePath, services) => {
  try {
    if (!composeFilePath || typeof composeFilePath !== "string") {
      return { success: false, error: "Invalid compose file path" };
    }
    const serviceList = Array.isArray(services) ? services : [];
    const result = await startComposeProject(composeFilePath, serviceList);
    if (result.success) {
      clearProcessCache();
      clearPortCache();
      if (snapshotScheduler) {
        setImmediate(() => snapshotScheduler.reconcile());
      }
    }
    return result;
  } catch (error) {
    console.error("Error starting compose project:", error);
    return { success: false, error: error.message };
  }
});

// Allowlisted binaries for start-process (prevents arbitrary command execution)
const ALLOWED_BINARIES = new Set([
  // Node.js / JavaScript
  "node",
  "npm",
  "npx",
  "yarn",
  "pnpm",
  "bun",
  "deno",
  "tsx",
  "ts-node",
  // Python
  "python",
  "python3",
  "pip",
  "pip3",
  "uvicorn",
  "gunicorn",
  "flask",
  "django-admin",
  "poetry",
  "pipenv",
  "uv",
  // Ruby
  "ruby",
  "rails",
  "bundle",
  "bundler",
  "rake",
  "puma",
  // Java / JVM
  "java",
  "javac",
  "mvn",
  "mvnw",
  "gradle",
  "gradlew",
  "./gradlew",
  "./mvnw",
  // Go
  "go",
  "air",
  // Rust
  "cargo",
  "rustc",
  // PHP
  "php",
  "composer",
  "artisan",
  // .NET
  "dotnet",
  // Elixir / Erlang
  "mix",
  "elixir",
  "iex",
  // Docker (compose only)
  "docker-compose",
  // General
  "make",
]);

/**
 * Parse a command string into [binary, ...args] without using a shell.
 * Supports simple quoting (single and double quotes).
 */
function parseCommand(command) {
  const args = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }

    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }

    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if ((ch === " " || ch === "\t") && !inSingle && !inDouble) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (current.length > 0) {
    args.push(current);
  }

  if (inSingle || inDouble || escaped) {
    return null;
  }

  return args;
}

ipcMain.handle("start-process", async (event, command, cwd) => {
  try {
    if (!command || typeof command !== "string") {
      return { success: false, error: "Invalid command" };
    }
    if (!cwd || typeof cwd !== "string") {
      return { success: false, error: "Invalid working directory" };
    }

    // Validate cwd is an existing directory
    const fs = require("fs");
    try {
      const stat = fs.statSync(cwd);
      if (!stat.isDirectory()) {
        return {
          success: false,
          error: "Working directory is not a directory",
        };
      }
    } catch {
      return { success: false, error: "Working directory does not exist" };
    }

    // Reject shell metacharacters that indicate shell piping/chaining
    if (/[|;&`$><\n]/.test(command)) {
      return {
        success: false,
        error: "Command contains disallowed shell metacharacters",
      };
    }

    const parts = parseCommand(command);
    if (!parts) {
      return {
        success: false,
        error: "Malformed command (unmatched quote or escape)",
      };
    }
    if (parts.length === 0) {
      return { success: false, error: "Empty command" };
    }

    const requestedBinary = parts[0];
    const binary = path.basename(requestedBinary);

    // Prevent allowlist bypass via arbitrary absolute/relative paths.
    // Allow explicit wrapper scripts only from the selected cwd.
    const usesPath =
      requestedBinary.includes("/") || requestedBinary.includes("\\");
    const isAllowedWrapper =
      requestedBinary === "./gradlew" || requestedBinary === "./mvnw";
    if (usesPath && !isAllowedWrapper) {
      return {
        success: false,
        error: "Binary path must be a known wrapper or bare command",
      };
    }

    if (!ALLOWED_BINARIES.has(binary)) {
      console.warn(
        `start-process: blocked disallowed binary "${requestedBinary}"`,
      );
      return {
        success: false,
        error: `Binary "${binary}" is not in the allowlist`,
      };
    }

    let spawnBinary = requestedBinary;
    if (isAllowedWrapper) {
      const fs = require("fs");
      const wrapperPath = path.resolve(cwd, requestedBinary);
      if (!wrapperPath.startsWith(path.resolve(cwd) + path.sep)) {
        return { success: false, error: "Invalid wrapper path" };
      }
      try {
        fs.accessSync(wrapperPath, fs.constants.X_OK);
      } catch {
        return {
          success: false,
          error: `Wrapper script not executable: ${requestedBinary}`,
        };
      }
      spawnBinary = wrapperPath;
    }

    const { spawn } = require("child_process");
    const child = spawn(spawnBinary, parts.slice(1), {
      cwd,
      detached: true,
      stdio: "ignore",
    });

    // Wait for a short window to catch early spawn failures (e.g. ENOENT,
    // EACCES) before reporting success.  The 'spawn' event fires once the
    // child process has actually been created by the OS.
    const launched = await new Promise((resolve) => {
      const onError = (err) => {
        cleanup();
        resolve({ ok: false, error: err.message });
      };
      const onSpawn = () => {
        cleanup();
        resolve({ ok: true });
      };
      const timeout = setTimeout(() => {
        cleanup();
        // If neither event fired within 2 s, assume success — the process
        // is running but Node didn't emit 'spawn' (shouldn't happen, but
        // be defensive).
        resolve({ ok: true });
      }, 2000);
      function cleanup() {
        clearTimeout(timeout);
        child.removeListener("error", onError);
        child.removeListener("spawn", onSpawn);
      }
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });

    if (!launched.ok) {
      return { success: false, error: launched.error };
    }

    child.unref();
    const pid = child.pid;
    logActivityEvent({
      category: "user-action",
      severity: "info",
      title: `Started process: ${command}`,
      detail: `PID ${pid}, cwd: ${cwd}`,
      serviceName: null,
      serviceId: null,
      projectName: cwd || null,
    });
    clearProcessCache();
    clearPortCache();
    if (snapshotScheduler) {
      setImmediate(() => snapshotScheduler.reconcile());
    }
    return { success: true, pid };
  } catch (error) {
    console.error("Error starting process:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Quick Actions
// ============================================

// Open URL in default browser (with validation)
ipcMain.handle("open-url", async (event, url) => {
  try {
    // Security: Validate URL protocol (only http/https allowed)
    const validation = validateExternalUrl(url);
    if (!validation.valid) {
      console.warn(
        "[Security] Blocked open-url request:",
        url,
        "-",
        validation.reason,
      );
      return { success: false, error: validation.reason };
    }

    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error("Error opening URL:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("copy-text", async (_, text) => {
  try {
    clipboard.writeText(typeof text === "string" ? text : "");
    return { success: true };
  } catch (error) {
    console.error("Error copying text:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("window:toggle-maximize", async (event) => {
  try {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return { success: false, error: "Window not found" };

    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }

    return { success: true };
  } catch (error) {
    console.error("Error toggling maximize:", error);
    return { success: false, error: error.message };
  }
});

// Execute HTTP request (for API testing)
// Note: This app is designed to test local dev services, so localhost is allowed here.
// For apps that should block SSRF entirely, set allowPrivate to false.
ipcMain.handle("execute-http-request", async (event, options) => {
  try {
    const { method, url, headers, body } = options;

    // Security: Validate URL — respect the user's network policy setting
    const allowPrivate = getNetworkPolicy() === "local";
    const validation = validateHttpRequestUrl(url, allowPrivate);
    if (!validation.valid) {
      console.warn(
        "[Security] Blocked HTTP request:",
        url,
        "-",
        validation.reason,
      );
      return { success: false, error: validation.reason };
    }

    const parsedUrl = validation.url;
    const isHttps = parsedUrl.protocol === "https:";
    const httpModule = isHttps ? require("https") : require("http");

    return new Promise((resolve) => {
      const startTime = Date.now();
      const normalizedMethod = (method || "GET").toUpperCase();
      const requestHeaders = { ...(headers || {}) };
      const shouldSendBody =
        typeof body === "string" &&
        body.length > 0 &&
        !["GET", "HEAD"].includes(normalizedMethod);

      if (
        shouldSendBody &&
        !Object.keys(requestHeaders).some(
          (k) => k.toLowerCase() === "content-length",
        )
      ) {
        requestHeaders["Content-Length"] = Buffer.byteLength(
          body,
          "utf8",
        ).toString();
      }

      const requestOptions = {
        method: normalizedMethod,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: requestHeaders,
        timeout: 30000, // 30 second timeout
      };

      const req = httpModule.request(requestOptions, (res) => {
        const chunks = [];
        let totalSize = 0;
        let resolved = false;

        res.on("data", (chunk) => {
          totalSize += chunk.length;
          // Security: Cap response size to prevent memory abuse
          if (totalSize > MAX_RESPONSE_SIZE) {
            resolved = true;
            req.destroy();
            resolve({
              success: false,
              error: `Response too large (exceeded ${MAX_RESPONSE_SIZE / 1024 / 1024}MB limit)`,
            });
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (resolved) return;
          const duration = Date.now() - startTime;
          const responseBody = Buffer.concat(chunks).toString("utf8");

          // Try to parse as JSON for pretty display (skip for large bodies to avoid OOM)
          let parsedBody = responseBody;
          let isJson = false;
          const contentType = res.headers["content-type"] || "";
          const JSON_PRETTY_PRINT_LIMIT = 2 * 1024 * 1024; // 2MB
          if (contentType.includes("application/json")) {
            isJson = true;
            if (responseBody.length <= JSON_PRETTY_PRINT_LIMIT) {
              try {
                parsedBody = JSON.stringify(JSON.parse(responseBody), null, 2);
              } catch (e) {
                // Keep as raw string
              }
            }
          }

          analytics.capture("http_request_executed", {
            method: normalizedMethod,
            status: res.statusCode,
            duration,
            success: true,
          });

          resolve({
            success: true,
            response: {
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              body: parsedBody,
              isJson,
              duration,
              size: totalSize,
            },
          });
        });
      });

      req.on("error", (error) => {
        analytics.capture("http_request_executed", {
          method: normalizedMethod,
          success: false,
          error_type: error.code || "unknown",
        });
        resolve({
          success: false,
          error: error.message,
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({
          success: false,
          error: "Request timed out (30s)",
        });
      });

      // Send body for all methods that can carry one.
      if (shouldSendBody) {
        req.write(body);
      }

      req.end();
    });
  } catch (error) {
    console.error("Error executing HTTP request:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Traced Request
// ============================================

ipcMain.handle("execute-traced-request", async (event, options) => {
  try {
    const { method, url, headers, body, graphNodes, graphEdges } = options;

    if (!url || typeof url !== "string") {
      return { success: false, error: "URL is required" };
    }
    if (!Array.isArray(graphNodes)) {
      return { success: false, error: "graphNodes must be an array" };
    }

    // Reuse the same URL validation as execute-http-request
    const allowPrivate = getNetworkPolicy() === "local";
    const validation = validateHttpRequestUrl(url, allowPrivate);
    if (!validation.valid) {
      return { success: false, error: validation.reason };
    }

    const parsedUrl = validation.url;
    const isHttps = parsedUrl.protocol === "https:";
    const httpModule = isHttps ? require("https") : require("http");

    const makeRequest = () => {
      return new Promise((resolve, reject) => {
        const startTime = Date.now();
        const normalizedMethod = (method || "GET").toUpperCase();
        const requestHeaders = { ...(headers || {}) };
        const shouldSendBody =
          typeof body === "string" &&
          body.length > 0 &&
          !["GET", "HEAD"].includes(normalizedMethod);

        if (
          shouldSendBody &&
          !Object.keys(requestHeaders).some(
            (k) => k.toLowerCase() === "content-length",
          )
        ) {
          requestHeaders["Content-Length"] = Buffer.byteLength(
            body,
            "utf8",
          ).toString();
        }

        const requestOptions = {
          method: normalizedMethod,
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || (isHttps ? 443 : 80),
          path: parsedUrl.pathname + parsedUrl.search,
          headers: requestHeaders,
          timeout: 30000,
        };

        const req = httpModule.request(requestOptions, (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode,
              statusText: res.statusMessage,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
              duration: Date.now() - startTime,
            });
          });
        });

        req.on("error", reject);
        req.on("timeout", () => {
          req.destroy();
          reject(new Error("Request timed out"));
        });

        if (shouldSendBody) {
          req.write(body);
        }
        req.end();
      });
    };

    const trace = await executeTracedRequest(
      { method, url, headers, body, graphNodes, graphEdges: graphEdges || [] },
      makeRequest,
    );

    return { success: true, trace };
  } catch (error) {
    console.error("Error executing traced request:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Request History
// ============================================

ipcMain.handle("load-request-history", async () => {
  try {
    return loadHistory();
  } catch (error) {
    console.error("Error loading request history:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("save-request-history", async (event, entry) => {
  try {
    if (!entry || !entry.id || !entry.url || !entry.method) {
      return { success: false, error: "Invalid history entry" };
    }
    return saveHistoryEntry(entry);
  } catch (error) {
    console.error("Error saving request history:", error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle("clear-request-history", async () => {
  try {
    return clearHistory();
  } catch (error) {
    console.error("Error clearing request history:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Network Policy
// ============================================

ipcMain.handle("get-network-policy", async () => {
  try {
    return { success: true, policy: getNetworkPolicy() };
  } catch (error) {
    console.error("Error getting network policy:", error);
    return { success: true, policy: "local" };
  }
});

ipcMain.handle("set-network-policy", async (event, policy) => {
  try {
    if (policy !== "local" && policy !== "public") {
      return { success: false, error: "Policy must be 'local' or 'public'" };
    }
    return setNetworkPolicy(policy);
  } catch (error) {
    console.error("Error setting network policy:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Auto-Launch
// ============================================

ipcMain.handle("get-auto-launch", async () => {
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle("set-auto-launch", async (_event, enabled) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled });
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Alert Preferences
// ============================================

ipcMain.handle("get-alert-preferences", async () => {
  try {
    return getAlertPreferences();
  } catch (error) {
    console.error("Error getting alert preferences:", error);
    return { alertsEnabled: true };
  }
});

ipcMain.handle("set-alert-preferences", async (event, prefs) => {
  try {
    if (typeof prefs !== "object" || prefs === null) {
      return { success: false, error: "Invalid preferences" };
    }
    return setAlertPreferences(prefs);
  } catch (error) {
    console.error("Error setting alert preferences:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Alert History
// ============================================

ipcMain.handle("get-alert-history", async () => {
  try {
    return { success: true, events: getAlertHistory() };
  } catch (error) {
    console.error("Error getting alert history:", error);
    return { success: false, events: [], error: error.message };
  }
});

ipcMain.handle("clear-alert-history", async () => {
  try {
    return await clearAlertHistory();
  } catch (error) {
    console.error("Error clearing alert history:", error);
    return { success: false, error: error.message };
  }
});

// Open Terminal at specified path
ipcMain.handle("open-terminal", async (event, dirPath) => {
  try {
    // Validate the path exists and is a directory
    if (!dirPath || typeof dirPath !== "string") {
      return { success: false, error: "Invalid path" };
    }

    // Resolve to absolute path and check it exists
    const resolvedPath = path.resolve(dirPath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: "Directory does not exist" };
    }

    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return { success: false, error: "Path is not a directory" };
    }

    const platformShell = require("./services/platform");
    return await platformShell.openTerminalAtPath(resolvedPath);
  } catch (error) {
    console.error("Error opening terminal:", error);
    return { success: false, error: error.message };
  }
});

// Open file in editor (VS Code preferred, fallback to platform default)
ipcMain.handle("open-in-editor", async (event, filePath, line) => {
  try {
    if (!filePath || typeof filePath !== "string") {
      return { success: false, error: "Invalid file path" };
    }

    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
      return { success: false, error: "File does not exist" };
    }

    const platformShell = require("./services/platform");
    if (!platformShell.isPathAllowedForEditor(resolvedPath)) {
      return { success: false, error: "Path outside home directory" };
    }

    const { spawn } = require("child_process");

    // Try VS Code first (cross-platform)
    if (platformShell.hasCodeEditor()) {
      const lineNum = typeof line === "number" && line > 0 ? line : undefined;
      const gotoArg = lineNum ? `${resolvedPath}:${lineNum}` : resolvedPath;
      const child = spawn("code", ["--goto", gotoArg], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return { success: true, editor: "vscode" };
    }

    // Fallback: platform default
    return platformShell.openFileInDefaultApp(resolvedPath);
  } catch (error) {
    console.error("Error opening file in editor:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Docker Monitoring
// ============================================

// Check if Docker is available
ipcMain.handle("is-docker-available", async () => {
  try {
    return await isDockerAvailable();
  } catch (error) {
    console.error("Error checking Docker availability:", error);
    return false;
  }
});

// Get Docker containers
ipcMain.handle("get-docker-containers", async () => {
  try {
    return await getDockerContainers();
  } catch (error) {
    console.error("Error getting Docker containers:", error);
    return [];
  }
});

// Get Docker networks
ipcMain.handle("get-docker-networks", async () => {
  try {
    return await getDockerNetworks();
  } catch (error) {
    console.error("Error getting Docker networks:", error);
    return [];
  }
});

// Get full Docker snapshot (containers, networks, connections)
ipcMain.handle("get-docker-snapshot", async () => {
  try {
    return await getDockerSnapshot();
  } catch (error) {
    console.error("Error getting Docker snapshot:", error);
    return {
      containers: [],
      networks: [],
      containerConnections: [],
      isAvailable: false,
    };
  }
});

// Validate common database IPC parameters at the boundary so downstream
// functions receive safe types and errors are user-friendly.
function validateDbParams(containerId, containerImage) {
  if (!containerId || typeof containerId !== "string") {
    return "Invalid container ID";
  }
  if (!containerImage || typeof containerImage !== "string") {
    return "Invalid container image";
  }
  return null;
}

// Get database tables from a container
ipcMain.handle(
  "get-database-tables",
  async (_, containerId, containerImage) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, tables: [] };
    try {
      return await getDatabaseTables(containerId, containerImage);
    } catch (error) {
      console.error("Error getting database tables:", error);
      return { error: error.message, tables: [] };
    }
  },
);

// Get table data from a database container
ipcMain.handle(
  "get-table-data",
  async (_, containerId, containerImage, tableName, limit) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, columns: [], rows: [] };
    if (!tableName || typeof tableName !== "string") {
      return { error: "Invalid table name", columns: [], rows: [] };
    }
    try {
      return await getTableData(
        containerId,
        containerImage,
        tableName,
        limit || 100,
      );
    } catch (error) {
      console.error("Error getting table data:", error);
      return { error: error.message, columns: [], rows: [] };
    }
  },
);

// Execute a query on a database container
ipcMain.handle(
  "execute-database-query",
  async (_, containerId, containerImage, query) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, result: null };
    if (!query || typeof query !== "string") {
      return { error: "Invalid query", result: null };
    }
    try {
      const result = await executeQuery(containerId, containerImage, query);
      analytics.capture("database_query_executed", {
        db_type: (containerImage || "").includes("mongo") ? "mongodb" : "sql",
        success: !result.error,
      });
      return result;
    } catch (error) {
      console.error("Error executing database query:", error);
      return { error: error.message, result: null };
    }
  },
);

// Create a new table in a database container
ipcMain.handle(
  "create-database-table",
  async (_, containerId, containerImage, tableName, columns) => {
    const err = validateDbParams(containerId, containerImage);
    if (err) return { error: err, success: false };
    if (!tableName || typeof tableName !== "string") {
      return { error: "Invalid table name", success: false };
    }
    if (!Array.isArray(columns) || columns.length === 0) {
      return { error: "Invalid columns", success: false };
    }
    try {
      return await createTable(containerId, containerImage, tableName, columns);
    } catch (error) {
      console.error("Error creating database table:", error);
      return { error: error.message, success: false };
    }
  },
);

// Connect directly to remote MongoDB via URI
ipcMain.handle("connect-mongo-uri", async (_, uri) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid)
    return { error: check.reason, tables: [], dbType: "mongodb" };
  try {
    const result = await connectMongoUri(uri);
    analytics.capture("database_connected", {
      db_type: "mongodb",
      mode: "remote_uri",
      success: !result.error,
    });
    return result;
  } catch (error) {
    console.error("Error connecting Mongo URI:", error);
    return { error: error.message, tables: [], dbType: "mongodb" };
  }
});

// Get collection data from remote MongoDB URI
ipcMain.handle(
  "get-mongo-uri-collection-data",
  async (_, uri, collectionName, limit) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid)
      return { error: check.reason, columns: [], rows: [], dbType: "mongodb" };
    try {
      return await getMongoUriCollectionData(uri, collectionName, limit || 100);
    } catch (error) {
      console.error("Error loading Mongo URI collection data:", error);
      return { error: error.message, columns: [], rows: [], dbType: "mongodb" };
    }
  },
);

// Execute Mongo command against remote URI
ipcMain.handle("execute-mongo-uri-query", async (_, uri, command) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid) return { error: check.reason, dbType: "mongodb" };
  try {
    return await executeMongoUriQuery(uri, command);
  } catch (error) {
    console.error("Error executing Mongo URI query:", error);
    return { error: error.message, dbType: "mongodb" };
  }
});

// Connect directly to remote PostgreSQL via URI
ipcMain.handle("connect-postgres-uri", async (_, uri) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid)
    return { error: check.reason, tables: [], dbType: "postgresql" };
  try {
    const result = await connectPostgresUri(uri);
    analytics.capture("database_connected", {
      db_type: "postgresql",
      mode: "remote_uri",
      success: !result.error,
    });
    return result;
  } catch (error) {
    console.error("Error connecting PostgreSQL URI:", error);
    return { error: error.message, tables: [], dbType: "postgresql" };
  }
});

// Get table data from remote PostgreSQL URI
ipcMain.handle(
  "get-postgres-uri-table-data",
  async (_, uri, tableName, limit) => {
    const check = validateRemoteDbUri(uri);
    if (!check.valid)
      return {
        error: check.reason,
        columns: [],
        rows: [],
        dbType: "postgresql",
      };
    try {
      return await getPostgresUriTableData(uri, tableName, limit || 100);
    } catch (error) {
      console.error("Error loading PostgreSQL URI table data:", error);
      return {
        error: error.message,
        columns: [],
        rows: [],
        dbType: "postgresql",
      };
    }
  },
);

// Execute PostgreSQL query against remote URI
ipcMain.handle("execute-postgres-uri-query", async (_, uri, query) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid) return { error: check.reason, dbType: "postgresql" };
  try {
    return await executePostgresUriQuery(uri, query);
  } catch (error) {
    console.error("Error executing PostgreSQL URI query:", error);
    return { error: error.message, dbType: "postgresql" };
  }
});

// Connect to Elasticsearch via HTTP URL
ipcMain.handle("connect-elasticsearch-uri", async (_, baseUrl) => {
  const check = validateRemoteDbUri(baseUrl);
  if (!check.valid)
    return { error: check.reason, tables: [], dbType: "elasticsearch" };
  try {
    return await connectElasticsearchUri(baseUrl);
  } catch (error) {
    console.error("Error connecting to Elasticsearch:", error);
    return { error: error.message, tables: [], dbType: "elasticsearch" };
  }
});

// Fetch index data from Elasticsearch
ipcMain.handle(
  "get-elasticsearch-uri-index-data",
  async (_, baseUrl, indexName, limit) => {
    const check = validateRemoteDbUri(baseUrl);
    if (!check.valid)
      return {
        columns: [],
        rows: [],
        error: check.reason,
        dbType: "elasticsearch",
      };
    try {
      return await getElasticsearchUriIndexData(baseUrl, indexName, limit);
    } catch (error) {
      console.error("Error fetching Elasticsearch index data:", error);
      return {
        columns: [],
        rows: [],
        error: error.message,
        dbType: "elasticsearch",
      };
    }
  },
);

// Execute search query against Elasticsearch
ipcMain.handle("execute-elasticsearch-uri-query", async (_, baseUrl, query) => {
  const check = validateRemoteDbUri(baseUrl);
  if (!check.valid) return { error: check.reason, dbType: "elasticsearch" };
  try {
    return await executeElasticsearchUriQuery(baseUrl, query);
  } catch (error) {
    console.error("Error executing Elasticsearch query:", error);
    return { error: error.message, dbType: "elasticsearch" };
  }
});

// ============================================
// IPC Handlers - Container Logs Streaming
// ============================================

// Start streaming logs from a container
ipcMain.handle(
  "start-container-logs",
  async (event, containerId, options = {}) => {
    try {
      const sender = event.sender;
      const safeSend = (channel, payload) => {
        if (!sender || sender.isDestroyed()) return false;
        try {
          sender.send(channel, payload);
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!message.includes("Object has been destroyed")) {
            console.error(`Error sending ${channel} to renderer:`, err);
          }
          return false;
        }
      };

      // Bug 24 fix: callbacks use only the streamId provided by startLogStream
      // (via logData.streamId or the sid parameter), never the outer variable
      // which may still be unassigned if data arrives before the await resolves.
      const streamId = await startLogStream(
        containerId,
        options,
        (logData) => {
          if (!safeSend("container-log-data", logData)) {
            if (logData.streamId) stopLogStream(logData.streamId);
          }
        },
        (error, sid) => {
          if (
            !safeSend("container-log-error", {
              streamId: sid,
              containerId,
              error: error.message,
            })
          ) {
            if (sid) stopLogStream(sid);
          }
        },
        (code, sid) => {
          const id = sid || streamId;
          if (id) unregisterSenderLogStream(sender, id);
          safeSend("container-log-close", {
            streamId: id,
            containerId,
            exitCode: code,
          });
        },
      );

      registerSenderLogStream(sender, streamId);

      analytics.capture("container_logs_started");
      return { success: true, streamId };
    } catch (error) {
      console.error("Error starting container logs:", error);
      return { success: false, error: error.message };
    }
  },
);

// Stop a specific log stream
ipcMain.handle("stop-container-logs", async (_, streamId) => {
  try {
    const stopped = stopLogStream(streamId);
    unregisterLogStreamEverywhere(streamId);
    return { success: stopped };
  } catch (error) {
    console.error("Error stopping container logs:", error);
    return { success: false, error: error.message };
  }
});

// Stop all log streams for a container
ipcMain.handle("stop-container-streams", async (_, containerId) => {
  try {
    const beforeActive = new Set(
      getActiveStreams().map((stream) => stream.streamId),
    );
    const count = stopContainerStreams(containerId);
    const afterActive = new Set(
      getActiveStreams().map((stream) => stream.streamId),
    );
    beforeActive.forEach((id) => {
      if (!afterActive.has(id)) unregisterLogStreamEverywhere(id);
    });
    return { success: true, count };
  } catch (error) {
    console.error("Error stopping container streams:", error);
    return { success: false, error: error.message };
  }
});

// Stop all active log streams
ipcMain.handle("stop-all-container-logs", async () => {
  try {
    const allStreamIds = Array.from(logStreamsBySender.values()).flatMap(
      (entry) => Array.from(entry.streamIds),
    );
    stopAllStreams();
    allStreamIds.forEach((id) => unregisterLogStreamEverywhere(id));
    return { success: true };
  } catch (error) {
    console.error("Error stopping all container logs:", error);
    return { success: false, error: error.message };
  }
});

// One-shot container log tail — used by Sentinel health alerts
ipcMain.handle("get-container-log-tail", async (_, containerId, tail = 20) => {
  try {
    const logs = await agentDockerLogs(containerId, tail);
    return { success: true, logs };
  } catch (err) {
    return { success: false, logs: "" };
  }
});

// ============================================
// IPC Handlers - Analytics
// ============================================

ipcMain.handle("get-analytics-id", () => {
  return analytics.getDistinctId();
});

ipcMain.handle("get-activity-log", async (event, options) => {
  try {
    return getActivityLog(options || {});
  } catch (error) {
    console.error("Error getting activity log:", error);
    return [];
  }
});

ipcMain.handle("get-metric-history", async () => {
  try {
    return getMetricHistory();
  } catch (error) {
    console.error("Error getting metric history:", error);
    return {};
  }
});

// ============================================
// IPC Handlers - Share (GitHub Gist)
// ============================================

const SHARE_SETTINGS_FILE = path.join(os.homedir(), ".fere", "settings.json");

function readShareSettings() {
  try {
    if (fs.existsSync(SHARE_SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SHARE_SETTINGS_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function writeShareSettings(patch) {
  const dir = path.join(os.homedir(), ".fere");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const existing = readShareSettings();
  const merged = { ...existing, ...patch };
  const tmp = SHARE_SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), "utf-8");
  fs.renameSync(tmp, SHARE_SETTINGS_FILE);
}

ipcMain.handle("get-share-settings", () => {
  const settings = readShareSettings();
  return {
    hasToken: !!settings.githubToken,
    shareUrl: settings.shareUrl || null,
    publishedAt: settings.sharePublishedAt || null,
  };
});

ipcMain.handle("save-github-token", async (_, token) => {
  try {
    if (!token || typeof token !== "string") throw new Error("Invalid token");
    writeShareSettings({ githubToken: token.trim() });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

async function doPublish({ graphData, metadata }, isUpdate) {
  const settings = readShareSettings();
  const token = settings.githubToken;
  if (!token)
    throw new Error(
      "No GitHub token configured. Please add one in the Share settings.",
    );

  // REACT_APP_ vars aren't loaded into Electron main by CRA — read .env directly
  let logoDevToken = process.env.REACT_APP_LOGO_DEV_TOKEN || "";
  if (!logoDevToken) {
    try {
      const envPath = path.join(__dirname, "../.env");
      const envContent = require("fs").readFileSync(envPath, "utf8");
      const m = envContent.match(/^REACT_APP_LOGO_DEV_TOKEN=(.+)$/m);
      if (m) logoDevToken = m[1].trim();
    } catch {}
  }
  const html = await generateHTML({ graphData, metadata, logoDevToken });

  let result;
  if (isUpdate && settings.shareGistId) {
    result = await updateGist(settings.shareGistId, html, token);
  } else {
    result = await createGist(html, token);
  }

  const previewUrl = buildPreviewUrl(result.rawUrl);
  const publishedAt = Date.now();

  writeShareSettings({
    shareGistId: result.gistId,
    shareUrl: previewUrl,
    sharePublishedAt: publishedAt,
  });

  return { url: previewUrl, publishedAt };
}

ipcMain.handle("export-graph-file", async (_, { graphData, metadata }) => {
  try {
    let logoDevToken = process.env.REACT_APP_LOGO_DEV_TOKEN || "";
    if (!logoDevToken) {
      try {
        const envPath = path.join(__dirname, "../.env");
        const envContent = fs.readFileSync(envPath, "utf8");
        const m = envContent.match(/^REACT_APP_LOGO_DEV_TOKEN=(.+)$/m);
        if (m) logoDevToken = m[1].trim();
      } catch {}
    }
    const html = await generateHTML({ graphData, metadata, logoDevToken });
    const tabName = (metadata.tabName || "service-map").replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );
    const result = await dialog.showSaveDialog(mainWindow, {
      title: "Save Service Map",
      defaultPath: path.join(app.getPath("downloads"), `fere-${tabName}.html`),
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (result.canceled || !result.filePath) return { success: false };
    fs.writeFileSync(result.filePath, html, "utf8");
    return { success: true, filePath: result.filePath };
  } catch (err) {
    console.error("export-graph-file error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("publish-graph", async (_, options) => {
  try {
    return await doPublish(options, false);
  } catch (err) {
    console.error("publish-graph error:", err);
    return { error: err.message };
  }
});

ipcMain.handle("update-shared-graph", async (_, options) => {
  try {
    return await doPublish(options, true);
  } catch (err) {
    console.error("update-shared-graph error:", err);
    return { error: err.message };
  }
});

// ── Fere Agent ────────────────────────────────────────────────────────────────

// ── API Key Management (BYOK via safeStorage / macOS Keychain) ───────────────

// BYOK check: only returns true if the user explicitly saved a key via the UI.
// Does NOT check the env var — that may be the bundled dev key, which now lives
// on the Supabase backend in production.
function getUserApiKey() {
  const settings = readShareSettings();
  if (settings.encryptedApiKey && safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(Buffer.from(settings.encryptedApiKey, "base64"));
    } catch {}
  }
  return null;
}

ipcMain.handle("agent:set-api-key", async (_, key) => {
  try {
    if (!key || typeof key !== "string" || !key.trim()) {
      return { success: false, error: "API key cannot be empty" };
    }
    if (!safeStorage.isEncryptionAvailable()) {
      return { success: false, error: "Encryption is not available on this system" };
    }
    const encrypted = safeStorage.encryptString(key.trim());
    writeShareSettings({ encryptedApiKey: encrypted.toString("base64") });
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("agent:get-api-key-status", () => {
  const hasKey = !!getUserApiKey();
  return { hasKey };
});

ipcMain.handle("agent:clear-api-key", () => {
  try {
    const settings = readShareSettings();
    delete settings.encryptedApiKey;
    const dir = path.join(os.homedir(), ".fere");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = SHARE_SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
    fs.renameSync(tmp, SHARE_SETTINGS_FILE);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// ── GitHub OAuth (Supabase Auth with PKCE) ─────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL || runtimeConfig.supabaseUrl || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || runtimeConfig.supabaseAnonKey || "";

let pendingPkceVerifier = null;

function getAuthSession() {
  const settings = readShareSettings();
  // One-time migration from GitHub-specific fields to provider-agnostic
  if (settings.authGithubId && !settings.authProviderId) {
    settings.authProviderId = settings.authGithubId;
    settings.authDisplayName = settings.authGithubUsername;
    settings.authAvatarUrl = settings.authGithubAvatarUrl;
    settings.authProvider = "github";
    delete settings.authGithubId;
    delete settings.authGithubUsername;
    delete settings.authGithubAvatarUrl;
    const dir = path.join(os.homedir(), ".fere");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = SHARE_SETTINGS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
    fs.renameSync(tmp, SHARE_SETTINGS_FILE);
  }
  if (!settings.encryptedAuthAccessToken || !safeStorage.isEncryptionAvailable()) {
    return null;
  }
  try {
    const accessToken = safeStorage.decryptString(Buffer.from(settings.encryptedAuthAccessToken, "base64"));
    const refreshToken = settings.encryptedAuthRefreshToken
      ? safeStorage.decryptString(Buffer.from(settings.encryptedAuthRefreshToken, "base64"))
      : null;
    return {
      accessToken,
      refreshToken,
      provider: settings.authProvider || null,
      providerId: settings.authProviderId || null,
      displayName: settings.authDisplayName || null,
      avatarUrl: settings.authAvatarUrl || null,
      email: settings.authEmail || null,
      expiresAt: settings.authExpiresAt || 0,
    };
  } catch {
    return null;
  }
}

function extractDisplayName(userMeta, provider) {
  if (provider === "github") {
    return userMeta.user_name || userMeta.preferred_username || null;
  }
  if (provider === "google") {
    return userMeta.full_name || userMeta.name || null;
  }
  return userMeta.full_name || userMeta.name || userMeta.user_name || null;
}

function saveAuthSession({ accessToken, refreshToken, provider, providerId, displayName, avatarUrl, email, expiresAt }) {
  if (!safeStorage.isEncryptionAvailable()) return;
  const patch = {
    encryptedAuthAccessToken: safeStorage.encryptString(accessToken).toString("base64"),
    authProvider: provider,
    authProviderId: providerId,
    authDisplayName: displayName,
    authAvatarUrl: avatarUrl,
    authEmail: email || null,
    authExpiresAt: expiresAt,
  };
  if (refreshToken) {
    patch.encryptedAuthRefreshToken = safeStorage.encryptString(refreshToken).toString("base64");
  }
  writeShareSettings(patch);
}

function clearAuthSession() {
  const settings = readShareSettings();
  delete settings.encryptedAuthAccessToken;
  delete settings.encryptedAuthRefreshToken;
  delete settings.authProvider;
  delete settings.authProviderId;
  delete settings.authDisplayName;
  delete settings.authAvatarUrl;
  delete settings.authEmail;
  delete settings.authExpiresAt;
  // Clean up legacy fields if present
  delete settings.authGithubId;
  delete settings.authGithubUsername;
  delete settings.authGithubAvatarUrl;
  const dir = path.join(os.homedir(), ".fere");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = SHARE_SETTINGS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), "utf-8");
  fs.renameSync(tmp, SHARE_SETTINGS_FILE);
}

async function refreshAuthToken() {
  const session = getAuthSession();
  if (!session?.refreshToken) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ refresh_token: session.refreshToken }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const userMeta = data.user?.user_metadata || {};
    const provider = data.user?.app_metadata?.provider || session.provider;
    saveAuthSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token || session.refreshToken,
      provider,
      providerId: userMeta.provider_id || session.providerId,
      displayName: extractDisplayName(userMeta, provider) || session.displayName,
      avatarUrl: userMeta.avatar_url || userMeta.picture || session.avatarUrl,
      email: data.user?.email || userMeta.email || session.email,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    });
    return getAuthSession();
  } catch {
    return null;
  }
}

async function getValidAccessToken() {
  let session = getAuthSession();
  if (!session) return null;
  // Refresh if token expires within 5 minutes
  if (session.expiresAt && session.expiresAt < Math.floor(Date.now() / 1000) + 300) {
    session = await refreshAuthToken();
  }
  return session?.accessToken || null;
}

// Exchange OAuth code for session
async function exchangeCodeForSession(code) {
  if (!pendingPkceVerifier) {
    console.error("[auth] No pending PKCE verifier for code exchange");
    return null;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({
        auth_code: code,
        code_verifier: pendingPkceVerifier,
      }),
    });
    pendingPkceVerifier = null;
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error("[auth] Token exchange failed:", res.status, errText);
      return null;
    }
    const data = await res.json();
    const userMeta = data.user?.user_metadata || {};
    const provider = data.user?.app_metadata?.provider || "github";
    saveAuthSession({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      provider,
      providerId: userMeta.provider_id || data.user?.id,
      displayName: extractDisplayName(userMeta, provider),
      avatarUrl: userMeta.avatar_url || userMeta.picture || null,
      email: data.user?.email || userMeta.email || null,
      expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in || 3600),
    });
    return getAuthSession();
  } catch (err) {
    console.error("[auth] Code exchange error:", err);
    pendingPkceVerifier = null;
    return null;
  }
}

function buildAuthSessionResponse(session) {
  return {
    signedIn: !!session,
    provider: session?.provider || null,
    displayName: session?.displayName || null,
    avatarUrl: session?.avatarUrl || null,
    email: session?.email || null,
  };
}

// Handle fere:// protocol callback
function handleAuthCallback(url) {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get("code");
    if (!code) {
      console.error("[auth] Callback URL missing code param:", url);
      return;
    }
    console.log("[auth] Received callback, exchanging code...");
    exchangeCodeForSession(code).then((session) => {
      if (session) {
        console.log("[auth] Sign-in successful:", session.provider, session.displayName);
      } else {
        console.error("[auth] Code exchange returned no session");
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("auth:session-changed", buildAuthSessionResponse(session));
        // Bring the app window to front so user doesn't stay on the browser tab
        mainWindow.show();
        mainWindow.focus();
      }
    }).catch((err) => {
      console.error("[auth] Callback exchange error:", err);
    });
  } catch (err) {
    console.error("[auth] handleAuthCallback error:", err);
  }
}

const http = require("http");

let authServer = null;
const AUTH_CALLBACK_PORT = 38383;

function startPkceSignIn(provider) {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return { success: false, error: "Supabase not configured" };
  }

  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  pendingPkceVerifier = verifier;

  // Spin up a one-shot local HTTP server to catch the OAuth callback.
  // This lets us serve a self-closing page so the browser tab goes away.
  return new Promise((resolve) => {
    // Shut down any previous server
    if (authServer) { try { authServer.close(); } catch {} }

    authServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://localhost`);
      if (!reqUrl.pathname.startsWith("/auth/callback")) {
        res.writeHead(404);
        res.end();
        return;
      }
      const code = reqUrl.searchParams.get("code");

      // Serve a self-closing page
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html><html><body style="background:#1a1a1a;color:#aaa;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><p>Signed in — you can close this tab.</p></body><script>window.close()</script></html>`);

      // Exchange the code
      if (code) {
        handleAuthCallback(`fere://auth/callback?code=${encodeURIComponent(code)}`);
      }

      // Shut down the server after a short delay
      setTimeout(() => {
        try { authServer.close(); } catch {}
        authServer = null;
      }, 1000);
    });

    authServer.listen(AUTH_CALLBACK_PORT, "127.0.0.1", () => {
      const redirectUri = `http://127.0.0.1:${AUTH_CALLBACK_PORT}/auth/callback`;
      const authUrl = `${SUPABASE_URL}/auth/v1/authorize?provider=${provider}&code_challenge=${challenge}&code_challenge_method=S256&redirect_to=${encodeURIComponent(redirectUri)}`;
      shell.openExternal(authUrl);
      resolve({ success: true });
    });

    authServer.on("error", (err) => {
      console.error("[auth] Local server error:", err);
      authServer = null;
      resolve({ success: false, error: err.message });
    });
  });
}

ipcMain.handle("auth:sign-in-github", async () => {
  try {
    return startPkceSignIn("github");
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("auth:sign-in-google", async () => {
  try {
    return startPkceSignIn("google");
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("auth:get-session", () => {
  const session = getAuthSession();
  return buildAuthSessionResponse(session);
});

ipcMain.handle("auth:sign-out", () => {
  try {
    clearAuthSession();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("auth:session-changed", buildAuthSessionResponse(null));
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle("set-native-theme", (_event, theme) => {
  if (theme === "dark") nativeTheme.themeSource = "dark";
  else nativeTheme.themeSource = "light";
});

// Daily rate limit for Sentinel AI chat calls
const SENTINEL_DAILY_LIMIT = 5;

function getLocalDateString() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Get Supabase user UUID from access token JWT
function getSupabaseUserId(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split(".")[1], "base64").toString());
    return payload.sub;
  } catch { return null; }
}

async function getUsageCount(accessToken) {
  const userId = getSupabaseUserId(accessToken);
  if (!userId || !SUPABASE_URL) return 0;
  const today = getLocalDateString();
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/usage?user_id=eq.${encodeURIComponent(userId)}&date=eq.${today}&select=count`,
      { headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${accessToken}` } },
    );
    if (!res.ok) return 0;
    const rows = await res.json();
    return rows?.[0]?.count ?? 0;
  } catch { return 0; }
}

async function incrementUsageCount(accessToken) {
  const userId = getSupabaseUserId(accessToken);
  if (!userId || !SUPABASE_URL) return;
  const today = getLocalDateString();
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_usage`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_user_id: userId, p_date: today }),
    });
    if (!res.ok) {
      console.error("[auth] Usage increment failed:", res.status, await res.text().catch(() => ""));
    } else {
      const newCount = await res.json();
      console.log("[auth] Usage incremented to", newCount);
    }
  } catch (err) {
    console.error("[auth] Usage increment error:", err);
  }
}

ipcMain.handle("agent:usage", async () => {
  const ownKey = getUserApiKey();
  const accessToken = await getValidAccessToken();

  if (ownKey) {
    // BYOK user — no limit enforced on UI (they own the key)
    return { used: 0, limit: SENTINEL_DAILY_LIMIT, remaining: SENTINEL_DAILY_LIMIT, mode: "byok" };
  }

  if (accessToken && SUPABASE_URL) {
    // Signed-in free-tier user — check Supabase
    const count = await getUsageCount(accessToken);
    return { used: count, limit: SENTINEL_DAILY_LIMIT, remaining: SENTINEL_DAILY_LIMIT - count, mode: "free" };
  }

  // Not signed in, no key
  return { used: 0, limit: 0, remaining: 0, mode: "none" };
});

ipcMain.handle("agent:scan", async (_, nodeIds) => {
  try {
    const snapshot = (snapshotScheduler && snapshotScheduler.getLatestSnapshot()) || await getSystemSnapshot();
    const findings = await runScan(
      snapshot,
      Array.isArray(nodeIds) ? nodeIds : undefined,
    );
    const scopedNodes = Array.isArray(nodeIds)
      ? (snapshot.graph?.nodes ?? []).filter((node) => nodeIds.includes(node.id))
      : [];
    const projectName =
      scopedNodes.find((node) => node.project)?.project ||
      scopedNodes.find((node) => node.projectPath)?.projectPath ||
      null;
    logSentinelActivity(
      findings.length > 0
        ? `Sentinel detect found ${findings.length} issue${findings.length === 1 ? "" : "s"}`
        : "Sentinel detect found no issues",
      findings.slice(0, 5).map((finding) => finding.summary).join(", "),
      projectName,
    );
    return { success: true, findings };
  } catch (err) {
    console.error("agent:scan error:", err);
    return { success: false, error: err.message, findings: [] };
  }
});

ipcMain.handle("agent:apply-fix", async (_, action) => {
  try {
    const result = await executeAction(action);
    if (result?.success) {
      logSentinelActivity(
        "Sentinel autopilot applied a fix",
        action?.label || action?.type || "Applied safe action",
      );
    }
    return { success: true, ...result };
  } catch (err) {
    console.error("agent:apply-fix error:", err);
    return { success: false, error: err.message };
  }
});

ipcMain.handle("agent:open-in-claude-code", async (_, finding) => {
  try {
    const snapshot = snapshotScheduler?.previousSnapshot ?? null;

    // Fetch recent logs for the primary service if it's a Docker container
    let containerLogs = null;
    const containers = snapshot?.docker?.containers ?? [];
    const match = containers.find(
      (c) =>
        c.labels?.["com.docker.compose.service"] === finding.service ||
        c.name === finding.service ||
        c.name?.endsWith(`-${finding.service}-1`),
    );
    if (match) {
      try {
        containerLogs = await agentDockerLogs(match.id, 80);
      } catch {
        /* skip */
      }
    }

    return openInClaudeCode(finding, snapshot, containerLogs);
  } catch (err) {
    console.error("agent:open-in-claude-code error:", err);
    return {
      success: false,
      briefPath: "",
      projectPath: "",
      error: err.message,
    };
  }
});

// ── Agent tools (filesystem + runtime) ───────────────────────────────────────

function agentAllowedPath(normalized, allowedPaths) {
  // Allow the path itself, children of it, or its parent (one level up)
  return allowedPaths.some((ap) => {
    const parent = path.dirname(ap);
    return (
      normalized.startsWith(ap + path.sep) ||
      normalized === ap ||
      normalized.startsWith(parent + path.sep) ||
      normalized === parent
    );
  });
}

const AGENT_TRUSTED_DEV_ROOTS = [
  path.join(os.homedir(), "Documents", "GitHub"),
  path.join(os.homedir(), "GitHub"),
  path.join(os.homedir(), "Documents", "Projects"),
  path.join(os.homedir(), "Projects"),
].map((p) => path.normalize(p));

function pathWithinRoot(normalized, root) {
  return normalized === root || normalized.startsWith(root + path.sep);
}

function agentAllowedCommandCwd(normalizedCwd, projectPaths) {
  if (agentAllowedPath(normalizedCwd, projectPaths)) return true;
  return AGENT_TRUSTED_DEV_ROOTS.some((root) =>
    pathWithinRoot(normalizedCwd, root),
  );
}

function agentReadFile(filePath, allowedPaths) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    return "Error: path must be absolute.";
  }
  const normalized = path.normalize(filePath);
  if (normalized.split(path.sep).includes(".."))
    return "Error: path traversal not allowed.";
  if (!agentAllowedPath(normalized, allowedPaths)) {
    return `Error: ${normalized} is outside known project paths (${allowedPaths.join(", ")}).`;
  }
  const base = path.basename(normalized);
  if (base === ".env" || /\.(key|pem|cert|p12|pfx)$/i.test(base)) {
    return "Error: cannot read credential files.";
  }
  const ALLOWED_EXT = new Set([
    ".py",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".go",
    ".rb",
    ".rs",
    ".java",
    ".cpp",
    ".c",
    ".h",
    ".cs",
    ".php",
    ".swift",
    ".kt",
    ".scala",
    ".yml",
    ".yaml",
    ".toml",
    ".json",
    ".xml",
    ".html",
    ".css",
    ".scss",
    ".sh",
    ".bash",
    ".zsh",
    ".dockerfile",
    ".txt",
    ".md",
    ".conf",
    ".config",
    ".ini",
    ".cfg",
    ".env.example",
    ".gitignore",
    ".lock",
  ]);
  const ext = path.extname(normalized).toLowerCase();
  if (ext && !ALLOWED_EXT.has(ext))
    return `Error: file type ${ext} is not readable.`;
  try {
    if (!fs.existsSync(normalized))
      return `Error: file not found: ${normalized}`;
    const stat = fs.statSync(normalized);
    if (!stat.isFile()) return `Error: ${normalized} is not a file.`;
    if (stat.size > 80 * 1024) {
      return `File is ${Math.round(stat.size / 1024)}KB — too large. Ask about a specific section.`;
    }
    return fs.readFileSync(normalized, "utf8");
  } catch (e) {
    return `Error reading file: ${e.message}`;
  }
}

function agentListDirectory(dirPath, allowedPaths) {
  if (typeof dirPath !== "string" || !path.isAbsolute(dirPath)) {
    return "Error: path must be absolute.";
  }
  const normalized = path.normalize(dirPath);
  if (normalized.split(path.sep).includes(".."))
    return "Error: path traversal not allowed.";
  if (!agentAllowedPath(normalized, allowedPaths)) {
    return `Error: ${normalized} is outside known project paths.`;
  }
  try {
    if (!fs.existsSync(normalized))
      return `Error: directory not found: ${normalized}`;
    const stat = fs.statSync(normalized);
    if (!stat.isDirectory()) return `Error: ${normalized} is not a directory.`;
    const entries = fs.readdirSync(normalized, { withFileTypes: true });
    const lines = entries
      .filter(
        (e) =>
          e.name !== "node_modules" &&
          e.name !== "__pycache__" &&
          e.name !== ".git",
      )
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return `${normalized}:\n${lines.join("\n")}`;
  } catch (e) {
    return `Error listing directory: ${e.message}`;
  }
}

// Launch a command in a new macOS Terminal window (for long-running servers)
async function agentLaunchInTerminal(command, cwd, projectPaths) {
  if (typeof command !== "string" || !command.trim())
    return "Error: command is empty.";
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    return "Error: cwd must be an absolute path.";
  const normalizedCwd = path.normalize(cwd);
  if (!agentAllowedCommandCwd(normalizedCwd, projectPaths)) {
    return `Error: cwd ${normalizedCwd} is outside allowed project paths.`;
  }
  // Escape for AppleScript string literal
  const escapedCwd = normalizedCwd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const escapedCmd = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `tell application "Terminal"
  activate
  do script "cd \\"${escapedCwd}\\" && ${escapedCmd}"
end tell`;
  const { output, ok } = await execAsync(
    `osascript -e '${script.replace(/'/g, "'\\''")}'`,
    { timeout: 10000 },
  );
  if (!ok) return `Error opening Terminal: ${output}`;
  return `Launch requested in Terminal: ${command}. Status is NOT verified. Run an explicit check (for example: health endpoint, logs, or lsof on expected port) before claiming it is running.`;
}

// Blocked command patterns for run_command safety
const BLOCKED_CMDS = [
  /\brm\b/,
  /\brmdir\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /\bchmod\b/,
  /\bchown\b/,
  /\bkill\b/,
  /\bpkill\b/,
  /\bmkfs\b/,
  /\bdd\b/,
  /\bfdisk\b/,
  /\bformat\b/,
  /\bmv\b.*\//,
  /\bcp\b.*\//,
  /\bwget\b/,
  /\bnc\b/,
  /\bncat\b/,
  />\s*\//,
  /\|\s*sh/,
  /\|\s*bash/,
  /\|\s*zsh/,
  /`/,
  /\$\(/,
];

// Long-running server commands that should never be started by the agent
const BLOCKED_SERVER_CMDS = [
  /\bnpm\s+(run\s+)?(start|dev|serve|watch)\b/,
  /\bpnpm\s+(run\s+)?(start|dev|serve|watch)\b/,
  /\byarn\s+(run\s+)?(start|dev|serve|watch)\b/,
  /\bnpx\s+(next|vite|webpack-dev-server|nodemon|ts-node-dev|live-server)\b/,
  /\bnode\s+(server|index|app|main)\.(js|ts)\b/,
  /\bnext\s+dev\b/,
  /\bvite\b/,
  /\bnodemon\b/,
  /\buvicorn\b/,
  /\bgunicorn\b/,
  /\bflask\s+run\b/,
  /\bdjango.*runserver\b/,
  /\bfastapi\b/,
  /\bpython\s+-m\s+(flask|uvicorn|http\.server)\b/,
];

const INSTALL_UPDATE_CMDS = [
  /\bpip3?\s+install\b/i,
  /\buv\s+pip\s+install\b/i,
  /\bnpm\s+(install|i|update|upgrade)\b/i,
  /\bpnpm\s+(install|add|update|up|upgrade)\b/i,
  /\byarn\s+(install|add|upgrade|up)\b/i,
  /\bbun\s+(install|add|update|upgrade)\b/i,
  /\bpoetry\s+(add|install|update)\b/i,
  /\bconda\s+install\b/i,
  /\bbrew\s+(install|upgrade|update)\b/i,
  /\bapt(-get)?\s+(install|upgrade|update)\b/i,
];

function isInstallOrUpdateCommand(command) {
  return INSTALL_UPDATE_CMDS.some((pattern) => pattern.test(command));
}

function normalizeMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string")
          return part.text;
        return "";
      })
      .join(" ");
  }
  return "";
}

function extractAgentPolicies(messages) {
  const policies = {
    disallowInstalls: false,
    forceNoBackAndForth: false,
  };
  if (!Array.isArray(messages)) return policies;
  for (const msg of messages) {
    if (msg?.role !== "user") continue;
    const text = normalizeMessageText(msg.content).toLowerCase();
    if (!text) continue;
    if (
      /\b(do not|don't|dont|no)\s+install\b/.test(text) ||
      /\bwithout\s+install(ing)?\b/.test(text) ||
      /\bno\s+dependency\s+installs?\b/.test(text)
    ) {
      policies.disallowInstalls = true;
    }
    if (
      /\bend[-\s]?to[-\s]?end\b/.test(text) ||
      /\bno\s+back[-\s]?and[-\s]?forth\b/.test(text) ||
      /\bauto[-\s]?fix\b/.test(text) ||
      /\bretry\b/.test(text) ||
      /\bdon'?t\s+ask\s+me\b/.test(text) ||
      /\bdo\s+not\s+ask\s+me\b/.test(text)
    ) {
      policies.forceNoBackAndForth = true;
    }
  }
  return policies;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveNodeByName(name, scopedNodes, allNodes) {
  if (typeof name !== "string" || !name.trim()) return null;
  const normalized = name.trim().toLowerCase();
  const exactInScope = scopedNodes.find(
    (node) => String(node?.name || "").toLowerCase() === normalized,
  );
  if (exactInScope) return exactInScope;
  return (
    allNodes.find(
      (node) => String(node?.name || "").toLowerCase() === normalized,
    ) ?? null
  );
}

function findMentionedScopedNode(text, scopedNodes) {
  if (typeof text !== "string" || !text.trim() || !Array.isArray(scopedNodes)) {
    return null;
  }
  const lower = text.toLowerCase();
  const candidates = scopedNodes
    .filter(
      (node) =>
        node?.type !== "external" &&
        typeof node?.name === "string" &&
        node.name.trim(),
    )
    .sort((a, b) => b.name.length - a.name.length);

  for (const node of candidates) {
    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(node.name.toLowerCase())}([^a-z0-9]|$)`,
      "i",
    );
    if (pattern.test(lower)) return node;
  }
  return null;
}

function shouldPrefetchNodeDetails(text) {
  if (typeof text !== "string" || !text.trim()) return false;
  const lower = text.toLowerCase();
  return [
    /\bconnection(s)?\b/,
    /\bconnected\b/,
    /\btalking to\b/,
    /\bcalls?\b/,
    /\btraffic\b/,
    /\b(?:dependency|dependencies)\b/,
    /\bdepends on\b/,
    /\bupstream\b/,
    /\bdownstream\b/,
    /\bhealth\b/,
    /\bstatus\b/,
    /\broutes?\b/,
    /\bports?\b/,
    /\bcpu\b/,
    /\bmemory\b/,
    /\bresource(s)?\b/,
    /\brunning\b/,
  ].some((pattern) => pattern.test(lower));
}

function classifyDirectNodeQuestion(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const lower = text.toLowerCase();
  if (/\bincoming connections?\b|\binbound connections?\b/.test(lower)) {
    return "incoming-connections";
  }
  if (/\boutgoing connections?\b|\boutbound connections?\b/.test(lower)) {
    return "outgoing-connections";
  }
  if (
    /\bwhat are the connections\b/.test(lower) ||
    /\bshow .*connections\b/.test(lower) ||
    /\bwhich services?.*(connected|talking to)\b/.test(lower)
  ) {
    return "all-connections";
  }
  if (
    /\bwhat are the details\b/.test(lower) ||
    /\bdetails of\b/.test(lower) ||
    /\btell me about\b/.test(lower)
  ) {
    return "details";
  }
  return null;
}

function formatConnectionLines(targetNode, edges, allNodes, direction) {
  const relevant =
    direction === "incoming"
      ? edges.filter((edge) => edge.target === targetNode.id)
      : edges.filter((edge) => edge.source === targetNode.id);

  return relevant.map((edge) => {
    const peerId = direction === "incoming" ? edge.source : edge.target;
    const peerName =
      allNodes.find((node) => node.id === peerId)?.name ?? peerId;
    const sourcePort = Number(edge.sourcePort) || 0;
    const targetPort = Number(edge.targetPort) || 0;
    if (sourcePort === 0 && targetPort === 0) {
      return `- **${peerName}** (edge detected, port details unavailable)`;
    }
    return `- **${peerName}** \`:${sourcePort} → :${targetPort}\``;
  });
}

function buildDirectNodeAnswer(questionType, targetNode, allNodes, edges) {
  if (!questionType || !targetNode) return null;

  if (questionType === "incoming-connections") {
    const incoming = formatConnectionLines(
      targetNode,
      edges,
      allNodes,
      "incoming",
    );
    if (incoming.length === 0) {
      return `**${targetNode.name}** has no incoming connections in the current graph snapshot.`;
    }
    return [
      `Incoming connections for **${targetNode.name}**:`,
      ...incoming,
    ].join("\n");
  }

  if (questionType === "outgoing-connections") {
    const outgoing = formatConnectionLines(
      targetNode,
      edges,
      allNodes,
      "outgoing",
    );
    if (outgoing.length === 0) {
      return `**${targetNode.name}** has no outgoing connections in the current graph snapshot.`;
    }
    return [
      `Outgoing connections for **${targetNode.name}**:`,
      ...outgoing,
    ].join("\n");
  }

  if (questionType === "all-connections") {
    const incoming = formatConnectionLines(
      targetNode,
      edges,
      allNodes,
      "incoming",
    );
    const outgoing = formatConnectionLines(
      targetNode,
      edges,
      allNodes,
      "outgoing",
    );
    const lines = [`Connections for **${targetNode.name}**:`];
    lines.push(
      incoming.length > 0
        ? `Incoming:\n${incoming.join("\n")}`
        : "Incoming:\n- None",
    );
    lines.push(
      outgoing.length > 0
        ? `Outgoing:\n${outgoing.join("\n")}`
        : "Outgoing:\n- None",
    );
    return lines.join("\n");
  }

  return null;
}

function buildPolicyPrompt(policies, options = {}) {
  const dynamicRules = [];
  if (policies.disallowInstalls) {
    dynamicRules.push(
      "- The user explicitly said not to install or update dependencies. Do not suggest, run, or propose any install/update command (pip/npm/pnpm/yarn/brew/apt/conda/poetry).",
    );
  }
  if (options.autopilotEnabled) {
    dynamicRules.push(
      "- Autopilot is ON. For safe operational actions (restart-container, kill-port), do not ask for confirmation. Execute immediately, then verify and report outcome.",
    );
  }
  if (policies.forceNoBackAndForth) {
    dynamicRules.push(
      "- The user requested end-to-end execution with no back-and-forth. Do not ask 'Would you like me to...'. Make non-destructive project-file fixes directly, retry automatically, and report evidence.",
    );
  }
  return [
    "Additional hard rules:",
    "- Execution-first mode: when the user asks you to run, start, fix, dockerize, or verify something, act with tools first and only then report results.",
    "- Do not ask the user to run commands manually when an available tool can do it. Try at least one concrete execution path before asking any follow-up question.",
    "- If a command fails, diagnose from real output, apply a fix, and retry automatically. Only ask a question after retries are exhausted or a destructive decision is required.",
    "- For run/start requests, verify with explicit evidence (for example: docker ps, docker compose ps/logs, health endpoint, lsof) before claiming success.",
    "- Never mention a filename/path unless you first verified it with tool output (list_directory/read_file). If uncertain, list the directory first.",
    '- When asked about how a library, service, or external API is used: you MUST grep the codebase for it before answering. Always use case-insensitive grep (e.g. run_command: grep -irl "groq" --include="*.py" .). Library names in Python source are lowercase even when the user writes them capitalized (Groq→groq, Gemini→genai or google.generativeai, OpenAI→openai). Reading one file and not finding it is NOT sufficient — grep case-insensitively, then read the files that match.',
    "- NEVER respond with 'it might be elsewhere' or 'let me know if you have specific files' when asked about source code. That answer is always wrong. Grep first, then read, then answer.",
    "- For any dockerize/containerization request, call `discover_docker_plan` first and follow its constraints before writing Dockerfile/compose files.",
    "- When the user asks to run/start a project or service, call `discover_runbook` first for that project root and use only commands verified from files.",
    "- When the user asks to create project config files (for example Dockerfile/docker-compose.yml), use `write_file` to create them directly inside allowed project roots.",
    "- `launch_in_terminal` only confirms a command was sent to Terminal. Never claim a service started successfully unless you run an explicit verification command and quote the verification output.",
    "- NEVER use run_command for stress tests, CPU/memory benchmarks, or any looping process. These must use launch_in_terminal so they appear as independent processes visible to system monitoring. For a CPU stress test use: `python3 -c 'import time; end=time.time()+10\nwhile time.time()<end: pass'` via launch_in_terminal — never via run_command.",
    ...dynamicRules,
  ].join("\n");
}

function looksLikeFollowUpQuestion(text) {
  if (typeof text !== "string") return false;
  const lower = text.toLowerCase();
  if (!lower.includes("?")) return false;
  return (
    /\bwould you like me to\b/.test(lower) ||
    /\bshall i\b/.test(lower) ||
    /\bdo you want me to\b/.test(lower) ||
    /\bshould i\b/.test(lower)
  );
}

function isDockerComposeUpCommand(command) {
  if (typeof command !== "string") return false;
  return /\bdocker(?:-compose|\s+compose)\s+up\b/i.test(command);
}

// Promisified exec — non-blocking, runs off the main thread event loop
const { exec: _execAsync } = require("child_process");
function execAsync(command, options = {}) {
  return new Promise((resolve) => {
    _execAsync(
      command,
      { encoding: "utf8", ...options },
      (err, stdout, stderr) => {
        if (err) {
          const msg = ((stdout || "") + (stderr || "") || err.message).trim();
          resolve({ ok: false, output: `Exit ${err.code ?? 1}:\n${msg}` });
        } else {
          resolve({ ok: true, output: (stdout || "").trim() || "(no output)" });
        }
      },
    );
  });
}

async function agentRunCommand(command, cwd, projectPaths, policies = {}) {
  if (typeof command !== "string" || !command.trim())
    return "Error: command is empty.";
  if (typeof cwd !== "string" || !path.isAbsolute(cwd))
    return "Error: cwd must be an absolute path.";
  const normalizedCwd = path.normalize(cwd);
  if (!agentAllowedCommandCwd(normalizedCwd, projectPaths)) {
    return `Error: cwd ${normalizedCwd} is outside allowed local dev roots.`;
  }
  for (const pattern of BLOCKED_SERVER_CMDS) {
    if (pattern.test(command))
      return `Error: "${command}" starts a long-running server. Use docker_control or run the command manually in a terminal instead.`;
  }
  if (policies.disallowInstalls && isInstallOrUpdateCommand(command)) {
    return 'Error: install/update commands are disabled for this chat because the user explicitly requested "do not install".';
  }
  for (const pattern of BLOCKED_CMDS) {
    if (pattern.test(command))
      return `Error: command contains a blocked operation.`;
  }
  const { output } = await execAsync(command, {
    cwd: normalizedCwd,
    timeout: 15000,
    maxBuffer: 1024 * 100,
    env: { ...process.env, TERM: "dumb" },
  });
  return output;
}

async function agentDockerLogs(containerId, tail = 80) {
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(containerId))
    return "Error: invalid container id.";
  const { output } = await execAsync(
    `docker logs --tail ${Number(tail)} ${containerId} 2>&1`,
    { timeout: 10000, maxBuffer: 1024 * 100 },
  );
  return output || "(no logs)";
}

async function agentDockerExec(containerId, command) {
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(containerId))
    return "Error: invalid container id.";
  if (typeof command !== "string" || !command.trim())
    return "Error: command is empty.";
  for (const pattern of BLOCKED_CMDS) {
    if (pattern.test(command))
      return `Error: command contains a blocked operation.`;
  }
  const { output } = await execAsync(
    `docker exec ${containerId} sh -c ${JSON.stringify(command)} 2>&1`,
    { timeout: 15000, maxBuffer: 1024 * 100 },
  );
  return output;
}

async function agentDockerControl(containerId, action) {
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(containerId))
    return "Error: invalid container id.";
  if (!["start", "stop", "restart"].includes(action))
    return "Error: action must be start, stop, or restart.";
  const { ok, output } = await execAsync(
    `docker ${action} ${containerId} 2>&1`,
    { timeout: 20000 },
  );
  return ok ? `Container ${containerId} ${action}ed successfully.` : output;
}

async function agentWriteFile(filePath, content, projectPaths) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    return "Error: path must be an absolute path.";
  }
  if (typeof content !== "string") {
    return "Error: content must be a string.";
  }
  const normalized = path.normalize(filePath);
  if (!agentAllowedCommandCwd(path.dirname(normalized), projectPaths)) {
    return `Error: ${normalized} is outside allowed local dev roots.`;
  }
  if (normalized.split(path.sep).includes("..")) {
    return "Error: path traversal not allowed.";
  }
  if (
    /\.(pem|key|p12|pfx)$/i.test(normalized) ||
    path.basename(normalized) === ".env"
  ) {
    return "Error: writing credential files is not allowed.";
  }
  try {
    fs.mkdirSync(path.dirname(normalized), { recursive: true });
    fs.writeFileSync(normalized, content, "utf8");
    return `Wrote file: ${normalized}`;
  } catch (e) {
    return `Error writing file: ${e.message}`;
  }
}

function safeReadText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function parsePackageScripts(packagePath) {
  const raw = safeReadText(packagePath);
  if (!raw) return null;
  try {
    const pkg = JSON.parse(raw);
    return pkg?.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  } catch {
    return null;
  }
}

function extractUvicornCommand(text) {
  if (!text) return null;
  const m = text.match(/\buvicorn\s+[^\n\r`]+/i);
  return m ? m[0].trim() : null;
}

async function agentDiscoverRunbook(projectRoot, projectPaths) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    return "Error: project_root must be an absolute path.";
  }
  const root = path.normalize(projectRoot);
  if (!agentAllowedCommandCwd(root, projectPaths)) {
    return `Error: ${root} is outside allowed local dev roots.`;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return `Error: directory not found: ${root}`;
  }

  const candidates = [
    root,
    path.join(root, "frontend"),
    path.join(root, "backend"),
    path.join(root, "web"),
    path.join(root, "server"),
  ].filter(
    (p, i, arr) =>
      arr.indexOf(p) === i && fs.existsSync(p) && fs.statSync(p).isDirectory(),
  );

  const lines = [`Runbook discovery for ${root}`, ""];
  let foundAny = false;

  for (const dir of candidates) {
    const rel = path.relative(root, dir) || ".";
    lines.push(`## ${rel}`);

    const pkgPath = path.join(dir, "package.json");
    const scripts = parsePackageScripts(pkgPath);
    if (scripts) {
      foundAny = true;
      const runScript =
        (typeof scripts.dev === "string" && "dev") ||
        (typeof scripts.start === "string" && "start");
      lines.push(`- Verified: package.json exists (${pkgPath})`);
      if (runScript) {
        lines.push(
          `- Frontend/Node run command: \`npm run ${runScript}\` (cwd: ${dir})`,
        );
      } else {
        lines.push(
          "- Frontend/Node run command: not found in scripts.dev/scripts.start",
        );
      }
    } else {
      lines.push("- package.json: not found");
    }

    const readmePath = ["README.md", "readme.md"]
      .map((f) => path.join(dir, f))
      .find(fs.existsSync);
    const readmeText = readmePath ? safeReadText(readmePath) : null;

    const mainPy = path.join(dir, "main.py");
    if (fs.existsSync(mainPy)) {
      foundAny = true;
      const uvFromReadme = extractUvicornCommand(readmeText);
      lines.push(`- Verified: Python entrypoint exists (${mainPy})`);
      lines.push(
        `- Backend run command: \`${uvFromReadme || "uvicorn main:app --reload --port 8000"}\` (cwd: ${dir})`,
      );
    } else {
      lines.push("- main.py: not found");
    }

    const reqPath = path.join(dir, "requirements.txt");
    if (fs.existsSync(reqPath)) lines.push(`- requirements file: ${reqPath}`);
    if (readmePath) lines.push(`- docs checked: ${readmePath}`);
    lines.push("");
  }

  if (!foundAny) {
    lines.push(
      "No runnable frontend/backend commands found from package.json/main.py.",
    );
    lines.push(
      "Next step: inspect subdirectories with list_directory then read relevant README files.",
    );
  }

  return lines.join("\n");
}

async function agentDiscoverDockerPlan(projectRoot, projectPaths) {
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    return "Error: project_root must be an absolute path.";
  }
  const root = path.normalize(projectRoot);
  if (!agentAllowedCommandCwd(root, projectPaths)) {
    return `Error: ${root} is outside allowed local dev roots.`;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return `Error: directory not found: ${root}`;
  }

  const files = {
    compose: [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
    ]
      .map((f) => path.join(root, f))
      .find(fs.existsSync),
    rootDockerfile: path.join(root, "Dockerfile"),
    backendDockerfile: path.join(root, "Dockerfile.backend"),
    frontendDockerfile: path.join(root, "Dockerfile.frontend"),
    backendMain: path.join(root, "backend", "main.py"),
    backendReqs: path.join(root, "backend", "requirements.txt"),
    frontendPkg: path.join(root, "frontend", "package.json"),
    frontendLock: path.join(root, "frontend", "package-lock.json"),
    agentsDir: path.join(root, "agents"),
  };

  const has = {
    compose: !!files.compose,
    rootDockerfile: fs.existsSync(files.rootDockerfile),
    backendDockerfile: fs.existsSync(files.backendDockerfile),
    frontendDockerfile: fs.existsSync(files.frontendDockerfile),
    backendMain: fs.existsSync(files.backendMain),
    backendReqs: fs.existsSync(files.backendReqs),
    frontendPkg: fs.existsSync(files.frontendPkg),
    frontendLock: fs.existsSync(files.frontendLock),
    agentsDir:
      fs.existsSync(files.agentsDir) &&
      fs.statSync(files.agentsDir).isDirectory(),
  };

  const lines = [];
  lines.push(`Docker preflight for ${root}`);
  lines.push("");
  lines.push("Detected files:");
  lines.push(`- compose file: ${has.compose ? files.compose : "none"}`);
  lines.push(`- root Dockerfile: ${has.rootDockerfile ? "present" : "absent"}`);
  lines.push(
    `- Dockerfile.backend: ${has.backendDockerfile ? "present" : "absent"}`,
  );
  lines.push(
    `- Dockerfile.frontend: ${has.frontendDockerfile ? "present" : "absent"}`,
  );
  lines.push(`- backend/main.py: ${has.backendMain ? "present" : "absent"}`);
  lines.push(
    `- backend/requirements.txt: ${has.backendReqs ? "present" : "absent"}`,
  );
  lines.push(
    `- frontend/package.json: ${has.frontendPkg ? "present" : "absent"}`,
  );
  lines.push(`- agents/: ${has.agentsDir ? "present" : "absent"}`);
  lines.push("");
  lines.push("Required dockerization constraints:");
  lines.push(
    "- Never invent server.js or package.json in project root unless they already exist.",
  );
  lines.push(
    "- For split repos (backend + frontend), do not use one generic root Dockerfile for both.",
  );
  lines.push(
    "- Backend image must include backend/main.py entrypoint target and include agents/ when imports use agents.*",
  );
  lines.push("- If google-genai==1.29.0 is present, httpx must be >=0.28.1.");
  lines.push(
    "- Prefer docker compose up --build -d, then verify with compose ps + compose logs + health checks.",
  );

  if (has.backendReqs) {
    try {
      const reqText = fs.readFileSync(files.backendReqs, "utf8");
      const hasGenai = /google-genai==1\.29\.0/.test(reqText);
      const hasBadHttpx = /^httpx<0\.28$/m.test(reqText);
      if (hasGenai && hasBadHttpx) {
        lines.push("");
        lines.push("Known blocker detected:");
        lines.push(
          "- backend/requirements.txt has google-genai==1.29.0 with httpx<0.28 (conflict).",
        );
      }
    } catch {}
  }

  return lines.join("\n");
}

const AGENT_TOOLS = [
  {
    type: "function",
    function: {
      name: "discover_docker_plan",
      description:
        "Preflight dockerization inspection for a project root. Detects existing docker/app files, highlights required constraints, and flags known blockers. Use this before writing Dockerfile/docker-compose.",
      parameters: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            description:
              "Absolute path to the project root directory (for example /Users/me/Documents/GitHub/impasse)",
          },
        },
        required: ["project_root"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a text file in an allowed project directory. Use for scaffolding config files like Dockerfile, docker-compose.yml, and small project setup files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path to write" },
          content: { type: "string", description: "UTF-8 text file contents" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discover_runbook",
      description:
        "Deterministically inspect a project folder to discover verified run commands from package.json scripts, README instructions, and main.py presence. Use this before launching frontend/backend services.",
      parameters: {
        type: "object",
        properties: {
          project_root: {
            type: "string",
            description:
              "Absolute path to the project root directory (for example /Users/me/Documents/GitHub/impasse)",
          },
        },
        required: ["project_root"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the full contents of a source file. Use when the user asks about a specific file, code logic, or implementation. If unsure of the exact path, use list_directory first.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute file path to read" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description:
        "List the files and subdirectories inside a directory. Use this to explore and find the right file before reading it.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute directory path to list",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a short-lived shell command and return its output. Use for: running tests, checking logs, grepping source files, inspecting processes (ps/lsof), one-shot diagnostics. NEVER use this for: stress tests, benchmarks, anything that loops forever, or any process that should be visible to monitoring — those must go through launch_in_terminal so they appear as independent processes. cwd must be an absolute path in a known project or trusted local dev root.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "Shell command to execute (e.g. 'npm test', 'python manage.py check', 'cat error.log'). Must terminate on its own within 15 seconds.",
          },
          cwd: {
            type: "string",
            description:
              "Absolute project path to run the command in (for example under ~/Documents/GitHub)",
          },
        },
        required: ["command", "cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_logs",
      description:
        "Fetch recent log output from a Docker container. Use when the user asks about container errors, crashes, or runtime output.",
      parameters: {
        type: "object",
        properties: {
          container_id: {
            type: "string",
            description: "Docker container ID or name",
          },
          tail: {
            type: "number",
            description: "Number of log lines to return (default 80)",
          },
        },
        required: ["container_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_exec",
      description:
        "Run a shell command inside a running Docker container and return the output. Useful for inspecting container state, checking files, or running diagnostics.",
      parameters: {
        type: "object",
        properties: {
          container_id: {
            type: "string",
            description: "Docker container ID or name",
          },
          command: {
            type: "string",
            description: "Shell command to run inside the container",
          },
        },
        required: ["container_id", "command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_node_details",
      description:
        "Get full details for a specific service node: ports, routes, external APIs, CPU/memory, Docker image, networks, mounts, health check output, and all inbound/outbound connections. Use when the user asks about a specific service.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Service name (as shown in the topology, case-insensitive)",
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "launch_in_terminal",
      description:
        "Open macOS Terminal and run a long-running command (e.g. dev servers, uvicorn, npm run dev, flask run). Use this instead of run_command for anything that stays running. The command runs in a new Terminal window so the user can see its output.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description:
              "The command to run (e.g. 'uvicorn main:app --host 0.0.0.0 --port 8000')",
          },
          cwd: {
            type: "string",
            description: "Absolute path of the directory to run the command in",
          },
        },
        required: ["command", "cwd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "docker_control",
      description: "Start, stop, or restart a Docker container.",
      parameters: {
        type: "object",
        properties: {
          container_id: {
            type: "string",
            description: "Docker container ID or name",
          },
          action: {
            type: "string",
            enum: ["start", "stop", "restart"],
            description: "Action to perform",
          },
        },
        required: ["container_id", "action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_fix",
      description:
        "Propose a concrete fix to the user as a clickable button in the chat UI. Use this after diagnosing an issue when you know exactly how to fix it. The user clicks the button to apply it — you don't need to call docker_control or run_command yourself.",
      parameters: {
        type: "object",
        properties: {
          label: {
            type: "string",
            description: "Short button label, e.g. 'Restart Redis'",
          },
          description: {
            type: "string",
            description: "One-line description of what this fix does",
          },
          fix_type: {
            type: "string",
            enum: ["restart-container", "kill-port", "launch-in-terminal"],
            description: "Category of fix",
          },
          container_id: {
            type: "string",
            description: "Container ID or name (restart-container)",
          },
          port: { type: "number", description: "Port number (kill-port)" },
          pid: { type: "number", description: "PID to kill (kill-port)" },
          command: {
            type: "string",
            description: "Shell command (launch-in-terminal)",
          },
          cwd: {
            type: "string",
            description: "Working directory (launch-in-terminal)",
          },
        },
        required: ["label", "description", "fix_type"],
      },
    },
  },
];

function sendStep(event, step) {
  if (!event.sender.isDestroyed()) event.sender.send("agent:chat-step", step);
}

ipcMain.handle("agent:chat", async (event, payload) => {
  try {
    const { messages, nodeIds, tabLabel, options = {}, graphEdges } = payload || {};
    const safeMessages = Array.isArray(messages) ? messages : [];
    const apiKey = getUserApiKey();
    const accessToken = !apiKey ? await getValidAccessToken() : null;

    // Enforce daily rate limit for free-tier proxy users
    if (!apiKey && accessToken && SUPABASE_URL) {
      const usedCount = await getUsageCount(accessToken);
      if (usedCount >= SENTINEL_DAILY_LIMIT) {
        return {
          success: false,
          error: `Daily AI limit reached (${SENTINEL_DAILY_LIMIT}/${SENTINEL_DAILY_LIMIT}). Resets at midnight. Enter your own API key for unlimited calls. Deterministic scans are still available.`,
          rateLimited: true,
          remaining: 0,
        };
      }
    }

    if (!apiKey && (!accessToken || !SUPABASE_URL)) {
      return {
        success: false,
        error: "Sign in with Google for 5 free AI calls per day, or add your own API key for unlimited access.",
      };
    }

    // Prefer the scheduler's cached snapshot so the agent sees the same graph the UI shows.
    // Fall back to a fresh build only if the scheduler hasn't produced one yet.
    const snapshot = (snapshotScheduler && snapshotScheduler.getLatestSnapshot()) || await getSystemSnapshot();

    // Enrich nodes with external APIs (not in snapshot by default — on-demand only)
    const projectPaths = [
      ...new Set(
        (snapshot.graph?.nodes ?? [])
          .filter((n) => typeof n.projectPath === "string" && n.projectPath)
          .map((n) => n.projectPath),
      ),
    ];

    // Run external API scan for each project path and attach results to nodes
    const externalApisByPath = new Map();
    await Promise.all(
      projectPaths.map(async (pp) => {
        try {
          const apis = await scanExternalApis(pp);
          externalApisByPath.set(pp, apis);
        } catch (_) {}
      }),
    );
    // Attach scanned externalApis to each node so buildChatContext + buildNodeDetails see them
    if (snapshot.graph?.nodes) {
      for (const node of snapshot.graph.nodes) {
        if (node.projectPath && externalApisByPath.has(node.projectPath)) {
          node.externalApis = externalApisByPath.get(node.projectPath);
        }
      }
    }

    const findings = await runScan(
      snapshot,
      Array.isArray(nodeIds) ? nodeIds : undefined,
    );
    const policies = extractAgentPolicies(safeMessages);
    const scopedIds =
      Array.isArray(nodeIds) && nodeIds.length > 0 ? new Set(nodeIds) : null;
    const allNodes = snapshot.graph?.nodes ?? [];
    const allEdges = snapshot.graph?.edges ?? [];
    const scopedNodes = scopedIds
      ? allNodes.filter((node) => scopedIds.has(node.id))
      : allNodes;
    // Prefer the UI's already-filtered edge list when provided — it is the exact
    // same set the node detail panel renders, so get_node_details returns matching data.
    const uiEdges = Array.isArray(graphEdges) && graphEdges.length > 0 ? graphEdges : null;
    const scopedEdges = uiEdges ?? (scopedIds
      ? allEdges.filter((edge) => {
          if (edge.sourcePort === 0 && edge.targetPort === 0) {
            return scopedIds.has(edge.source) && scopedIds.has(edge.target);
          }
          return scopedIds.has(edge.source) || scopedIds.has(edge.target);
        })
      : allEdges);
    const baseSystemPrompt = await buildChatContext(
      snapshot,
      findings,
      typeof tabLabel === "string" ? tabLabel : null,
      Array.isArray(nodeIds) ? nodeIds : null,
    );
    const systemPrompt = `${baseSystemPrompt}\n\n${buildPolicyPrompt(policies, options)}`;

    const openai = apiKey ? new OpenAI({ apiKey }) : null;

    const dockerPreflightRoots = new Set();
    const latestUserMessage = [...safeMessages]
      .reverse()
      .find((message) => message?.role === "user");
    const latestUserText = normalizeMessageText(latestUserMessage?.content);
    const directQuestionType = classifyDirectNodeQuestion(latestUserText);
    const prefetchedNode = shouldPrefetchNodeDetails(latestUserText)
      ? findMentionedScopedNode(latestUserText, scopedNodes)
      : null;
    const prefetchedNodeDetails = prefetchedNode
      ? buildNodeDetails(prefetchedNode, scopedNodes, scopedEdges)
      : null;
    const directNodeAnswer = buildDirectNodeAnswer(
      directQuestionType,
      prefetchedNode,
      scopedNodes,
      scopedEdges,
    );

    if (prefetchedNode && prefetchedNodeDetails) {
      sendStep(event, {
        type: "get_node_details",
        label: `details: ${prefetchedNode.name}`,
        path: prefetchedNode.name,
        done: true,
      });
    }

    if (directNodeAnswer) {
      console.log("[auth] Direct node answer (no AI call, no usage counted)");
      if (!event.sender.isDestroyed()) {
        event.sender.send("agent:chat-token", directNodeAnswer);
      }
      return { success: true, content: directNodeAnswer };
    }

    const initialTurnMessages = [
      { role: "system", content: systemPrompt },
      ...(prefetchedNodeDetails
        ? [
            {
              role: "system",
              content:
                `Authoritative runtime details for the current user question. ` +
                `Treat this as the result of calling get_node_details("${prefetchedNode.name}") and ground your answer in it.\n\n` +
                `${prefetchedNodeDetails}`,
            },
          ]
        : []),
      ...safeMessages,
    ];

    async function* streamProxyChatCompletion(requestPayload, countUsage) {
      console.log("[auth] Proxy chat call, countUsage:", countUsage);
      const res = await fetch(`${SUPABASE_URL}/functions/v1/chat`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: SUPABASE_ANON_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          request: requestPayload,
          count_usage: countUsage,
        }),
      });

      if (res.status === 429) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(
          `Daily free AI limit reached (${errData.used || SENTINEL_DAILY_LIMIT}/${errData.limit || SENTINEL_DAILY_LIMIT}). Enter your own API key for unlimited calls.`,
        );
      }

      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => "Backend error");
        throw new Error(`Proxy error: ${errText}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });

        const events = sseBuffer.split("\n\n");
        sseBuffer = events.pop() || "";

        for (const eventBlock of events) {
          const dataLines = eventBlock
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6));
          if (dataLines.length === 0) continue;
          const data = dataLines.join("\n").trim();
          if (!data || data === "[DONE]") continue;
          try {
            yield JSON.parse(data);
          } catch {}
        }
      }
    }

    function createChatCompletionStream(requestPayload, countUsage) {
      if (openai) {
        return openai.chat.completions.create(requestPayload);
      }
      return streamProxyChatCompletion(requestPayload, countUsage);
    }

    async function runTurn(
      turnMessages,
      continuationDepth = 0,
      forcedExecutionAttempted = false,
    ) {
      const stream = await createChatCompletionStream({
        model: "gpt-4o",
        messages: turnMessages,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
        max_tokens: 4096,
        temperature: 0.3,
        stream: true,
      }, false);

      const pendingCalls = {};
      const assistantMsg = {
        role: "assistant",
        content: null,
        tool_calls: undefined,
      };
      let finishReason = null;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta ?? {};
        finishReason = chunk.choices[0]?.finish_reason ?? finishReason;

        if (delta.content) {
          if (!event.sender.isDestroyed())
            event.sender.send("agent:chat-token", delta.content);
          assistantMsg.content = (assistantMsg.content ?? "") + delta.content;
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!pendingCalls[i])
              pendingCalls[i] = { id: "", name: "", args: "" };
            if (tc.id) pendingCalls[i].id = tc.id;
            if (tc.function?.name) pendingCalls[i].name = tc.function.name;
            if (tc.function?.arguments)
              pendingCalls[i].args += tc.function.arguments;
          }
        }
      }

      if (
        finishReason === "tool_calls" &&
        Object.keys(pendingCalls).length > 0
      ) {
        const toolCallList = Object.values(pendingCalls).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        }));
        assistantMsg.tool_calls = toolCallList;

        const toolResults = await Promise.all(
          toolCallList.map(async (tc) => {
            let result;
            try {
              const args = JSON.parse(tc.function.arguments);
              if (tc.function.name === "read_file") {
                sendStep(event, {
                  type: "read_file",
                  label: path.basename(args.path),
                  path: args.path,
                });
                result = agentReadFile(args.path, projectPaths);
              } else if (tc.function.name === "write_file") {
                const targetPath =
                  typeof args.path === "string"
                    ? path.normalize(args.path)
                    : "";
                const targetBase = path.basename(targetPath).toLowerCase();
                const isDockerConfigWrite =
                  targetBase === "dockerfile" ||
                  targetBase.startsWith("dockerfile.") ||
                  targetBase === "docker-compose.yml" ||
                  targetBase === "docker-compose.yaml" ||
                  targetBase === "compose.yml" ||
                  targetBase === "compose.yaml";
                if (isDockerConfigWrite) {
                  const hasPreflight = Array.from(dockerPreflightRoots).some(
                    (rootPath) =>
                      targetPath === rootPath ||
                      targetPath.startsWith(rootPath + path.sep),
                  );
                  if (!hasPreflight) {
                    result = `Error: must call discover_docker_plan(project_root) for this project before writing Dockerfile/compose files.`;
                    return {
                      role: "tool",
                      tool_call_id: tc.id,
                      content: result,
                    };
                  }
                }
                sendStep(event, {
                  type: "run_command",
                  label: `write: ${path.basename(args.path)}`,
                  path: args.path,
                });
                result = await agentWriteFile(
                  args.path,
                  args.content,
                  projectPaths,
                );
              } else if (tc.function.name === "discover_runbook") {
                sendStep(event, {
                  type: "list_directory",
                  label: `runbook: ${args.project_root}`,
                  path: args.project_root,
                });
                result = await agentDiscoverRunbook(
                  args.project_root,
                  projectPaths,
                );
              } else if (tc.function.name === "discover_docker_plan") {
                sendStep(event, {
                  type: "list_directory",
                  label: `docker-plan: ${args.project_root}`,
                  path: args.project_root,
                });
                result = await agentDiscoverDockerPlan(
                  args.project_root,
                  projectPaths,
                );
                if (
                  typeof result === "string" &&
                  !result.startsWith("Error:")
                ) {
                  dockerPreflightRoots.add(path.normalize(args.project_root));
                }
              } else if (tc.function.name === "list_directory") {
                sendStep(event, {
                  type: "list_directory",
                  label: args.path,
                  path: args.path,
                });
                result = agentListDirectory(args.path, projectPaths);
              } else if (tc.function.name === "get_node_details") {
                sendStep(event, {
                  type: "get_node_details",
                  label: `details: ${args.name}`,
                  path: args.name,
                });
                const node = resolveNodeByName(
                  args.name,
                  scopedNodes,
                  allNodes,
                );
                const detailNodes = scopedIds ? scopedNodes : allNodes;
                const detailEdges = scopedIds ? scopedEdges : allEdges;
                result = buildNodeDetails(node, detailNodes, detailEdges);
              } else if (tc.function.name === "propose_fix") {
                if (options.autopilotEnabled) {
                  const autopilotAction =
                    args.fix_type === "restart-container" &&
                    typeof args.container_id === "string"
                      ? {
                          type: "restart-container",
                          containerId: args.container_id,
                        }
                      : args.fix_type === "kill-port" &&
                          Number.isInteger(args.port) &&
                          Number.isInteger(args.pid)
                        ? {
                            type: "kill-port",
                            port: args.port,
                            pid: args.pid,
                          }
                        : null;

                  if (autopilotAction) {
                    sendStep(event, {
                      type:
                        args.fix_type === "restart-container"
                          ? "docker_control"
                          : "run_command",
                      label: `[autopilot] ${args.label ?? args.fix_type}`,
                      path:
                        args.fix_type === "restart-container"
                          ? args.container_id
                          : String(args.port ?? ""),
                    });
                    const applyResult = await executeAction(autopilotAction);
                    if (applyResult?.success) {
                      logSentinelActivity(
                        "Sentinel autopilot applied a fix",
                        args.label ?? args.fix_type,
                      );
                    }
                    result = applyResult?.success
                      ? `Autopilot applied safe fix immediately: ${args.label ?? args.fix_type}.`
                      : `Autopilot failed to apply safe fix: ${args.label ?? args.fix_type}.`;
                  } else {
                    const fixId = `fix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                    const proposal = { id: fixId, ...args };
                    if (!event.sender.isDestroyed())
                      event.sender.send("agent:fix-proposal", proposal);
                    result = `Autopilot could not auto-apply this fix type. Fix button shown to user (id: ${fixId}).`;
                  }
                } else {
                  const fixId = `fix_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                  const proposal = { id: fixId, ...args };
                  if (!event.sender.isDestroyed())
                    event.sender.send("agent:fix-proposal", proposal);
                  result = `Fix button shown to user (id: ${fixId}). Continue your explanation — the user will click the button to apply.`;
                }
              } else if (tc.function.name === "launch_in_terminal") {
                sendStep(event, {
                  type: "run_command",
                  label: `terminal: ${args.command}`,
                  path: args.cwd,
                });
                if (
                  policies.disallowInstalls &&
                  isInstallOrUpdateCommand(args.command)
                ) {
                  result =
                    'Error: install/update commands are disabled for this chat because the user explicitly requested "do not install".';
                } else {
                  result = await agentLaunchInTerminal(
                    args.command,
                    args.cwd,
                    projectPaths,
                  );
                  // For docker compose launches, immediately verify from the same cwd
                  // so the assistant returns concrete evidence instead of guesses.
                  if (
                    typeof result === "string" &&
                    !result.startsWith("Error:") &&
                    isDockerComposeUpCommand(args.command)
                  ) {
                    sendStep(event, {
                      type: "run_command",
                      label: "verify: docker compose ps/logs",
                      path: args.cwd,
                    });
                    const verifyOutput = await agentRunCommand(
                      "docker compose ps -a && echo '---' && docker compose logs --tail=120",
                      args.cwd,
                      projectPaths,
                      policies,
                    );
                    result = `${result}\n\nVerification output:\n${verifyOutput}`;
                  }
                }
              } else if (tc.function.name === "run_command") {
                sendStep(event, {
                  type: "run_command",
                  label: args.command,
                  path: args.cwd,
                });
                result = await agentRunCommand(
                  args.command,
                  args.cwd,
                  projectPaths,
                  policies,
                );
              } else if (tc.function.name === "docker_logs") {
                sendStep(event, {
                  type: "docker_logs",
                  label: `logs: ${args.container_id}`,
                  path: args.container_id,
                });
                result = await agentDockerLogs(
                  args.container_id,
                  args.tail ?? 80,
                );
              } else if (tc.function.name === "docker_exec") {
                sendStep(event, {
                  type: "docker_exec",
                  label: `exec: ${args.command}`,
                  path: args.container_id,
                });
                result = await agentDockerExec(args.container_id, args.command);
              } else if (tc.function.name === "docker_control") {
                sendStep(event, {
                  type: "docker_control",
                  label: `${args.action}: ${args.container_id}`,
                  path: args.container_id,
                });
                result = await agentDockerControl(
                  args.container_id,
                  args.action,
                );
              } else {
                result = "Unknown tool.";
              }
            } catch (e) {
              result = `Parse error: ${e.message}`;
            }
            return {
              role: "tool",
              tool_call_id: tc.id,
              content:
                typeof result === "string" ? result : JSON.stringify(result),
            };
          }),
        );

        await runTurn(
          [...turnMessages, assistantMsg, ...toolResults],
          continuationDepth,
          forcedExecutionAttempted,
        );
        return;
      }

      if (
        policies.forceNoBackAndForth &&
        !forcedExecutionAttempted &&
        typeof assistantMsg.content === "string" &&
        looksLikeFollowUpQuestion(assistantMsg.content)
      ) {
        await runTurn(
          [
            ...turnMessages,
            { role: "assistant", content: assistantMsg.content },
            {
              role: "user",
              content:
                "Do not ask me for confirmation. Continue end-to-end: execute the fix yourself with available tools, retry automatically on failure, verify with concrete command output, then summarize changes/commands/verification/blockers.",
            },
          ],
          continuationDepth,
          true,
        );
        return;
      }

      if (
        finishReason === "length" &&
        typeof assistantMsg.content === "string" &&
        assistantMsg.content.trim().length > 0
      ) {
        if (continuationDepth >= 2) {
          if (!event.sender.isDestroyed()) {
            event.sender.send(
              "agent:chat-token",
              "\n\n_(Response reached length limit. Ask me to continue if you want more.)_",
            );
          }
          return;
        }
        await runTurn(
          [
            ...turnMessages,
            { role: "assistant", content: assistantMsg.content },
            {
              role: "user",
              content:
                "Continue from exactly where you left off. Do not repeat prior text. Keep formatting consistent and finish the answer.",
            },
          ],
          continuationDepth + 1,
          forcedExecutionAttempted,
        );
      }
    }

    // Increment usage upfront — every AI attempt costs a call
    if (!apiKey && accessToken && SUPABASE_URL) {
      await incrementUsageCount(accessToken);
    }

    await runTurn(initialTurnMessages);
    return { success: true };
  } catch (err) {
    console.error("agent:chat error:", err);
    return { success: false, error: err.message };
  }
});
