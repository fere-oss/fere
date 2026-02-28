const { app, BrowserWindow, ipcMain, shell, nativeImage, Notification, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");

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
    return { valid: false, reason: "Connections to private/internal addresses are not allowed for remote URIs" };
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
const { scanExternalApis } = require("./services/externalApiScanner");
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
} = require("./services/dockerMonitor");
const {
  startLogStream,
  stopLogStream,
  stopContainerStreams,
  stopAllStreams,
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
const analytics = require("./analytics");
const { generateHTML } = require("./services/graphExporter");
const { createGist, updateGist, buildPreviewUrl } = require("./services/gistPublisher");

app.setName("Fere");
app.name = "Fere";
process.title = "Fere";

// Keep a global reference of the window object
let mainWindow;
let snapshotScheduler = null;
let snapshotHandler = null;
let alertNodeMap = new Map();

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Fere",
    icon: appIconPath,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 15 },
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

  // Security: Set up navigation blocking
  // Allow only dev server in development, file:// protocol in production
  const allowedOrigins = isDev
    ? ["http://localhost:3001"]
    : ["file://"];
  setupNavigationBlocking(mainWindow.webContents, allowedOrigins);

  // Security: Block new windows, open http/https in external browser
  setupWindowOpenHandler(mainWindow.webContents);

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

