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
    portToPid.set(port.port, port.pid);
    if (!portProcessByPid.has(port.pid)) {
      portProcessByPid.set(port.pid, port.process);
      portUserByPid.set(port.pid, port.user);
    }
  }

  // Second pass: create nodes, but only one node per unique port number
  for (const port of ports) {
    // Skip if we've already processed this port number (deduplicate)
    if (seenPorts.has(port.port)) continue;
    seenPorts.add(port.port);

    const node = ensureProcessNode(port.pid, port.process);
    node.ports.push({
      port: port.port,
      host: port.host,
      description: getPortDescription(port.port),
    });
  }

  // Build edges from established connections
  const edges = [];
  const edgeSet = new Set(); // Prevent duplicate edges
  const externalNodes = new Map();

  const getExternalNode = (host, port) => {
    const key = `${host}:${port}`;
    if (externalNodes.has(key)) {
      return externalNodes.get(key);
    }

    // External nodes are always yellow (we can't track their health)
    const { healthStatus, lastSeen } = getHealthStatus(-1, true, true);

    const node = {
      id: `external-${host}:${port}`,
      pid: -1,
      name: key,
      command: key,
      type: 'external',
      cpu: 0,
      memory: 0,
      user: 'external',
      tty: null,
      project: null,
      projectPath: null,
      ports: [{
        port,
        host,
        description: null,
      }],
      routes: [],
      healthStatus,
      lastSeen,
    };

    nodes.push(node);
    externalNodes.set(key, node);
    return node;
  };

  for (const conn of connections) {
    const sourceProc = processMap.get(conn.pid);
    if (!sourceProc) continue;

    const sourceNode = ensureProcessNode(conn.pid, conn.process);
    const targetPid = isLocalHost(conn.remoteHost) ? portToPid.get(conn.remotePort) : null;
    const targetNode = targetPid
      ? ensureProcessNode(targetPid, conn.process)
      : getExternalNode(conn.remoteHost, conn.remotePort);

    if (sourceNode.id === targetNode.id) continue;

    let confidence = 0.6;
    if (targetPid) {
      confidence = 0.9;
    } else if (isLocalHost(conn.remoteHost)) {
      confidence = 0.5;
    }

    const edgeKey = `${sourceNode.id}->${targetNode.id}:${conn.remotePort}`;
    if (!edgeSet.has(edgeKey)) {
      edgeSet.add(edgeKey);
      edges.push({
        id: edgeKey,
        source: sourceNode.id,
        target: targetNode.id,
        sourcePort: conn.localPort,
        targetPort: conn.remotePort,
        protocol: conn.protocol,
        confidence,
      });
    }
  }

  // OPTIMIZATION: Parallelize route attachment and Docker snapshot
  // These operations are independent and can run concurrently
  const startParallel = Date.now();
  const [dockerSnapshot] = await Promise.all([
    getDockerSnapshot(),
    attachRoutesToNodes(nodes),
  ]);
  perfLog('Parallel operations (routes + docker)', Date.now() - startParallel);

  // Add Docker containers as nodes
  if (dockerSnapshot.isAvailable && dockerSnapshot.containers.length > 0) {
    const startDocker = Date.now();
    addDockerContainerNodes(nodes, edges, dockerSnapshot, nodesByPid, portToPid);
    perfLog('Add Docker container nodes', Date.now() - startDocker);
  }

  return { nodes, edges, dockerSnapshot };
}

/**
 * Categorize a process into a type for visualization
 */
function categorizeProcess(processName, command = '') {
  const name = processName.toLowerCase();
  const cmd = command.toLowerCase();

  if (cmd.includes('postgres-client-mock')) {
    return 'database';
  }
  if (cmd.includes('broker-mock') || cmd.includes('nats')) {
    return 'broker';
  }
  if (cmd.includes('ws-server-mock')) {
    return 'realtime';
  }
  if (cmd.includes('ws-client-mock')) {
    return 'client';
  }
  if (cmd.includes('http-client-mock')) {
    return 'client';
  }
  if (cmd.includes('worker-mock')) {
    return 'worker';
  }

  // Databases
  if (name.includes('postgres') || name.includes('psql') || cmd.includes('postgres')) {
    return 'database';
  }
  if (name.includes('mysql') || cmd.includes('mysql')) {
    return 'database';
  }
  if (name.includes('mongo') || cmd.includes('mongo')) {
    return 'database';
  }
  if (name.includes('redis') || cmd.includes('redis')) {
    return 'cache';
  }

  // Web servers
  if (name.includes('nginx') || name.includes('apache') || name.includes('httpd')) {
    return 'webserver';
  }

  // Containers
  if (name.includes('docker') || name.includes('podman')) {
    return 'container';
  }

  // Frontend dev servers
  if (cmd.includes('webpack') || cmd.includes('vite') || cmd.includes('next') ||
      cmd.includes('react-scripts') || cmd.includes('parcel')) {
    return 'frontend';
  }

  // Backend frameworks
  if (cmd.includes('uvicorn') || cmd.includes('gunicorn') || cmd.includes('flask') ||
      cmd.includes('django') || cmd.includes('fastapi')) {
    return 'backend';
  }
  if (cmd.includes('express') || cmd.includes('nestjs') || cmd.includes('fastify')) {
    return 'backend';
  }

  // Node.js generic
  if (name.includes('node')) {
    return 'nodejs';
  }

  // Python generic
  if (name.includes('python')) {
    return 'python';
  }

  return 'service';
}

