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
const { exec } = require('child_process');
const { promisify } = require('util');
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
  findProjectRoot,
  buildGraphStructure,
  overlayMetrics,
  hasTopologyChanged,
} = require('./graphFunctions');

const execAsync = promisify(exec);

// Performance timing
const PERF_LOGGING = process.env.FERE_PERF_LOG === '1';
const perfLog = (label, duration) => {
  if (PERF_LOGGING) {
    console.log(`[PERF] ${label}: ${duration.toFixed(2)}ms`);
  }
};

// Persistent cache for process CWD (survives across polls)
const CWD_CACHE_TTL_MS = 60000; // 60 seconds
const persistentCwdCache = new Map();

// ============================================
// CWD Lookup (I/O-bound, main thread only)
// ============================================

/**
 * Batch CWD lookup — single lsof call for all PIDs.
 * Reduces N lsof spawns to 1.
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
    if (entry && now - entry.timestamp < CWD_CACHE_TTL_MS) {
      result.set(pid, entry.cwd);
    } else {
      uncached.push(pid);
    }
  }

  if (uncached.length > 0) {
    const startCwd = Date.now();
    try {
      // Single batched lsof call for all uncached PIDs
      const pidArgs = uncached.map(p => `-p ${p}`).join(' ');
      const { stdout } = await execAsync(`lsof -a -d cwd -Fn ${pidArgs} 2>/dev/null`);

      // Parse lsof output: lines alternate between 'p<pid>' and 'n<path>'
      let currentPid = null;
      for (const line of stdout.split('\n')) {
        if (line.startsWith('p')) {
          currentPid = parseInt(line.slice(1), 10);
        } else if (line.startsWith('n') && currentPid !== null) {
          const cwd = line.slice(1).trim();
          result.set(currentPid, cwd);
          persistentCwdCache.set(currentPid, { cwd, timestamp: now });
          currentPid = null;
        }
      }

      // Mark PIDs not found in output as null
      for (const pid of uncached) {
        if (!result.has(pid)) {
          result.set(pid, null);
          persistentCwdCache.set(pid, { cwd: null, timestamp: now });
        }
      }
    } catch (error) {
      // lsof returns exit code 1 when no results, or pids may be gone
      for (const pid of uncached) {
        if (!result.has(pid)) {
          result.set(pid, null);
          persistentCwdCache.set(pid, { cwd: null, timestamp: now });
        }
      }
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
  if (persistentEntry && Date.now() - persistentEntry.timestamp < CWD_CACHE_TTL_MS) {
    cache.set(pid, persistentEntry.cwd);
    return persistentEntry.cwd;
  }

  try {
    const { stdout } = await execAsync(`lsof -a -p ${pid} -d cwd -Fn`);
    const line = stdout.split('\n').find(entry => entry.startsWith('n'));
    const cwd = line ? line.slice(1).trim() : null;
    cache.set(pid, cwd);
    persistentCwdCache.set(pid, { cwd, timestamp: Date.now() });
    return cwd;
  } catch (error) {
    cache.set(pid, null);
    persistentCwdCache.set(pid, { cwd: null, timestamp: Date.now() });
    return null;
  }
}

// ============================================
// Route Collection (I/O-bound, main thread)
// ============================================

/**
 * Collect routes for all project paths found in nodes.
 * @param {Array} nodes - Graph nodes with projectPath
 * @returns {Promise<Object>} Map of projectPath → routes[]
 */
async function collectRoutes(nodes) {
  const projects = new Set();
  for (const node of nodes) {
    if (node.projectPath) projects.add(node.projectPath);
  }

  const routesByProject = {};
  if (projects.size === 0) return routesByProject;

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
    healthByPid[proc.pid] = getHealthStatus(proc.pid, isListening, hasConnections);
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
    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) continue;

    if (node.projectPath !== projectRoot) {
      node.projectPath = projectRoot;
    }
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

  // Fetch Docker + routes in parallel
  const startParallel = Date.now();
  const [dockerSnapshot, routesByProject] = await Promise.all([
    getDockerSnapshot(),
    (async () => {
      // Build preliminary nodes to discover project paths for route scanning
      const prelimResult = buildGraphStructure({
        processes, ports, connections,
        cwdMap: Object.fromEntries(cwdMap),
        dockerSnapshot: null,
        routesByProject: {},
        healthByPid,
        containerHealthToGraphHealth,
      });
      return collectRoutes(prelimResult.nodes);
    })(),
  ]);
  perfLog('Parallel operations (docker + routes)', Date.now() - startParallel);

  // Full structure build with all data
  const result = buildGraphStructure({
    processes, ports, connections,
    cwdMap: Object.fromEntries(cwdMap),
    dockerSnapshot,
    routesByProject,
    healthByPid,
    containerHealthToGraphHealth,
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
    portRange: nodes.length > 0 ? {
      min: Math.min(...nodes.flatMap(n => n.ports.map(p => p.port))),
      max: Math.max(...nodes.flatMap(n => n.ports.map(p => p.port))),
    } : null,
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
