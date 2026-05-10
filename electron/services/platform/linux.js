/**
 * Linux platform implementation.
 *
 * This is intentionally "good enough" for CI/unit tests and headless usage.
 * It provides the same public surface as the darwin/win32 implementations,
 * but uses Linux-friendly primitives (/proc, ps, lsof/ss where available).
 */

const { exec, execFile } = require("child_process");
const { promisify } = require("util");
const fs = require("fs");
const os = require("os");
const path = require("path");

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================
// Shared constants (used by graph code)
// ============================================

const DOCKER_BIN_CANDIDATES = [
  "docker",
  "/usr/bin/docker",
  "/usr/local/bin/docker",
  "/snap/bin/docker",
];

const HOME_DIR_PATH_PREFIXES = ["/Users/", "/home/"];

const SYSTEM_PROJECT_ROOTS = [
  "/Applications",
  "/System/Applications",
  "/System/Library",
  "/Library",
  "/usr",
  "/bin",
  "/sbin",
  "/opt",
  "/var",
];

// Keep this lightweight on Linux; graphFunctions overlays COMMON_KNOWN_SERVICES anyway.
const PLATFORM_KNOWN_SERVICES = {};

// ============================================
// Process Monitoring
// ============================================

async function getProcessList() {
  const { stdout } = await execAsync("ps aux", { maxBuffer: 10 * 1024 * 1024 });
  return parseProcessList(stdout);
}

function parseProcessList(psOutput) {
  const lines = String(psOutput || "").trim().split("\n");
  const processes = [];
  if (lines.length <= 1) return processes;

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

async function getProcessInfoByPid(pid) {
  try {
    const { stdout } = await execFileAsync("ps", [
      "-p",
      String(pid),
      "-o",
      "user,pid,%cpu,%mem,vsz,rss,tty,stat,lstart,time,command",
    ]);
    const processes = parseProcessList(stdout);
    return processes[0] || null;
  } catch {
    return null;
  }
}

async function enumeratePids() {
  try {
    const { stdout } = await execAsync("ps -eo pid", { maxBuffer: 1024 * 1024 });
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

async function killProcess(pid, signal = "TERM") {
  const ALLOWED_SIGNALS = new Set(["TERM", "KILL", "INT", "HUP", "QUIT"]);
  const safeSignal = ALLOWED_SIGNALS.has(signal) ? signal : "TERM";
  const pidStr = String(pid);

  try {
    await execFileAsync("kill", [`-${safeSignal}`, pidStr]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      await execFileAsync("kill", ["-0", pidStr]);
      await execFileAsync("kill", ["-KILL", pidStr]);
    } catch {
      // already exited
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================
// CWD resolution
// ============================================

async function resolveCwd(pid) {
  const procCwd = `/proc/${pid}/cwd`;
  try {
    return await fs.promises.readlink(procCwd);
  } catch {
    return null;
  }
}

async function batchResolveCwds(pids) {
  const list = Array.isArray(pids) ? pids : [];
  const results = await Promise.all(list.map((pid) => resolveCwd(pid)));
  const map = new Map();
  for (let i = 0; i < list.length; i++) map.set(list[i], results[i]);
  return map;
}

// ============================================
// Ports / connections (best-effort)
// ============================================

const LSOF_LINE_RE = /^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/;
const NORMALIZE_SUFFIX_RE = /\s+\(.*\)$/;
const NORMALIZE_PREFIX_RE = /^TCP\s+/;
const HOST_PORT_RE = /:(\d+)$/;

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

async function fetchListeningPorts() {
  try {
    const { stdout } = await execAsync("lsof -nP -iTCP -sTCP:LISTEN", {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 10000,
    });
    return parseListeningPorts(stdout);
  } catch {
    return [];
  }
}

function parseListeningPorts(lsofOutput) {
  const lines = String(lsofOutput || "").trim().split("\n");
  if (lines.length <= 1) return [];

  const ports = [];
  for (let i = 1; i < lines.length; i++) {
    const parsed = parseLsofLine(lines[i]);
    if (!parsed) continue;
    const name = normalizeName(parsed.name);
    const parts = name.split("->")[0].trim();
    const hostPort = parseHostPort(parts.split(" ")[0]);
    if (!hostPort) continue;

    ports.push({
      port: hostPort.port,
      host: hostPort.host,
      pid: parseInt(parsed.pid, 10),
      process: parsed.command,
      user: parsed.user,
      protocol: "tcp",
      fd: parsed.fd,
    });
  }
  return ports;
}

async function fetchListeningPortNumbers() {
  const ports = await fetchListeningPorts();
  return [...new Set(ports.map((p) => p.port))];
}

async function fetchProcessOnPort(port) {
  const ports = await fetchListeningPorts();
  return ports.find((p) => p.port === port) || null;
}

async function fetchEstablishedConnections() {
  // Not currently needed for CI; return an empty list rather than failing.
  return [];
}

function parseEstablishedConnections() {
  return [];
}

// ============================================
// App/name helpers & UI stubs
// ============================================

function extractAppNameFromCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return "";
  const first = cmd.split(/\s+/)[0];
  return path.basename(first);
}

function openTerminalAtPath() {
  return { success: false, error: "Not supported on linux in headless mode" };
}

function openFileInDefaultApp(filePath) {
  const target = String(filePath || "").trim();
  if (!target) return { success: false, error: "No path provided" };
  // Best effort: xdg-open if available.
  execFile("xdg-open", [target], () => {});
  return { success: true };
}

function getWindowOptions() {
  return {};
}

function shouldQuitOnAllWindowsClosed() {
  return false;
}

function setupDockIcon() {}

function hasCodeEditor() {
  return false;
}

function isPathAllowedForEditor() {
  return false;
}

module.exports = {
  // Process
  getProcessList,
  parseProcessList,
  getProcessInfoByPid,
  enumeratePids,
  killProcess,

  // Ports / network
  fetchListeningPorts,
  parseListeningPorts,
  fetchListeningPortNumbers,
  fetchProcessOnPort,
  fetchEstablishedConnections,
  parseEstablishedConnections,

  // CWD
  resolveCwd,
  batchResolveCwds,

  // Helpers / UI
  extractAppNameFromCommand,
  openTerminalAtPath,
  openFileInDefaultApp,
  getWindowOptions,
  shouldQuitOnAllWindowsClosed,
  setupDockIcon,
  hasCodeEditor,
  isPathAllowedForEditor,

  // Constants
  DOCKER_BIN_CANDIDATES,
  PLATFORM_KNOWN_SERVICES,
  HOME_DIR_PATH_PREFIXES,
  SYSTEM_PROJECT_ROOTS,
};