app.whenReady().then(() => {
  // Security: Set up default-deny permission handlers
  setupPermissionHandlers();

  // Security: Set up CSP (different for dev vs production)
  setupCSP(isDev);

  // Initialize alert manager (loads preferences from disk)
  initAlertManager();

  // Initialize analytics
  analytics.init();
  analytics.capture("app_launched", { is_dev: isDev });

  if (process.platform === "darwin" && isDev) {
    const icon = nativeImage.createFromPath(
      resolveAppIconPath()
    );
    if (!icon.isEmpty()) {
      app.dock.setIcon(icon);
    }
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", async () => {
  await analytics.shutdown();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

/**
 * Maintain a shadow copy of all graph nodes from snapshot deltas
 * for alert evaluation purposes.
 */
function updateAlertNodeMap(delta) {
  if (delta.type === 'full' && delta.graph && Array.isArray(delta.graph.nodes)) {
    alertNodeMap = new Map(delta.graph.nodes.map(n => [n.id, n]));
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

    snapshotHandler = (delta) => {
      if (event.sender.isDestroyed()) {
        snapshotScheduler.removeListener("snapshot", snapshotHandler);
        return;
      }
      event.sender.send("snapshot-delta", delta);

      // Evaluate alert notifications on each snapshot
      try {
        updateAlertNodeMap(delta);
        evaluateAlerts(Array.from(alertNodeMap.values()));
      } catch (err) {
        console.error("[AlertManager] Error evaluating alerts:", err);
      }
    };

    snapshotScheduler.on("snapshot", snapshotHandler);
    snapshotScheduler.start();

    return { success: true };
  } catch (error) {
    console.error("Error starting snapshot stream:", error);
    return { success: false, error: error.message };
  }
});

// Stop push-based snapshot stream
ipcMain.handle("stop-snapshot-stream", async () => {
  if (snapshotScheduler) {
    if (snapshotHandler) {
      snapshotScheduler.removeListener("snapshot", snapshotHandler);
      snapshotHandler = null;
    }
    snapshotScheduler.stop();
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

// Get external APIs for a project path (on-demand, with TTL cache)
const _externalApisCache = new Map(); // path → { data, time }
const _EXTERNAL_APIS_CACHE_TTL = 30000; // 30s

ipcMain.handle("get-external-apis", async (event, projectPath) => {
  try {
    if (!projectPath || typeof projectPath !== "string") {
      return [];
    }
    const resolvedPath = path.resolve(projectPath);

    // Check TTL cache first
    const cached = _externalApisCache.get(resolvedPath);
    if (cached && Date.now() - cached.time < _EXTERNAL_APIS_CACHE_TTL) {
      return cached.data;
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

// Allowlisted binaries for start-process (prevents arbitrary command execution)
const ALLOWED_BINARIES = new Set([
  // Node.js / JavaScript
  "node", "npm", "npx", "yarn", "pnpm", "bun", "deno", "tsx", "ts-node",
  // Python
  "python", "python3", "pip", "pip3", "uvicorn", "gunicorn", "flask",
  "django-admin", "poetry", "pipenv", "uv",
  // Ruby
  "ruby", "rails", "bundle", "bundler", "rake", "puma",
  // Java / JVM
  "java", "javac", "mvn", "mvnw", "gradle", "gradlew", "./gradlew", "./mvnw",
  // Go
  "go", "air",
  // Rust
  "cargo", "rustc",
  // PHP
  "php", "composer", "artisan",
  // .NET
  "dotnet",
  // Elixir / Erlang
  "mix", "elixir", "iex",
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
        return { success: false, error: "Working directory is not a directory" };
      }
    } catch {
      return { success: false, error: "Working directory does not exist" };
    }

    // Reject shell metacharacters that indicate shell piping/chaining
    if (/[|;&`$><\n]/.test(command)) {
      return { success: false, error: "Command contains disallowed shell metacharacters" };
    }

    const parts = parseCommand(command);
    if (!parts) {
      return { success: false, error: "Malformed command (unmatched quote or escape)" };
    }
    if (parts.length === 0) {
      return { success: false, error: "Empty command" };
    }

    const requestedBinary = parts[0];
    const binary = path.basename(requestedBinary);

    // Prevent allowlist bypass via arbitrary absolute/relative paths.
    // Allow explicit wrapper scripts only from the selected cwd.
    const usesPath = requestedBinary.includes("/") || requestedBinary.includes("\\");
    const isAllowedWrapper = requestedBinary === "./gradlew" || requestedBinary === "./mvnw";
    if (usesPath && !isAllowedWrapper) {
      return { success: false, error: "Binary path must be a known wrapper or bare command" };
    }

    if (!ALLOWED_BINARIES.has(binary)) {
      console.warn(`start-process: blocked disallowed binary "${requestedBinary}"`);
      return { success: false, error: `Binary "${binary}" is not in the allowlist` };
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
        return { success: false, error: `Wrapper script not executable: ${requestedBinary}` };
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
      console.warn("[Security] Blocked open-url request:", url, "-", validation.reason);
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
      console.warn("[Security] Blocked HTTP request:", url, "-", validation.reason);
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

      if (shouldSendBody && !Object.keys(requestHeaders).some((k) => k.toLowerCase() === "content-length")) {
        requestHeaders["Content-Length"] = Buffer.byteLength(body, "utf8").toString();
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

// Open Terminal at specified path (macOS)
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

    // Use spawn with array args to avoid shell escaping issues
    const { spawn } = require("child_process");
    return new Promise((resolve) => {
      const child = spawn("open", ["-a", "Terminal", resolvedPath], {
        detached: true,
        stdio: "ignore",
      });

      child.on("error", (err) => {
        console.error("Error opening terminal:", err);
        resolve({ success: false, error: err.message });
      });

      child.unref();
      // Give it a moment to launch, then resolve success
      setTimeout(() => resolve({ success: true }), 100);
    });
  } catch (error) {
    console.error("Error opening terminal:", error);
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

// Get database tables from a container
ipcMain.handle("get-database-tables", async (_, containerId, containerImage) => {
  try {
    return await getDatabaseTables(containerId, containerImage);
  } catch (error) {
    console.error("Error getting database tables:", error);
    return { error: error.message, tables: [] };
  }
});

// Get table data from a database container
ipcMain.handle("get-table-data", async (_, containerId, containerImage, tableName, limit) => {
  try {
    return await getTableData(containerId, containerImage, tableName, limit || 100);
  } catch (error) {
    console.error("Error getting table data:", error);
    return { error: error.message, columns: [], rows: [] };
  }
});

// Execute a query on a database container
ipcMain.handle("execute-database-query", async (_, containerId, containerImage, query) => {
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
});

// Create a new table in a database container
ipcMain.handle("create-database-table", async (_, containerId, containerImage, tableName, columns) => {
  try {
    return await createTable(containerId, containerImage, tableName, columns);
  } catch (error) {
    console.error("Error creating database table:", error);
    return { error: error.message, success: false };
  }
});

// Connect directly to remote MongoDB via URI
ipcMain.handle("connect-mongo-uri", async (_, uri) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid) return { error: check.reason, tables: [], dbType: "mongodb" };
  try {
    const result = await connectMongoUri(uri);
    analytics.capture("database_connected", { db_type: "mongodb", mode: "remote_uri", success: !result.error });
    return result;
  } catch (error) {
    console.error("Error connecting Mongo URI:", error);
    return { error: error.message, tables: [], dbType: "mongodb" };
  }
});

// Get collection data from remote MongoDB URI
ipcMain.handle("get-mongo-uri-collection-data", async (_, uri, collectionName, limit) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid) return { error: check.reason, columns: [], rows: [], dbType: "mongodb" };
  try {
    return await getMongoUriCollectionData(uri, collectionName, limit || 100);
  } catch (error) {
    console.error("Error loading Mongo URI collection data:", error);
    return { error: error.message, columns: [], rows: [], dbType: "mongodb" };
  }
});

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
  if (!check.valid) return { error: check.reason, tables: [], dbType: "postgresql" };
  try {
    const result = await connectPostgresUri(uri);
    analytics.capture("database_connected", { db_type: "postgresql", mode: "remote_uri", success: !result.error });
    return result;
  } catch (error) {
    console.error("Error connecting PostgreSQL URI:", error);
    return { error: error.message, tables: [], dbType: "postgresql" };
  }
});

// Get table data from remote PostgreSQL URI
ipcMain.handle("get-postgres-uri-table-data", async (_, uri, tableName, limit) => {
  const check = validateRemoteDbUri(uri);
  if (!check.valid) return { error: check.reason, columns: [], rows: [], dbType: "postgresql" };
  try {
    return await getPostgresUriTableData(uri, tableName, limit || 100);
  } catch (error) {
    console.error("Error loading PostgreSQL URI table data:", error);
    return { error: error.message, columns: [], rows: [], dbType: "postgresql" };
  }
});

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
  if (!check.valid) return { error: check.reason, tables: [], dbType: "elasticsearch" };
  try {
    return await connectElasticsearchUri(baseUrl);
  } catch (error) {
    console.error("Error connecting to Elasticsearch:", error);
    return { error: error.message, tables: [], dbType: "elasticsearch" };
  }
});

// Fetch index data from Elasticsearch
ipcMain.handle("get-elasticsearch-uri-index-data", async (_, baseUrl, indexName, limit) => {
  const check = validateRemoteDbUri(baseUrl);
  if (!check.valid) return { columns: [], rows: [], error: check.reason, dbType: "elasticsearch" };
  try {
    return await getElasticsearchUriIndexData(baseUrl, indexName, limit);
  } catch (error) {
    console.error("Error fetching Elasticsearch index data:", error);
    return { columns: [], rows: [], error: error.message, dbType: "elasticsearch" };
  }
});

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
ipcMain.handle("start-container-logs", async (event, containerId, options = {}) => {
  try {
    const sender = event.sender;
    let streamId = "";
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

    streamId = await startLogStream(
      containerId,
      options,
      // onData callback — use logData.streamId (always valid) instead of the
      // outer `streamId` variable which may still be "" if data arrives before
      // the await resolves (Bug 24).
      (logData) => {
        if (!safeSend("container-log-data", logData)) {
          const sid = logData.streamId || streamId;
          if (sid) stopLogStream(sid);
        }
      },
      // onError callback — streamId passed as second arg from startLogStream
      (error, sid) => {
        const delivered = safeSend("container-log-error", {
          streamId: sid || streamId,
          containerId,
          error: error.message,
        });
        if (!delivered) {
          const id = sid || streamId;
          if (id) stopLogStream(id);
        }
      },
      // onClose callback — streamId passed as second arg from startLogStream
      (code, sid) => {
        safeSend("container-log-close", {
          streamId: sid || streamId,
          containerId,
          exitCode: code,
        });
      }
    );

    if (sender && !sender.isDestroyed()) {
      sender.once("destroyed", () => {
        if (streamId) {
          stopLogStream(streamId);
        }
      });
    }

    analytics.capture("container_logs_started");
    return { success: true, streamId };
  } catch (error) {
    console.error("Error starting container logs:", error);
    return { success: false, error: error.message };
  }
});

// Stop a specific log stream
ipcMain.handle("stop-container-logs", async (_, streamId) => {
  try {
    const stopped = stopLogStream(streamId);
    return { success: stopped };
  } catch (error) {
    console.error("Error stopping container logs:", error);
    return { success: false, error: error.message };
  }
});

// Stop all log streams for a container
ipcMain.handle("stop-container-streams", async (_, containerId) => {
  try {
    const count = stopContainerStreams(containerId);
    return { success: true, count };
  } catch (error) {
    console.error("Error stopping container streams:", error);
    return { success: false, error: error.message };
  }
});

// Stop all active log streams
ipcMain.handle("stop-all-container-logs", async () => {
  try {
    stopAllStreams();
    return { success: true };
  } catch (error) {
    console.error("Error stopping all container logs:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Analytics
// ============================================

ipcMain.handle("get-analytics-id", () => {
  return analytics.getDistinctId();
});

// ============================================
// IPC Handlers - Share (GitHub Gist)
// ============================================

const os = require("os");

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
  if (!token) throw new Error("No GitHub token configured. Please add one in the Share settings.");

  // REACT_APP_ vars aren't loaded into Electron main by CRA — read .env directly
  let logoDevToken = process.env.REACT_APP_LOGO_DEV_TOKEN || "";
  if (!logoDevToken) {
    try {
      const envPath = path.join(__dirname, '../.env');
      const envContent = require('fs').readFileSync(envPath, 'utf8');
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
