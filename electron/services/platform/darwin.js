/**
 * macOS platform implementation.
 *
 * All macOS-specific OS calls (ps, lsof, kill, open) live here.
 * Consumers import from platform/index.js which routes to this module
 * on darwin. A future win32.js provides the same exports for Windows.
 */

const { exec, execFile, spawn, execFileSync } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const path = require("path");

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================
// Process Monitoring
// ============================================

/**
 * Get raw process list from the OS.
 * Returns parsed array of { pid, user, cpu, memory, vsz, rss, tty, status, startTime, cpuTime, command }.
 */
async function getProcessList() {
  const { stdout } = await execAsync("ps aux");
  return parseProcessList(stdout);
}

/**
 * Parse macOS `ps aux` output into structured objects.
 */
function parseProcessList(psOutput) {
  const lines = psOutput.trim().split("\n");
  const processes = [];

  // Skip header line (USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    const [user, pid, cpu, mem, vsz, rss, tty, stat, start, time, ...cmdParts] = parts;
    processes.push({
      pid: parseInt(pid, 10),
      user,
      cpu: parseFloat(cpu),
      memory: parseFloat(mem),
      vsz: parseInt(vsz, 10),
      rss: parseInt(rss, 10),
      tty,
      status: stat,
      startTime: start,
      cpuTime: time,
      command: cmdParts.join(" "),
    });
  }

  return processes;
}

/**
 * Get info for a single process by PID.
 * Returns parsed process object or null.
 */
