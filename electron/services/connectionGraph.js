/**
 * Connection Graph Builder — main-thread orchestrator.
 *
 * Pure computation has been extracted to graphFunctions.js (Worker-safe).
 * This file retains:
 *   - I/O-bound operations (CWD lookups via lsof, route scanning, Docker)
 *   - Health tracking (module-level state)
 *   - The backward-compatible buildConnectionGraph() entry point
 *   - Batched CWD collection (batchGetProcessCwds)
 */

const path = require('path');
const platform = require('./platform');
const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections } = require('./portMonitor');
const { scanRoutes, matchRoutesToService } = require('./routeScanner');
const { updateHealthTracking, getHealthStatus } = require('./healthTracker');
const {
  getDockerSnapshot,
  containerHealthToGraphHealth,
} = require('./dockerMonitor');
const {
  categorizeProcess,
  inferProjectFromCommand,
  inferProjectPathFromCommand,
  inferProjectPathFromContainer,
  findProjectRoot,
  findNearestProjectMarkerRoot,
  collectProjectPaths,
  buildGraphStructure,
  overlayMetrics,
  hasTopologyChanged,
} = require('./graphFunctions');

// Performance timing
const PERF_LOGGING = process.env.FERE_PERF_LOG === '1';
const perfLog = (label, duration) => {
  if (PERF_LOGGING) {
    console.log(`[PERF] ${label}: ${duration.toFixed(2)}ms`);
  }
};

// Persistent cache for process CWD (survives across polls)
const CWD_CACHE_TTL_MS = 60000; // 60 seconds
const CWD_NULL_CACHE_TTL_MS = 10000; // Retry missing CWDs sooner
const persistentCwdCache = new Map();

// ============================================
// CWD Lookup (I/O-bound, main thread only)
// ============================================

/**
 * Batch CWD lookup via platform abstraction.
 * Wraps platform.batchResolveCwds with a persistent TTL cache.
 * @param {number[]} pids - Array of process IDs
 * @returns {Promise<Map<number, string|null>>} Map of PID → CWD path
 */
async function batchGetProcessCwds(pids) {
  const now = Date.now();
  const result = new Map();
  const uncached = [];

  // Check persistent cache first
  for (const pid of pids) {
    const entry = persistentCwdCache.get(pid);
    const ttl = entry?.cwd ? CWD_CACHE_TTL_MS : CWD_NULL_CACHE_TTL_MS;
    if (entry && now - entry.timestamp < ttl) {
      result.set(pid, entry.cwd);
    } else {
      uncached.push(pid);
    }
  }

  if (uncached.length > 0) {
    const startCwd = Date.now();
    const resolved = await platform.batchResolveCwds(uncached);

    for (const pid of uncached) {
      const cwd = resolved.get(pid) || null;
      result.set(pid, cwd);
      persistentCwdCache.set(pid, { cwd, timestamp: now });
    }
    perfLog(`Batched CWD lookups (${uncached.length} uncached of ${pids.length} total)`, Date.now() - startCwd);
  }

  return result;
}

/**
 * Single-PID CWD lookup (backward compat for attachRoutesToNodes).
 */
async function getProcessCwd(pid, cache) {
  if (cache.has(pid)) return cache.get(pid);

  const persistentEntry = persistentCwdCache.get(pid);
  const ttl = persistentEntry?.cwd ? CWD_CACHE_TTL_MS : CWD_NULL_CACHE_TTL_MS;
  if (persistentEntry && Date.now() - persistentEntry.timestamp < ttl) {
    cache.set(pid, persistentEntry.cwd);
    return persistentEntry.cwd;
  }

  const cwd = await platform.resolveCwd(pid);
  cache.set(pid, cwd);
  persistentCwdCache.set(pid, { cwd, timestamp: Date.now() });
  return cwd;
}

// ============================================
// Route Collection (I/O-bound, main thread)
// ============================================

/**
 * Collect routes for a set of project paths.
 * @param {Set<string>} projectPaths - Unique project directory paths to scan
 * @returns {Promise<Object>} Map of projectPath → routes[]
 */
async function collectRoutes(projectPaths) {
  const routesByProject = {};
  if (projectPaths.size === 0) return routesByProject;

  const projects = projectPaths;

  const startScan = Date.now();
  const scanPromises = Array.from(projects).map(async (projectPath) => {
    try {
      const routes = await scanRoutes(projectPath);
      return { projectPath, routes };
    } catch (error) {
      return { projectPath, routes: [] };
    }
  });

  const scanResults = await Promise.all(scanPromises);
  for (const { projectPath, routes } of scanResults) {
    routesByProject[projectPath] = routes;
  }
  perfLog(`Route scanning (${projects.size} projects)`, Date.now() - startScan);

  return routesByProject;
}

// ============================================
// Health Collection (main thread state)
// ============================================

/**
 * Compute health status for all PIDs from the health tracker.
 * @param {Array} processes
 * @param {Array} ports
 * @param {Array} connections
 * @returns {Object} Map of pid → {healthStatus, lastSeen}
 */
