const { app, BrowserWindow, ipcMain, shell, nativeImage } = require("electron");
const path = require("path");
// Import services
const {
  getDevProcesses,
  getAllProcesses,
  getProcessByPid,
  killProcess,
} = require("./services/processMonitor");
const {
  getListeningPorts,
  getEstablishedConnections,
} = require("./services/portMonitor");
const {
  buildConnectionGraph,
  getEnvironmentSummary,
} = require("./services/connectionGraph");
const { getSystemSnapshot } = require("./services/systemSnapshot");
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
} = require("./services/databaseQuery");

// Keep a global reference of the window object
let mainWindow;

const isDev = process.env.NODE_ENV === "development" || !app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Load the app
  if (isDev) {
    mainWindow.loadURL("http://localhost:3001");
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "../build/index.html"));
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.setName("Fere");

app.whenReady().then(() => {
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
    return await killProcess(pid);
  } catch (error) {
    console.error("Error killing process:", error);
    return { success: false, error: error.message };
  }
});

// ============================================
// IPC Handlers - Quick Actions
// ============================================

// Open URL in default browser
ipcMain.handle("open-url", async (event, url) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (error) {
    console.error("Error opening URL:", error);
    return { success: false, error: error.message };
  }
});

// Execute HTTP request (for API testing)
ipcMain.handle("execute-http-request", async (event, options) => {
  try {
    const { method, url, headers, body } = options;

    // Validate URL
    if (!url || typeof url !== "string") {
      return { success: false, error: "Invalid URL" };
    }

    // Parse URL to determine http vs https
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const httpModule = isHttps ? require("https") : require("http");

    return new Promise((resolve) => {
      const startTime = Date.now();

      const requestOptions = {
        method: method || "GET",
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers: headers || {},
        timeout: 30000, // 30 second timeout
      };

      const req = httpModule.request(requestOptions, (res) => {
        let responseBody = "";

        res.on("data", (chunk) => {
          responseBody += chunk;
        });

        res.on("end", () => {
          const duration = Date.now() - startTime;

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
              size: Buffer.byteLength(responseBody, "utf8"),
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

      // Send body for POST/PUT/PATCH
      if (body && ["POST", "PUT", "PATCH"].includes(method)) {
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