async function getProcessInfoByPid(pid) {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "user,pid,%cpu,%mem,vsz,rss,tty,stat,start,time,command",
    ]);
    const processes = parseProcessList(stdout);
    return processes[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Kill a process by PID with signal escalation.
 * Tries the requested signal first, escalates to SIGKILL if needed.
 */
async function killProcess(pid, signal = "TERM") {
  const ALLOWED_SIGNALS = new Set(["TERM", "KILL", "INT", "HUP", "QUIT"]);
  const safeSignal = ALLOWED_SIGNALS.has(signal) ? signal : "TERM";
  const pidStr = String(pid);

  try {
    await execFileAsync("kill", [`-${safeSignal}`, pidStr]);
    // Give the process a brief moment to exit
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await execFileAsync("kill", ["-0", pidStr]);
      // Still alive, escalate to SIGKILL
      await execFileAsync("kill", ["-KILL", pidStr]);
    } catch (error) {
      // kill -0 failed, process is gone
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Lightweight PID enumeration (much cheaper than full ps aux).
 * Returns Set<number> of all running PIDs.
 */
async function enumeratePids() {
  try {
    const { stdout } = await execAsync("ps -eo pid");
    const pids = new Set();
    const lines = stdout.trim().split("\n");
    for (let i = 1; i < lines.length; i++) {
      const pid = parseInt(lines[i].trim(), 10);
      if (!isNaN(pid)) pids.add(pid);
    }
    return pids;
  } catch (error) {
    console.error("Error enumerating PIDs:", error);
    return new Set();
  }
}

// ============================================
// Port & Connection Monitoring
// ============================================

const LSOF_LINE_RE = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;
const NORMALIZE_SUFFIX_RE = /\s+\(.*\)$/;
const NORMALIZE_PREFIX_RE = /^TCP\s+/;
const HOST_PORT_RE = /:(\d+)$/;
const NETSTAT_LISTEN_RE = /\.(\d+)\s+\*\.\*\s+LISTEN/;

function parseLsofLine(line) {
  const match = line.match(LSOF_LINE_RE);
  if (!match) return null;
  const [, command, pid, user, fd, type, device, sizeOff, node, name] = match;
  return { command, pid, user, fd, type, device, sizeOff, node, name };
}

function normalizeName(name) {
  return name.replace(NORMALIZE_SUFFIX_RE, "").replace(NORMALIZE_PREFIX_RE, "").trim();
}

function stripBrackets(host) {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function parseHostPort(part) {
  const portMatch = part.match(HOST_PORT_RE);
  if (!portMatch) return null;
  const port = parseInt(portMatch[1], 10);
  const hostRaw = part.slice(0, part.lastIndexOf(":"));
  const host = stripBrackets(hostRaw) || "*";
  return { host, port };
}

/**
 * Fetch listening TCP ports via lsof.
 * Returns parsed array of { port, host, pid, process, user, protocol, fd }.
 */
async function fetchListeningPorts() {
  try {
    const { stdout } = await execAsync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null");
    return parseListeningPorts(stdout);
  } catch (error) {
    if (error.code === 1) return [];
    console.error("Error getting listening ports:", error);
    return [];
  }
}

/**
 * Parse lsof output for listening ports.
 */
function parseListeningPorts(lsofOutput) {
  if (!lsofOutput || !lsofOutput.trim()) return [];

  const lines = lsofOutput.trim().split("\n");
  const ports = [];

  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLsofLine(lines[i]);
    if (!parsed) continue;

    const { command, pid, user, fd, node, name } = parsed;
    const cleaned = normalizeName(name);
    const localPart = cleaned.split("->")[0].trim();
    const hostPort = parseHostPort(localPart);
    if (!hostPort) continue;

    ports.push({
      port: hostPort.port,
      host: hostPort.host,
      pid: parseInt(pid, 10),
      process: command,
      user,
      protocol: node.toLowerCase(),
      fd,
    });
  }

  // Deduplicate by port+pid
  const uniquePorts = new Map();
  for (const p of ports) {
    const key = `${p.port}-${p.pid}`;
    if (!uniquePorts.has(key)) {
      uniquePorts.set(key, p);
    }
  }

  return Array.from(uniquePorts.values());
}

/**
 * Fetch established TCP connections via lsof.
 * Returns parsed array of connection objects.
 */
async function fetchEstablishedConnections() {
  try {
    const { stdout } = await execAsync("lsof -iTCP -sTCP:ESTABLISHED -P -n 2>/dev/null");
    return parseEstablishedConnections(stdout);
  } catch (error) {
    if (error.code === 1) return [];
    console.error("Error getting connections:", error);
    return [];
  }
}

/**
 * Parse lsof output for established connections.
 */
function parseEstablishedConnections(lsofOutput) {
  if (!lsofOutput || !lsofOutput.trim()) return [];

  const lines = lsofOutput.trim().split("\n");
  const connections = [];

  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLsofLine(lines[i]);
    if (!parsed) continue;

    const { command, pid, user, node, name } = parsed;
    const cleaned = normalizeName(name);

    const parts = cleaned.split("->");
    if (parts.length !== 2) continue;

    const local = parseHostPort(parts[0].trim());
    const remote = parseHostPort(parts[1].trim());
    if (!local || !remote) continue;

    connections.push({
      pid: parseInt(pid, 10),
      process: command,
      user,
      localHost: local.host,
      localPort: local.port,
      remoteHost: remote.host,
      remotePort: remote.port,
      protocol: node.toLowerCase(),
    });
  }

  return connections;
}

/**
 * Fetch process info on a specific port via lsof.
 */
async function fetchProcessOnPort(port) {
  try {
    const { stdout } = await execAsync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n 2>/dev/null`);
    const ports = parseListeningPorts(stdout);
    return ports[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Lightweight listening port number enumeration via netstat.
 * Returns Set<number>.
 */
async function fetchListeningPortNumbers() {
  try {
    const { stdout } = await execAsync("netstat -an -p tcp 2>/dev/null");
    const ports = new Set();
    for (const line of stdout.trim().split("\n")) {
      if (!line.includes("LISTEN")) continue;
      const match = line.match(NETSTAT_LISTEN_RE);
      if (match) {
        ports.add(parseInt(match[1], 10));
      }
    }
    return ports;
  } catch (error) {
    return new Set();
  }
}

// ============================================
// CWD Resolution
// ============================================

function parseBatchedLsofCwdOutput(output = "") {
  const cwdByPid = new Map();
  let currentPid = null;

  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.slice(1), 10);
      continue;
    }
    if (line.startsWith("n") && currentPid !== null) {
      const cwd = line.slice(1).trim();
      cwdByPid.set(currentPid, cwd);
      currentPid = null;
    }
  }

  return cwdByPid;
}

/**
 * Batch CWD lookup for multiple PIDs — single lsof call.
 * Returns Map<number, string|null>.
 */
async function batchResolveCwds(pids) {
  if (pids.length === 0) return new Map();

  let parsed = new Map();
  try {
    const pidArgs = pids.map((p) => `-p ${p}`).join(" ");
    const { stdout } = await execAsync(`lsof -a -d cwd -Fn ${pidArgs} 2>/dev/null`);
    parsed = parseBatchedLsofCwdOutput(stdout);
  } catch (error) {
    // lsof often exits non-zero even when stdout includes partial results.
    parsed = parseBatchedLsofCwdOutput(error?.stdout || "");
  }

  // Fill in nulls for PIDs that had no result
  const result = new Map();
  for (const pid of pids) {
    result.set(pid, parsed.get(pid) || null);
  }
  return result;
}

/**
 * Single-PID CWD lookup via lsof.
 * Returns string|null.
 */
async function resolveCwd(pid) {
  try {
    const { stdout } = await execAsync(`lsof -a -p ${pid} -d cwd -Fn`);
    const line = stdout.split("\n").find((entry) => entry.startsWith("n"));
    return line ? line.slice(1).trim() : null;
  } catch (error) {
    const line = (error?.stdout || "").split("\n").find((entry) => entry.startsWith("n"));
    return line ? line.slice(1).trim() : null;
  }
}

// ============================================
// Docker Binary Paths
// ============================================

const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  "/opt/homebrew/bin/docker",
  "/usr/local/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
  "docker",
].filter(Boolean);

// ============================================
// Known System Services (macOS-specific)
// ============================================

const PLATFORM_KNOWN_SERVICES = {
  controlcenter: {
    description:
      "macOS Control Center daemon - manages Control Center widgets, toggles, and system controls like Wi-Fi, Bluetooth, Do Not Disturb, and AirDrop.",
    category: "system",
    displayName: "Control Center",
  },
  controlce: {
    description:
      "macOS Control Center daemon - manages Control Center widgets, toggles, and system controls like Wi-Fi, Bluetooth, Do Not Disturb, and AirDrop.",
    category: "system",
    displayName: "Control Center",
  },
  commcenter: {
    description:
      "macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.",
    category: "system",
    displayName: "CommCenter",
  },
  commcentre: {
    description:
      "macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.",
    category: "system",
    displayName: "CommCenter",
  },
  commcente: {
    description:
      "macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.",
    category: "system",
    displayName: "CommCenter",
  },
  airportd: {
    description:
      "macOS AirPort daemon - manages Wi-Fi connections, network scanning, and wireless network configuration.",
    category: "system",
    displayName: "AirPort Daemon",
  },
  bluetoothd: {
    description:
      "macOS Bluetooth daemon - handles Bluetooth device pairing, connections, and communication.",
    category: "system",
    displayName: "Bluetooth Daemon",
  },
  configd: {
    description:
      "macOS System Configuration daemon - monitors and manages system configuration, network settings, and dynamic store.",
    category: "system",
    displayName: "Config Daemon",
  },
  coreaudiod: {
    description:
      "macOS Core Audio daemon - manages audio routing, device selection, and audio processing for the system.",
    category: "system",
    displayName: "Core Audio",
  },
  distnoted: {
    description:
      "macOS Distributed Notification daemon - handles inter-process notifications and communication between apps.",
    category: "system",
    displayName: "Distributed Notifications",
  },
  fseventsd: {
    description:
      "macOS File System Events daemon - monitors file system changes and provides notifications to apps watching for changes.",
    category: "system",
    displayName: "FS Events",
  },
  launchd: {
    description:
      "macOS Launch daemon - the master process manager that starts and manages all system and user services.",
    category: "system",
    displayName: "launchd",
  },
  mDNSResponder: {
    description:
      "macOS Multicast DNS Responder - handles Bonjour service discovery, local network name resolution, and zero-configuration networking.",
    category: "network",
    displayName: "mDNS Responder",
  },
  mDNSRespon: {
    description:
      "macOS Multicast DNS Responder - handles Bonjour service discovery, local network name resolution, and zero-configuration networking.",
    category: "network",
    displayName: "mDNS Responder",
  },
  netbiosd: {
    description:
      "macOS NetBIOS daemon - provides Windows network compatibility for file sharing and network browsing.",
    category: "network",
    displayName: "NetBIOS Daemon",
  },
  rapportd: {
    description:
      "macOS Rapport daemon - enables device-to-device communication for features like Universal Clipboard, Handoff, and AirDrop.",
    category: "system",
    displayName: "Rapport Daemon",
  },
  sharingd: {
    description:
      "macOS Sharing daemon - manages AirDrop, Handoff, Shared Clipboard, and other device sharing features.",
    category: "system",
    displayName: "Sharing Daemon",
  },
  symptomsd: {
    description:
      "macOS Symptoms daemon - collects network diagnostics and performance data to improve connectivity.",
    category: "system",
    displayName: "Symptoms Daemon",
  },
  UserEventAgent: {
    description:
      "macOS User Event Agent - monitors and responds to user-level system events like display sleep, wake, and login.",
    category: "system",
    displayName: "User Event Agent",
  },
  UserEventAg: {
    description:
      "macOS User Event Agent - monitors and responds to user-level system events like display sleep, wake, and login.",
    category: "system",
    displayName: "User Event Agent",
  },
  WiFiAgent: {
    description:
      "macOS Wi-Fi Agent - manages the Wi-Fi menu bar item and user-facing Wi-Fi controls.",
    category: "network",
    displayName: "Wi-Fi Agent",
  },
  identityservicesd: {
    description:
      "macOS Identity Services daemon - handles iCloud account authentication, iMessage, and FaceTime identity.",
    category: "system",
    displayName: "Identity Services",
  },
  identityse: {
    description:
      "macOS Identity Services daemon - handles iCloud account authentication, iMessage, and FaceTime identity.",
    category: "system",
    displayName: "Identity Services",
  },
  cloudd: {
    description:
      "macOS CloudKit daemon - manages iCloud data synchronization and CloudKit framework operations.",
    category: "system",
    displayName: "CloudKit Daemon",
  },
  nsurlsessiond: {
    description:
      "macOS URL Session daemon - handles background network transfers and downloads for apps.",
    category: "network",
    displayName: "NSURLSession Daemon",
  },
  nsurlsessi: {
    description:
      "macOS URL Session daemon - handles background network transfers and downloads for apps.",
    category: "network",
    displayName: "NSURLSession Daemon",
  },
  apsd: {
    description:
      "macOS Apple Push Services daemon - manages push notifications from Apple services and third-party apps.",
    category: "network",
    displayName: "Apple Push Services",
  },
  locationd: {
    description:
      "macOS Location Services daemon - provides location data to apps and manages location privacy.",
    category: "system",
    displayName: "Location Services",
  },
  coreduetd: {
    description:
      "macOS Core Duet daemon - tracks app usage patterns to improve Siri suggestions and system intelligence.",
    category: "system",
    displayName: "Core Duet",
  },
  suggestd: {
    description:
      "macOS Suggestions daemon - provides intelligent suggestions in Spotlight, Siri, and other system features.",
    category: "system",
    displayName: "Suggestions Daemon",
  },
  tccd: {
    description:
      "macOS Transparency, Consent, and Control daemon - manages privacy permissions for apps accessing sensitive data.",
    category: "system",
    displayName: "TCC Daemon",
  },
  trustd: {
    description:
      "macOS Trust daemon - handles certificate trust evaluation and security policy decisions.",
    category: "system",
    displayName: "Trust Daemon",
  },
  securityd: {
    description:
      "macOS Security daemon - manages keychain access, code signing verification, and security services.",
    category: "system",
    displayName: "Security Daemon",
  },
  WindowServer: {
    description:
      "macOS Window Server - the core process that manages the display, windows, and graphical user interface.",
    category: "system",
    displayName: "Window Server",
  },
  WindowServe: {
    description:
      "macOS Window Server - the core process that manages the display, windows, and graphical user interface.",
    category: "system",
    displayName: "Window Server",
  },
  Finder: {
    description:
      "macOS Finder - the default file manager that provides the desktop and file browsing experience.",
    category: "system",
    displayName: "Finder",
  },
  Dock: {
    description:
      "macOS Dock - provides the application dock, Launchpad, and window management features.",
    category: "system",
    displayName: "Dock",
  },
  SystemUIServer: {
    description:
      "macOS System UI Server - manages menu bar extras, system dialogs, and UI elements.",
    category: "system",
    displayName: "System UI Server",
  },
  SystemUISe: {
    description:
      "macOS System UI Server - manages menu bar extras, system dialogs, and UI elements.",
    category: "system",
    displayName: "System UI Server",
  },
  NotificationCenter: {
    description:
      "macOS Notification Center - displays and manages notifications from apps and system services.",
    category: "system",
    displayName: "Notification Center",
  },
  Notificati: {
    description:
      "macOS Notification Center - displays and manages notifications from apps and system services.",
    category: "system",
    displayName: "Notification Center",
  },
  Spotlight: {
    description:
      "macOS Spotlight - provides system-wide search, app launching, and quick calculations.",
    category: "system",
    displayName: "Spotlight",
  },
  mds: {
    description:
      "macOS Metadata Server - indexes files for Spotlight search and manages file metadata.",
    category: "system",
    displayName: "Metadata Server",
  },
  mds_stores: {
    description: "macOS Metadata Server Stores - manages the Spotlight search index database.",
    category: "system",
    displayName: "Metadata Stores",
  },
  kernel_task: {
    description:
      "macOS Kernel Task - the core operating system process that manages hardware, memory, and system resources.",
    category: "system",
    displayName: "Kernel Task",
  },
};

// ============================================
// App Name Extraction
// ============================================

/**
 * Extract app name from macOS .app bundle paths in a command string.
 * e.g. "/Applications/Slack.app/Contents/..." → "Slack"
 */
function extractAppNameFromCommand(command = "") {
  if (!command) return null;
  const appMatch =
    command.match(/\/Applications\/([^/]+)\.app\//i) ||
    command.match(/\/System\/Applications\/([^/]+)\.app\//i) ||
    command.match(/\/Users\/[^/]+\/Applications\/([^/]+)\.app\//i);
  if (appMatch && appMatch[1]) {
    return appMatch[1];
  }
  return null;
}

// ============================================
// Path Conventions
// ============================================

/**
 * Prefixes that indicate a user home directory path on this platform.
 */
const HOME_DIR_PATH_PREFIXES = ["/Users/", "/home/"];

/**
 * System-installed project roots to exclude from scanning.
 */
const SYSTEM_PROJECT_ROOTS = [
  "/opt/homebrew",
  "/usr/local/homebrew",
  "/usr/local/cellar",
  "/opt/local",
  "/nix/store",
].map((p) => path.resolve(p).toLowerCase());

// ============================================
// Shell Operations
// ============================================

/**
 * Open a terminal window at the given directory path.
 * Returns a Promise<{ success, error? }>.
 */
function openTerminalAtPath(dirPath) {
  return new Promise((resolve) => {
    const child = spawn("open", ["-a", "Terminal", dirPath], {
      detached: true,
      stdio: "ignore",
    });

    child.on("error", (err) => {
      console.error("Error opening terminal:", err);
      resolve({ success: false, error: err.message });
    });

    child.unref();
    setTimeout(() => resolve({ success: true }), 100);
  });
}

/**
 * Open a file in the default system editor.
 * Returns { success, error? }.
 */
function openFileInDefaultApp(filePath) {
  const child = spawn("open", [filePath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return { success: true, editor: "default" };
}

/**
 * Check if VS Code CLI (`code`) is available.
 */
function hasCodeEditor() {
  try {
    execFileSync("which", ["code"], { timeout: 2000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Path validation: check whether a path is within a safe region.
 * On macOS, allows home dir and /tmp.
 */
function isPathAllowedForEditor(resolvedPath) {
  const home = require("os").homedir();
  return resolvedPath.startsWith(home) || resolvedPath.startsWith("/tmp");
}

// ============================================
// Window Options
// ============================================

/**
 * Platform-specific BrowserWindow options.
 */
function getWindowOptions() {
  return {
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 15, y: 15 },
  };
}

/**
 * Set the dock icon (macOS-only).
 */
function setupDockIcon(app, nativeImage, iconPath) {
  const icon = nativeImage.createFromPath(iconPath);
  if (!icon.isEmpty()) {
    app.dock.setIcon(icon);
  }
}

/**
 * Whether the app should quit when all windows are closed.
 * macOS convention: keep running (user re-opens via dock).
 */
function shouldQuitOnAllWindowsClosed() {
  return false;
}

module.exports = {
  // Process monitoring
  getProcessList,
  parseProcessList,
  getProcessInfoByPid,
  killProcess,
  enumeratePids,

  // Port & connection monitoring
  fetchListeningPorts,
  parseListeningPorts,
  fetchEstablishedConnections,
  parseEstablishedConnections,
  fetchProcessOnPort,
  fetchListeningPortNumbers,

  // CWD resolution
  batchResolveCwds,
  resolveCwd,

  // Docker binary paths
  DOCKER_BIN_CANDIDATES,

  // Known system services
  PLATFORM_KNOWN_SERVICES,

  // App name extraction
  extractAppNameFromCommand,

  // Path conventions
  HOME_DIR_PATH_PREFIXES,
  SYSTEM_PROJECT_ROOTS,

  // Shell operations
  openTerminalAtPath,
  openFileInDefaultApp,
  hasCodeEditor,
  isPathAllowedForEditor,

  // Window options
  getWindowOptions,
  setupDockIcon,
  shouldQuitOnAllWindowsClosed,
};
