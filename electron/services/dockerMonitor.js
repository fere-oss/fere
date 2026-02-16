const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 2000; // 2 second cache for Docker data (Docker commands are slower)
const containersCache = { timestamp: 0, data: [], promise: null };
const networksCache = { timestamp: 0, data: [], promise: null };
const DOCKER_EXEC_TIMEOUT_MS = 15000;
const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  'docker',
].filter(Boolean);
let resolvedDockerBin = null;

function getDockerBinaries() {
  const bins = [];
  for (const bin of DOCKER_BIN_CANDIDATES) {
    if (bin.includes('/') && !fs.existsSync(bin)) continue;
    bins.push(bin);
  }
  return bins.length > 0 ? bins : ['docker'];
}

async function resolveDockerBinary() {
  if (resolvedDockerBin) return resolvedDockerBin;

  const candidates = getDockerBinaries();
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['version', '--format', '{{.Client.Version}}'], {
        timeout: DOCKER_EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      resolvedDockerBin = candidate;
      return candidate;
    } catch (error) {
      // Try next candidate
    }
  }

  resolvedDockerBin = null;
  return null;
}

async function runDocker(args, options = {}) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const allowFailure = !!options.allowFailure;
  const preferred = await resolveDockerBinary();
  const candidates = preferred
    ? [preferred, ...getDockerBinaries().filter((bin) => bin !== preferred)]
    : getDockerBinaries();

  let lastError = null;
  for (const bin of candidates) {
    try {
      const result = await execFileAsync(bin, normalizedArgs, {
        timeout: DOCKER_EXEC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      resolvedDockerBin = bin;
      return result.stdout || '';
    } catch (error) {
      lastError = error;
      const isMissingBinary = error?.code === 'ENOENT' || /not found/i.test(String(error?.message || ''));
      if (isMissingBinary) continue;
      if (allowFailure) {
        throw error;
      }
      throw error;
    }
  }

  if (allowFailure && lastError) {
    throw lastError;
  }
  throw new Error('Docker CLI not found. Tried: ' + candidates.join(', '));
}

/**
 * Check if Docker is available and running
 */
async function isDockerAvailable() {
  try {
    await runDocker(['info'], { allowFailure: true });
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Parse docker ps output with JSON format for reliable parsing
 * Uses: docker ps --format '{{json .}}'
 */
async function getDockerContainers() {
  const now = Date.now();
  if (containersCache.data.length && now - containersCache.timestamp < CACHE_TTL_MS) {
    return containersCache.data;
  }
  if (containersCache.promise) {
    return containersCache.promise;
  }

  containersCache.promise = (async () => {
    try {
      // Check if Docker is available first
      if (!(await isDockerAvailable())) {
        containersCache.data = [];
        containersCache.timestamp = Date.now();
        containersCache.promise = null;
        return [];
      }

      // Get container list with JSON output for reliable parsing
      const stdout = await runDocker(['ps', '-a', '--format', '{{json .}}']);

      if (!stdout.trim()) {
        containersCache.data = [];
        containersCache.timestamp = Date.now();
        containersCache.promise = null;
        return [];
      }

      const containers = [];
      const lines = stdout.trim().split('\n');

      for (const line of lines) {
        try {
          const container = JSON.parse(line);

          // Get detailed inspect data for this container
          const inspectData = await inspectContainer(container.ID);

          containers.push({
            id: container.ID,
            name: container.Names,
            image: container.Image,
            command: container.Command,
            fullCommand: buildFullCommand(inspectData, container.Command),
            created: container.CreatedAt,
            status: container.Status,
            state: container.State, // running, exited, paused, etc.
            ports: parsePorts(container.Ports),
            networks: parseNetworks(inspectData),
            mounts: parseMounts(inspectData),
            health: parseHealth(inspectData),
            labels: inspectData?.Config?.Labels || {},
            // Resource usage (if available)
            cpu: 0,
            memory: 0,
          });
        } catch (parseError) {
          console.error('Error parsing container JSON:', parseError);
        }
      }

      // Get resource stats for running containers
      await attachContainerStats(containers);

      containersCache.data = containers;
      containersCache.timestamp = Date.now();
      containersCache.promise = null;
      return containers;
    } catch (error) {
      console.error('Error getting Docker containers:', error);
      containersCache.promise = null;
      return [];
    }
  })();

  return containersCache.promise;
}

/**
 * Get detailed container inspection data
 */
async function inspectContainer(containerId) {
  try {
    const stdout = await runDocker(['inspect', containerId]);
    const data = JSON.parse(stdout);
    return data[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Parse ports string from docker ps output
 * Format: "0.0.0.0:8080->80/tcp, 0.0.0.0:443->443/tcp"
 */
function parsePorts(portsString) {
  if (!portsString) return [];

  const ports = [];
  const portEntries = portsString.split(', ');

  for (const entry of portEntries) {
    // Match format: host:hostPort->containerPort/protocol
    // or: containerPort/protocol (exposed but not mapped)
    const mappedMatch = entry.match(/(?:(.+):)?(\d+)->(\d+)\/(\w+)/);
    if (mappedMatch) {
      const [, host, hostPort, containerPort, protocol] = mappedMatch;
      ports.push({
        hostIp: host || '0.0.0.0',
        hostPort: parseInt(hostPort, 10),
        containerPort: parseInt(containerPort, 10),
        protocol: protocol || 'tcp',
        type: 'mapped',
      });
    } else {
      // Exposed but not mapped: just "80/tcp"
      const exposedMatch = entry.match(/(\d+)\/(\w+)/);
      if (exposedMatch) {
        const [, containerPort, protocol] = exposedMatch;
        ports.push({
          hostIp: null,
          hostPort: null,
          containerPort: parseInt(containerPort, 10),
          protocol: protocol || 'tcp',
          type: 'exposed',
        });
      }
    }
  }

  return ports;
}

function buildFullCommand(inspectData, fallbackCommand = '') {
  try {
    const entrypoint = Array.isArray(inspectData?.Config?.Entrypoint)
      ? inspectData.Config.Entrypoint.join(' ')
      : (inspectData?.Config?.Entrypoint || '');
    const cmd = Array.isArray(inspectData?.Config?.Cmd)
      ? inspectData.Config.Cmd.join(' ')
      : (inspectData?.Config?.Cmd || '');
    const full = `${entrypoint} ${cmd}`.trim();
    return full || fallbackCommand || '';
  } catch {
    return fallbackCommand || '';
  }
}

/**
 * Parse networks from container inspect data
 */
function parseNetworks(inspectData) {
  if (!inspectData?.NetworkSettings?.Networks) return [];

  const networks = [];
  for (const [name, config] of Object.entries(inspectData.NetworkSettings.Networks)) {
    networks.push({
      name,
      networkId: config.NetworkID,
      ipAddress: config.IPAddress,
      gateway: config.Gateway,
      macAddress: config.MacAddress,
      aliases: config.Aliases || [],
    });
  }

  return networks;
}

/**
 * Parse mounts/volumes from container inspect data
 */
function parseMounts(inspectData) {
  if (!inspectData?.Mounts) return [];

  return inspectData.Mounts.map(mount => ({
    type: mount.Type, // bind, volume, tmpfs
    source: mount.Source,
    destination: mount.Destination,
    mode: mount.Mode,
    readWrite: mount.RW,
    name: mount.Name || null,
  }));
}

/**
 * Parse health status from container inspect data
 */
function parseHealth(inspectData) {
  if (!inspectData?.State) {
    return { status: 'unknown', checks: [] };
  }

  const state = inspectData.State;

  // If container has health check configured
  if (state.Health) {
    return {
      status: state.Health.Status, // healthy, unhealthy, starting
      failingStreak: state.Health.FailingStreak || 0,
      checks: (state.Health.Log || []).slice(-3).map(log => ({
        start: log.Start,
        end: log.End,
        exitCode: log.ExitCode,
        output: log.Output?.substring(0, 200), // Truncate output
      })),
    };
  }

  // No health check, derive from container state
  if (state.Running) {
    return { status: 'running', checks: [] };
  } else if (state.Paused) {
    return { status: 'paused', checks: [] };
  } else if (state.Restarting) {
    return { status: 'restarting', checks: [] };
  } else if (state.Dead) {
    return { status: 'dead', checks: [] };
  } else {
    return {
      status: 'exited',
      exitCode: state.ExitCode,
      checks: []
    };
  }
}

/**
 * Attach CPU and memory stats to containers
 */
async function attachContainerStats(containers) {
  const runningContainers = containers.filter(c => c.state === 'running');
  if (runningContainers.length === 0) return;

  try {
    // Get stats for all running containers at once
    const stdout = await runDocker(['stats', '--no-stream', '--format', '{{json .}}']);

    if (!stdout.trim()) return;

    const statsMap = new Map();
    for (const line of stdout.trim().split('\n')) {
      try {
        const stats = JSON.parse(line);
        statsMap.set(stats.ID, stats);
        // Also map by container name (docker stats uses short ID)
        statsMap.set(stats.Name, stats);
      } catch (e) {
        // Skip malformed lines
      }
    }

    for (const container of containers) {
      // Try to find stats by ID prefix or name
      const stats = statsMap.get(container.id.substring(0, 12)) ||
                    statsMap.get(container.name);
      if (stats) {
        // Parse CPU percentage (format: "0.50%")
        container.cpu = parseFloat(stats.CPUPerc?.replace('%', '') || '0');
        // Parse memory percentage (format: "0.50%")
        container.memory = parseFloat(stats.MemPerc?.replace('%', '') || '0');
        // Store raw memory usage string for display
        container.memoryUsage = stats.MemUsage || '';
      }
    }
  } catch (error) {
    // Stats not available, leave as 0
  }
}

/**
 * Get Docker networks with their connected containers
 */
async function getDockerNetworks() {
  const now = Date.now();
  if (networksCache.data.length && now - networksCache.timestamp < CACHE_TTL_MS) {
    return networksCache.data;
  }
  if (networksCache.promise) {
    return networksCache.promise;
  }

  networksCache.promise = (async () => {
    try {
      if (!(await isDockerAvailable())) {
        networksCache.data = [];
        networksCache.timestamp = Date.now();
        networksCache.promise = null;
        return [];
      }

      // Get network list
      const stdout = await runDocker(['network', 'ls', '--format', '{{json .}}']);

      if (!stdout.trim()) {
        networksCache.data = [];
        networksCache.timestamp = Date.now();
        networksCache.promise = null;
        return [];
      }

      const networks = [];
      const lines = stdout.trim().split('\n');

      for (const line of lines) {
        try {
          const network = JSON.parse(line);

          // Get detailed network info
          const inspectData = await inspectNetwork(network.ID);

          networks.push({
            id: network.ID,
            name: network.Name,
            driver: network.Driver,
            scope: network.Scope,
            ipam: inspectData?.IPAM || {},
            containers: parseNetworkContainers(inspectData),
            internal: inspectData?.Internal || false,
            attachable: inspectData?.Attachable || false,
          });
        } catch (parseError) {
          console.error('Error parsing network JSON:', parseError);
        }
      }

      networksCache.data = networks;
      networksCache.timestamp = Date.now();
      networksCache.promise = null;
      return networks;
    } catch (error) {
      console.error('Error getting Docker networks:', error);
      networksCache.promise = null;
      return [];
    }
  })();

  return networksCache.promise;
}

/**
 * Inspect a Docker network
 */
async function inspectNetwork(networkId) {
  try {
    const stdout = await runDocker(['network', 'inspect', networkId]);
    const data = JSON.parse(stdout);
    return data[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Parse containers from network inspect data
 */
function parseNetworkContainers(inspectData) {
  if (!inspectData?.Containers) return [];

  const containers = [];
  for (const [containerId, config] of Object.entries(inspectData.Containers)) {
    containers.push({
      id: containerId,
      name: config.Name,
      ipv4Address: config.IPv4Address,
      ipv6Address: config.IPv6Address,
      macAddress: config.MacAddress,
    });
  }

  return containers;
}

/**
 * Build container-to-container connections based on shared networks
 * Returns edges representing which containers can communicate
 */
function buildContainerConnections(containers, networks) {
  const connections = [];
  const connectionSet = new Set();

  // First, group containers by Docker Compose project
  const containersByProject = new Map();
  for (const container of containers) {
    const project = container.labels?.['com.docker.compose.project'];
    if (project) {
      if (!containersByProject.has(project)) {
        containersByProject.set(project, []);
      }
      containersByProject.get(project).push(container);
    }
  }

  // Create edges between containers in the same Docker Compose project
  for (const [project, projectContainers] of containersByProject) {
    for (let i = 0; i < projectContainers.length; i++) {
      for (let j = i + 1; j < projectContainers.length; j++) {
        const containerA = projectContainers[i];
        const containerB = projectContainers[j];

        const edgeKey = [containerA.id, containerB.id].sort().join('-');

        if (!connectionSet.has(edgeKey)) {
          connectionSet.add(edgeKey);
          connections.push({
            sourceContainerId: containerA.id,
            targetContainerId: containerB.id,
            networkName: `compose:${project}`,
            networkId: null,
          });
        }
      }
    }
  }

  // Also create edges for containers on shared custom networks (non-default)
  for (const network of networks) {
    // Skip default networks that everything connects to
    if (network.name === 'bridge' || network.name === 'host' || network.name === 'none') {
      continue;
    }

    const containersOnNetwork = network.containers || [];

    // Create edges between each pair of containers on this network
    for (let i = 0; i < containersOnNetwork.length; i++) {
      for (let j = i + 1; j < containersOnNetwork.length; j++) {
        const containerA = containersOnNetwork[i];
        const containerB = containersOnNetwork[j];

        // Create bidirectional edge key to prevent duplicates
        const edgeKey = [containerA.id, containerB.id].sort().join('-');

        if (!connectionSet.has(edgeKey)) {
          connectionSet.add(edgeKey);
          connections.push({
            sourceContainerId: containerA.id,
            targetContainerId: containerB.id,
            networkName: network.name,
            networkId: network.id,
          });
        }
      }
    }
  }

  return connections;
}

/**
 * Map container health status to graph health status colors
 */
function containerHealthToGraphHealth(container) {
  const status = container.health?.status || container.state;

  switch (status) {
    case 'running':
    case 'healthy':
      return 'green';
    case 'starting':
    case 'paused':
    case 'restarting':
      return 'yellow';
    case 'exited':
    case 'dead':
    case 'unhealthy':
      return 'red';
    default:
      return 'yellow';
  }
}

/**
 * Get a combined snapshot of Docker state for the graph
 */
async function getDockerSnapshot() {
  const [containers, networks] = await Promise.all([
    getDockerContainers(),
    getDockerNetworks(),
  ]);

  const containerConnections = buildContainerConnections(containers, networks);

  return {
    containers,
    networks,
    containerConnections,
    isAvailable: containers.length > 0 || await isDockerAvailable(),
  };
}

/**
 * Clear the Docker cache (useful for forcing refresh)
 */
function clearDockerCache() {
  containersCache.timestamp = 0;
  containersCache.data = [];
  containersCache.promise = null;
  networksCache.timestamp = 0;
  networksCache.data = [];
  networksCache.promise = null;
  resolvedDockerBin = null;
}

function sanitizeContainerId(containerId) {
  return typeof containerId === 'string' && /^[a-zA-Z0-9_.-]+$/.test(containerId);
}

async function stopContainer(containerId, timeoutSeconds = 5) {
  if (!sanitizeContainerId(containerId)) {
    return { success: false, error: 'Invalid container ID' };
  }

  try {
    await runDocker(['stop', '-t', String(timeoutSeconds), containerId]);
    clearDockerCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function startContainer(containerId) {
  if (!sanitizeContainerId(containerId)) {
    return { success: false, error: 'Invalid container ID' };
  }

  try {
    await runDocker(['start', containerId]);
    clearDockerCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  isDockerAvailable,
  getDockerContainers,
  getDockerNetworks,
  getDockerSnapshot,
  stopContainer,
  startContainer,
  buildContainerConnections,
  containerHealthToGraphHealth,
  clearDockerCache,
};
