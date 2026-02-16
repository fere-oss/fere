const { app, BrowserWindow, ipcMain, shell, nativeImage, Notification } = require("electron");
const path = require("path");

// Import security utilities
const {
  validateExternalUrl,
  validateHttpRequestUrl,
  setupNavigationBlocking,
  setupWindowOpenHandler,
  setupPermissionHandlers,
  setupCSP,
  MAX_RESPONSE_SIZE,
} = require("./security");

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
} = require("./services/alertManager");

app.setName("Fere");
app.name = "Fere";
process.title = "Fere";

// Keep a global reference of the window object
let mainWindow;
let snapshotScheduler = null;
let snapshotHandler = null;
let alertNodeMap = new Map();

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Fere",
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

  if (process.platform === "darwin") {
    const icon = nativeImage.createFromPath(
      path.join(__dirname, "../assets/icon.png")
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
        if (existing) alertNodeMap.set(patch.id, { ...existing, ...patch });
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

// Get external APIs for a project path (on-demand)
ipcMain.handle("get-external-apis", async (event, projectPath) => {
  try {
    const fs = require("fs");
    if (!projectPath || typeof projectPath !== "string") {
      return [];
    }
    const resolvedPath = path.resolve(projectPath);
    if (!fs.existsSync(resolvedPath)) {
      return [];
    }
    const stats = fs.statSync(resolvedPath);
    if (!stats.isDirectory()) {
      return [];
    }
    return await scanExternalApis(resolvedPath);
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
    if (result.success) {
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
  "java", "javac", "mvn", "gradle", "gradlew", "./gradlew",
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
    if (parts.length === 0) {
      return { success: false, error: "Empty command" };
    }

    const binary = path.basename(parts[0]);
    if (!ALLOWED_BINARIES.has(binary)) {
      console.warn(`start-process: blocked disallowed binary "${binary}"`);
      return { success: false, error: `Binary "${binary}" is not in the allowlist` };
    }

    const { spawn } = require("child_process");
    const child = spawn(parts[0], parts.slice(1), {
      cwd,
      detached: true,
      stdio: "ignore",
    });
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

// Execute HTTP request (for API testing)
// Note: This app is designed to test local dev services, so localhost is allowed here.
// For apps that should block SSRF entirely, set allowPrivate to false.
ipcMain.handle("execute-http-request", async (event, options) => {
  try {
    const { method, url, headers, body } = options;

    // Security: Validate URL (allow localhost since this is a local dev tool)
    const validation = validateHttpRequestUrl(url, true /* allowPrivate for local dev testing */);
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

        res.on("data", (chunk) => {
          totalSize += chunk.length;
          // Security: Cap response size to prevent memory abuse
          if (totalSize > MAX_RESPONSE_SIZE) {
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
          const duration = Date.now() - startTime;
          const responseBody = Buffer.concat(chunks).toString("utf8");

          // Try to parse as JSON for pretty display
          let parsedBody = responseBody;
          let isJson = false;
          const contentType = res.headers["content-type"] || "";
          if (contentType.includes("application/json")) {
            try {
              parsedBody = JSON.stringify(JSON.parse(responseBody), null, 2);
              isJson = true;
            } catch (e) {
              // Keep as string
            }
          }

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

// Open Terminal at specified path (macOS)
ipcMain.handle("open-terminal", async (event, dirPath) => {
  try {
    // Validate the path exists and is a directory
    const fs = require("fs");
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
    return await executeQuery(containerId, containerImage, query);
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
  try {
    return await connectMongoUri(uri);
  } catch (error) {
    console.error("Error connecting Mongo URI:", error);
    return { error: error.message, tables: [], dbType: "mongodb" };
  }
});

// Get collection data from remote MongoDB URI
ipcMain.handle("get-mongo-uri-collection-data", async (_, uri, collectionName, limit) => {
  try {
    return await getMongoUriCollectionData(uri, collectionName, limit || 100);
  } catch (error) {
    console.error("Error loading Mongo URI collection data:", error);
    return { error: error.message, columns: [], rows: [], dbType: "mongodb" };
  }
});

// Execute Mongo command against remote URI
ipcMain.handle("execute-mongo-uri-query", async (_, uri, command) => {
  try {
    return await executeMongoUriQuery(uri, command);
  } catch (error) {
    console.error("Error executing Mongo URI query:", error);
    return { error: error.message, dbType: "mongodb" };
  }
});

// Connect directly to remote PostgreSQL via URI
ipcMain.handle("connect-postgres-uri", async (_, uri) => {
  try {
    return await connectPostgresUri(uri);
  } catch (error) {
    console.error("Error connecting PostgreSQL URI:", error);
    return { error: error.message, tables: [], dbType: "postgresql" };
  }
});

// Get table data from remote PostgreSQL URI
ipcMain.handle("get-postgres-uri-table-data", async (_, uri, tableName, limit) => {
  try {
    return await getPostgresUriTableData(uri, tableName, limit || 100);
  } catch (error) {
    console.error("Error loading PostgreSQL URI table data:", error);
    return { error: error.message, columns: [], rows: [], dbType: "postgresql" };
  }
});

// Execute PostgreSQL query against remote URI
ipcMain.handle("execute-postgres-uri-query", async (_, uri, query) => {
  try {
    return await executePostgresUriQuery(uri, query);
  } catch (error) {
    console.error("Error executing PostgreSQL URI query:", error);
    return { error: error.message, dbType: "postgresql" };
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

    streamId = startLogStream(
      containerId,
      options,
      // onData callback - send log data to renderer
      (logData) => {
        if (!safeSend("container-log-data", logData) && streamId) {
          stopLogStream(streamId);
        }
      },
      // onError callback - send error to renderer
      (error) => {
        const delivered = safeSend("container-log-error", {
          streamId,
          containerId,
          error: error.message,
        });
        if (!delivered && streamId) {
          stopLogStream(streamId);
        }
      },
      // onClose callback - notify renderer that stream closed
      (code) => {
        safeSend("container-log-close", {
          streamId,
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