function collectHealthByPid(processes, ports, connections) {
  updateHealthTracking({ processes, ports, connections });

  const pidsWithConnections = new Set();
  for (const conn of connections) {
    pidsWithConnections.add(conn.pid);
  }

  const listeningPids = new Set(ports.map(p => p.pid));
  const healthByPid = {};

  // Compute health for all processes
  for (const proc of processes) {
    const isListening = listeningPids.has(proc.pid);
    const hasConnections = pidsWithConnections.has(proc.pid);
    healthByPid[proc.pid] = getHealthStatus(proc.pid, isListening, hasConnections, proc);
  }

  // Also compute for port-owning PIDs not in process list
  for (const port of ports) {
    if (!healthByPid[port.pid]) {
      healthByPid[port.pid] = getHealthStatus(port.pid, true, pidsWithConnections.has(port.pid));
    }
  }

  return healthByPid;
}

// ============================================
// Legacy Route Attachment (used by buildConnectionGraph)
// ============================================
async function attachRoutesToNodes(nodes) {
  const startRoutes = Date.now();
  const projects = new Map();
  const cwdByPid = new Map();

  for (const node of nodes) {
    if (node.projectPath) {
      projects.set(node.projectPath, null);
      if (!node.project) {
        node.project = path.basename(node.projectPath);
      }
    }
  }

  const startCwd = Date.now();
  let cwdLookupCount = 0;
  for (const node of nodes) {
    if (node.pid <= 0) continue;
    cwdLookupCount++;
    const cwd = await getProcessCwd(node.pid, cwdByPid);
    if (!cwd) continue;
    // repoPath = enclosing git root — drives "repo" tab grouping in the UI
    const repoRoot = findProjectRoot(cwd);
    if (!repoRoot) continue;
    // projectPath = nearest manifest root — drives "subproject" tabs + route scanning
    // Falls back to the git root when no manifest file is found above the CWD.
    const projectRoot = findNearestProjectMarkerRoot(cwd) || repoRoot;

    node.projectPath = projectRoot;
    node.repoPath = repoRoot;
    node.project = path.basename(projectRoot);
    projects.set(projectRoot, null);
  }
  perfLog(`CWD lookups (${cwdLookupCount} processes)`, Date.now() - startCwd);

  const startScan = Date.now();
  const scanPromises = Array.from(projects.keys()).map(async (projectPath) => {
    try {
      const routes = await scanRoutes(projectPath);
      return { projectPath, routes };
    } catch (error) {
      return { projectPath, routes: [] };
    }
  });

  const scanResults = await Promise.all(scanPromises);
  for (const { projectPath, routes } of scanResults) {
    projects.set(projectPath, routes);
  }
  perfLog(`Route scanning (${projects.size} projects)`, Date.now() - startScan);

  for (const node of nodes) {
    if (!node.projectPath) continue;
    const routes = projects.get(node.projectPath) || [];
    node.routes = matchRoutesToService(routes, node);
  }

  for (const node of nodes) {
    if (!node.projectPath) {
      node.project = null;
    }
  }

  perfLog('Total route attachment', Date.now() - startRoutes);
}

// ============================================
// Main Entry Point (backward-compatible)
// ============================================

/**
 * Build a complete picture of the local dev environment.
 * This is the legacy entry point — still used by getEnvironmentSummary()
 * and as fallback when the Worker path is not available.
 *
 * The scheduler's Worker path uses buildGraphStructure() directly.
 */
async function buildConnectionGraph(snapshot = null) {
  const startTotal = Date.now();

  const processes = snapshot?.processes || await getDevProcesses();
  const ports = snapshot?.ports || await getListeningPorts();
  const connections = snapshot?.connections || await getEstablishedConnections();

  // Collect health on main thread
  const healthByPid = collectHealthByPid(processes, ports, connections);

  // Batch CWD lookups
  const pids = processes.filter(p => p.pid > 0).map(p => p.pid);
  const cwdMap = await batchGetProcessCwds(pids);

  const cwdMapObj = Object.fromEntries(cwdMap);

  // Fetch Docker snapshot, then discover project paths and scan routes
  const startParallel = Date.now();
  const dockerSnapshot = await getDockerSnapshot();
  const projectPaths = collectProjectPaths({
    processes, ports, cwdMap: cwdMapObj, dockerSnapshot,
  });
  const routesByProject = await collectRoutes(projectPaths);
  perfLog('Parallel operations (docker + routes)', Date.now() - startParallel);

  // Single graph build with all data
  const result = buildGraphStructure({
    processes, ports, connections,
    cwdMap: cwdMapObj,
    dockerSnapshot,
    routesByProject,
    healthByPid,
    containerHealthToGraphHealth,
    projectPaths: [...projectPaths],
  });

  perfLog('Total buildConnectionGraph', Date.now() - startTotal);
  return result;
}

/**
 * Get a simplified summary of the dev environment
 */
async function getEnvironmentSummary() {
  const { nodes, edges } = await buildConnectionGraph();

  return {
    totalServices: nodes.length,
    totalConnections: edges.length,
    services: nodes.map(n => ({
      name: n.name,
      ports: n.ports.map(p => p.port),
      type: n.type,
    })),
    portRange: (() => {
      const allPorts = nodes.flatMap(n => n.ports.map(p => p.port));
      if (allPorts.length === 0) return null;
      return { min: Math.min(...allPorts), max: Math.max(...allPorts) };
    })(),
  };
}

module.exports = {
  buildConnectionGraph,
  getEnvironmentSummary,
  categorizeProcess,
  inferProjectFromCommand,
  inferProjectPathFromCommand,
  // New exports for scheduler integration
  batchGetProcessCwds,
  collectHealthByPid,
  collectRoutes,
};