function isLocalHost(host = '') {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::'
  );
}

function inferProjectFromCommand(command = '') {
  const match = command.match(/\/Users\/[^/\s]+\/[^/\s]+/);
  if (match) {
    return match[0].split('/').pop();
  }

  const homeMatch = command.match(/\/home\/[^/\s]+\/[^/\s]+/);
  if (homeMatch) {
    return homeMatch[0].split('/').pop();
  }

  return null;
}

const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'Makefile',
];

function findProjectRoot(startPath) {
  let current = startPath;
  if (!current) return null;

  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      current = path.dirname(current);
    }
  } catch (error) {
    return null;
  }

  // Prefer the closest git root if present.
  let probe = current;
  let probePrev = null;
  while (probe && probe !== probePrev) {
    if (fs.existsSync(path.join(probe, '.git'))) {
      return probe;
    }
    probePrev = probe;
    probe = path.dirname(probe);
  }

  let previous = null;
  while (current && current !== previous) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    previous = current;
    current = path.dirname(current);
  }

  return null;
}

function inferProjectPathFromCommand(command = '') {
  const tokens = command.split(/\s+/);
  const candidates = [];

  for (const token of tokens) {
    if (token.startsWith('/Users/') || token.startsWith('/home/')) {
      const cleaned = token.replace(/[",']/g, '');
      candidates.push(cleaned);
    }
  }

  for (const candidate of candidates) {
    const projectRoot = findProjectRoot(candidate);
    if (projectRoot) {
      return projectRoot;
    }
  }

  return null;
}

/**
 * Add Docker containers as graph nodes and create edges for container networking
 */
function addDockerContainerNodes(nodes, edges, dockerSnapshot, nodesByPid, portToPid) {
  const runningContainers = (dockerSnapshot.containers || []).filter(
    (container) => container.state === 'running',
  );
  const runningContainerIds = new Set(runningContainers.map((container) => container.id));
  const containerConnections = (dockerSnapshot.containerConnections || []).filter(
    (conn) =>
      runningContainerIds.has(conn.sourceContainerId) &&
      runningContainerIds.has(conn.targetContainerId),
  );
  const containerNodesById = new Map();

  // Create nodes for each Docker container
  for (const container of runningContainers) {
    const nodeId = `docker-${container.id}`;

    // Check if we should merge with an existing node (e.g., if container has a mapped port
    // that matches a native process port - unlikely but possible with port forwarding)
    const existingNode = findMatchingNativeNode(container, nodes);
    if (existingNode) {
      // Enhance existing node with Docker info
      enhanceNodeWithDockerInfo(existingNode, container);
      containerNodesById.set(container.id, existingNode);
      continue;
    }

    // Convert container ports to graph port format
    const graphPorts = container.ports
      .filter(p => p.hostPort) // Only show mapped ports
      .map(p => ({
        port: p.hostPort,
        host: p.hostIp || '0.0.0.0',
        description: `Container port ${p.containerPort}/${p.protocol}`,
      }));

    // Determine node type based on container image
    const nodeType = categorizeContainerImage(container.image);

    // Create the Docker container node
    // Infer projectPath from Docker Compose labels or bind mounts
    const containerProjectPath = inferProjectPathFromContainer(container);
    const containerProject = containerProjectPath
      ? path.basename(containerProjectPath)
      : extractProjectFromContainerName(container.name);

    const node = {
      id: nodeId,
      pid: -1, // Docker containers don't have a direct PID in host context
      name: container.name,
      command: `docker: ${container.image}`,
      type: nodeType,
      cpu: container.cpu || 0,
      memory: container.memory || 0,
      user: 'docker',
      tty: null,
      project: containerProject,
      projectPath: containerProjectPath,
      description: `Docker container running ${container.image}`,
      ports: graphPorts,
      routes: [],
      healthStatus: containerHealthToGraphHealth(container),
      lastSeen: Date.now(),
      // Docker-specific properties
      isDockerContainer: true,
      containerId: container.id,
      containerImage: container.image,
      containerState: container.state,
      containerStatus: container.status,
      containerHealth: container.health,
      containerNetworks: container.networks,
      containerMounts: container.mounts,
      containerPorts: container.ports,
      memoryUsage: container.memoryUsage,
    };

    nodes.push(node);
    containerNodesById.set(container.id, node);

    // Register mapped ports so native processes can connect to containers
    for (const port of container.ports) {
      if (port.hostPort) {
        portToPid.set(port.hostPort, nodeId);
      }
    }
  }

  // Create edges for container-to-container connections (shared networks)
  const edgeSet = new Set(edges.map(e => e.id));
  for (const conn of containerConnections) {
    const sourceNode = containerNodesById.get(conn.sourceContainerId);
    const targetNode = containerNodesById.get(conn.targetContainerId);

    if (!sourceNode || !targetNode) continue;

    const edgeId = `docker-network-${conn.sourceContainerId.substring(0, 12)}-${conn.targetContainerId.substring(0, 12)}`;
    if (edgeSet.has(edgeId)) continue;

    edgeSet.add(edgeId);
    edges.push({
      id: edgeId,
      source: sourceNode.id,
      target: targetNode.id,
      sourcePort: 0, // Network-level connection, no specific port
      targetPort: 0,
      protocol: `docker-network:${conn.networkName}`,
      confidence: 0.8,
    });
  }
}

/**
 * Find a native process node that might correspond to a Docker container
 * (e.g., if they're using the same mapped port)
 */
function findMatchingNativeNode(container, nodes) {
  // Look for a node that has the same mapped port
  for (const port of container.ports) {
    if (port.hostPort) {
      const matchingNode = nodes.find(n =>
        !n.isDockerContainer &&
        n.ports.some(p => p.port === port.hostPort)
      );
      if (matchingNode) return matchingNode;
    }
  }
  return null;
}

/**
 * Enhance an existing native node with Docker container information
 */
function enhanceNodeWithDockerInfo(node, container) {
  node.isDockerContainer = true;
  node.containerId = container.id;
  node.containerImage = container.image;
  node.containerState = container.state;
  node.containerStatus = container.status;
  node.containerHealth = container.health;
  node.containerNetworks = container.networks;
  node.containerMounts = container.mounts;
  node.containerPorts = container.ports;
  node.memoryUsage = container.memoryUsage;
  // Update description
  node.description = `Docker container: ${container.image}`;
}

/**
 * Categorize container image into a node type
 */
function categorizeContainerImage(image) {
  const imageLower = image.toLowerCase();

  // Databases
  if (imageLower.includes('postgres') || imageLower.includes('pg')) return 'database';
  if (imageLower.includes('mysql') || imageLower.includes('mariadb')) return 'database';
  if (imageLower.includes('mongo')) return 'database';
  if (imageLower.includes('sqlite')) return 'database';

  // Cache/Memory stores
  if (imageLower.includes('redis')) return 'cache';
  if (imageLower.includes('memcached')) return 'cache';

  // Message brokers
  if (imageLower.includes('rabbitmq')) return 'broker';
  if (imageLower.includes('kafka')) return 'broker';
  if (imageLower.includes('nats')) return 'broker';

  // Web servers
  if (imageLower.includes('nginx')) return 'webserver';
  if (imageLower.includes('apache') || imageLower.includes('httpd')) return 'webserver';
  if (imageLower.includes('traefik')) return 'webserver';
  if (imageLower.includes('haproxy')) return 'webserver';

  // Frontend
  if (imageLower.includes('node') && (imageLower.includes('react') || imageLower.includes('vue') || imageLower.includes('angular'))) {
    return 'frontend';
  }

  // Python backends
  if (imageLower.includes('python') || imageLower.includes('django') || imageLower.includes('flask') || imageLower.includes('fastapi')) {
    return 'backend';
  }

  // Node backends
  if (imageLower.includes('node') || imageLower.includes('express') || imageLower.includes('nestjs')) {
    return 'nodejs';
  }

  // Workers
  if (imageLower.includes('worker') || imageLower.includes('celery') || imageLower.includes('sidekiq')) {
    return 'worker';
  }

  // Default to container type
  return 'container';
}

/**
 * Extract project name from container name (e.g., "myproject_web_1" -> "myproject")
 */
function extractProjectFromContainerName(containerName) {
  // Docker Compose naming: project_service_number
  const composeMatch = containerName.match(/^([^_]+)_[^_]+_\d+$/);
  if (composeMatch) return composeMatch[1];

  // Try to extract meaningful project name from container name
  const cleanName = containerName.replace(/^\//, ''); // Remove leading slash
  const parts = cleanName.split(/[-_]/);
  if (parts.length > 1) {
    return parts[0];
  }

  return null;
}

/**
 * Infer projectPath from Docker container labels (Docker Compose) or bind mounts
 */
function inferProjectPathFromContainer(container) {
  // First, check Docker Compose labels - this is the most reliable source
  if (container.labels) {
    // Docker Compose v2 uses this label for the working directory
    const workingDir = container.labels['com.docker.compose.project.working_dir'];
    if (workingDir) {
      const projectRoot = findProjectRoot(workingDir);
      if (projectRoot) {
        return projectRoot;
      }
      // If no project markers found, use the working dir itself
      return workingDir;
    }
  }

  // Fallback: check bind mounts for project directories
  if (container.mounts && Array.isArray(container.mounts)) {
    for (const mount of container.mounts) {
      if (mount.type === 'bind' && mount.source) {
        const projectRoot = findProjectRoot(mount.source);
        if (projectRoot) {
          return projectRoot;
        }
      }
    }
  }

  return null;
}

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
