const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execFileAsync = promisify(execFile);

const CACHE_TTL_MS = 2000; // 2 second cache for Docker data (Docker commands are slower)
const containersCache = { timestamp: 0, data: [], promise: null };
const networksCache = { timestamp: 0, data: [], promise: null };
const RUNNING_STATES = new Set(['running', 'paused', 'restarting']);
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none']);
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
    ? [preferred]
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

// Last known Docker service status (updated by getDockerStatus)
let lastDockerStatus = { code: 'ok' };

/**
 * Diagnose Docker availability and return a structured ServiceStatus.
 * Distinguishes: not installed, not running, permission denied, ok.
 */
async function getDockerStatus() {
  // Step 1: Can we find the binary at all?
  const bin = await resolveDockerBinary();
  if (!bin) {
    lastDockerStatus = {
      code: 'unavailable',
      message: 'Docker Desktop is not installed',
    };
    return lastDockerStatus;
  }

  // Step 2: Can we talk to the daemon?
  try {
    await runDocker(['info'], { allowFailure: true });
    lastDockerStatus = { code: 'ok' };
    return lastDockerStatus;
  } catch (error) {
    const msg = String(error?.message || error?.stderr || '');
    if (/cannot connect|connection refused|daemon.*not running|Is the docker daemon running/i.test(msg)) {
      lastDockerStatus = {
        code: 'unavailable',
        message: 'Docker Desktop is not running',
      };
    } else if (/permission denied|access denied/i.test(msg)) {
      lastDockerStatus = {
        code: 'permission_denied',
        message: 'Cannot access Docker',
      };
    } else {
      lastDockerStatus = {
        code: 'degraded',
        message: msg.slice(0, 200),
      };
    }
    return lastDockerStatus;
  }
}

function getLastDockerStatus() {
  return lastDockerStatus;
}

// Cache compose service name lookups keyed by compose file path.
// Entries are invalidated when the file's mtime changes.
const composeServicesCache = new Map();

/**
 * Returns the set of service names currently defined in a docker-compose.yml, or
 * null if the file cannot be read.  Results are cached by file mtime.
 */
function getServiceNamesFromCompose(configFilePath) {
  try {
    const mtime = fs.statSync(configFilePath).mtimeMs;
    const cached = composeServicesCache.get(configFilePath);
    if (cached && cached.mtime === mtime) return cached.services;

    const content = fs.readFileSync(configFilePath, 'utf8');
    // Extract top-level keys under the `services:` block (2-space-indented names).
    const servicesBlockMatch = content.match(/^services:\s*\n([\s\S]*?)(?=\n\S|$)/m);
    const services = new Set();
    if (servicesBlockMatch) {
      for (const m of servicesBlockMatch[1].matchAll(/^  ([A-Za-z0-9][A-Za-z0-9_-]*):/gm)) {
        services.add(m[1]);
      }
    }
    composeServicesCache.set(configFilePath, { mtime, services });
    return services;
  } catch {
    return null;
  }
}

/**
 * Returns true if a stopped container's service is still defined in its compose file.
 * Orphaned containers (from renamed/removed services) return false.
 */
function isCurrentComposeService(labels) {
  const configFiles = labels?.['com.docker.compose.project.config_files'];
  const serviceName = labels?.['com.docker.compose.service'];
  if (!configFiles || !serviceName) return true; // not a compose container, keep it
  const composePath = configFiles.split(',')[0].trim();
  const services = getServiceNamesFromCompose(composePath);
  if (!services) return true; // can't read file, keep it to be safe
  return services.has(serviceName);
}

/**
 * Shared helper: parses the docker-compose.yml for the service block referenced by
 * the container's labels.  Returns { composePath, composeDir, serviceBlock } or null.
 */
function resolveComposeServiceBlock(labels) {
  const configFiles = labels?.['com.docker.compose.project.config_files'];
  const serviceName = labels?.['com.docker.compose.service'];
  if (!configFiles || !serviceName) return null;
  try {
    const composePath = configFiles.split(',')[0].trim();
    const composeDir = path.dirname(composePath);
    const composeContent = fs.readFileSync(composePath, 'utf8');
    const serviceNameEscaped = serviceName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const serviceBlockMatch = composeContent.match(
      new RegExp(`(?:^|\\n)  ${serviceNameEscaped}[ \\t]*:[ \\t]*\\n([\\s\\S]*?)(?=\\n[ \\t]*\\n  \\S|\\n  \\S|$)`)
    );
    if (!serviceBlockMatch) return null;
    return { composePath, composeDir, serviceBlock: serviceBlockMatch[1] };
  } catch { return null; }
}

/**
 * Resolve the build context directory from a service block.
 * Handles both short form (build: ./dir) and long form (build:\n  context: ./dir).
 */
function resolveServiceBuildContext(composeDir, serviceBlock) {
  let buildContext = null;
  // Short form: "build: ./path" — use [ \t]* to avoid crossing newlines with \s*.
  const shortBuildMatch = serviceBlock.match(/build:[ \t]*([^\n\r{][^\n\r]*)/);
  if (shortBuildMatch && shortBuildMatch[1].trim()) {
    buildContext = shortBuildMatch[1].trim();
  } else {
    // Long form: build:\n  context: ./path
    const contextMatch = serviceBlock.match(/context:[ \t]*([^\n\r]+)/);
    if (contextMatch) buildContext = contextMatch[1].trim();
  }
  if (!buildContext) return null;
  return path.resolve(composeDir, buildContext);
}

/**
 * Returns the resolved build context directory for a compose service, or null.
 * Useful for route scanning when the source is baked into the image (no bind mounts).
 */
function getBuildContextPath(labels) {
  const parsed = resolveComposeServiceBlock(labels);
  if (!parsed) return null;
  const contextPath = resolveServiceBuildContext(parsed.composeDir, parsed.serviceBlock);
  if (!contextPath || !fs.existsSync(contextPath)) return null;
  return contextPath;
}

/**
 * Reads the Dockerfile from a docker-compose build context to extract the base image.
 * Uses compose labels (config_files + service) already present in docker inspect output.
 * Returns the FROM image string (e.g. "node:20-alpine") or null if unavailable.
 */
function getBaseImageFromCompose(labels) {
  const parsed = resolveComposeServiceBlock(labels);
  if (!parsed) return null;
  const contextPath = resolveServiceBuildContext(parsed.composeDir, parsed.serviceBlock);
  if (!contextPath) return null;
  try {
    const dockerfilePath = path.join(contextPath, 'Dockerfile');
    if (!fs.existsSync(dockerfilePath)) return null;
    const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
    const fromMatch = dockerfileContent.match(/^FROM\s+([^\s\n]+)/im);
    return fromMatch ? fromMatch[1] : null;
  } catch { return null; }
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

      // Parse all container listings first
      const psEntries = [];
      for (const line of lines) {
        try {
          psEntries.push(JSON.parse(line));
        } catch (parseError) {
          console.error('Error parsing container JSON:', parseError);
        }
      }

      // Batch inspect: single `docker inspect` call for all containers
      const inspectMap = new Map();
      if (psEntries.length > 0) {
        try {
          const ids = psEntries.map(c => c.ID);
          const inspectStdout = await runDocker(['inspect', ...ids]);
          const inspectArray = JSON.parse(inspectStdout);
          for (const entry of inspectArray) {
            if (entry?.Id) inspectMap.set(entry.Id, entry);
          }
        } catch (inspectError) {
          // Fallback: if batch fails, inspect individually
          for (const entry of psEntries) {
            const data = await inspectContainer(entry.ID);
            if (data?.Id) inspectMap.set(data.Id, data);
          }
        }
      }

      for (const container of psEntries) {
        try {
          // Match by full ID or prefix
          const inspectData = inspectMap.get(container.ID) ||
            [...inspectMap.values()].find(d => d.Id?.startsWith(container.ID)) ||
            null;

          const containerLabels = inspectData?.Config?.Labels || {};
          const containerState = container.State;

          // Skip stopped containers that no longer belong to the current compose config.
          // This filters out orphaned containers left behind by service renames/removals
          // without affecting intentionally-stopped compose services.
          const isStopped = !RUNNING_STATES.has(containerState);
          if (isStopped && !isCurrentComposeService(containerLabels)) {
            continue;
          }

          containers.push({
            id: container.ID,
            name: container.Names,
            image: container.Image,
            command: container.Command,
            fullCommand: buildFullCommand(inspectData, container.Command),
            created: container.CreatedAt,
            status: container.Status,
            state: containerState, // running, exited, paused, etc.
            ports: parsePorts(container.Ports),
            networks: parseNetworks(inspectData),
            mounts: parseMounts(inspectData),
            health: parseHealth(inspectData),
            labels: containerLabels,
            baseImage: getBaseImageFromCompose(containerLabels),
            buildContextPath: getBuildContextPath(containerLabels),
            // Resource usage (if available)
            cpu: 0,
            memory: 0,
          });
        } catch (parseError) {
          console.error('Error processing container:', parseError);
        }
      }

      // Deduplicate: for the same compose project+service, prefer the running
      // container over any stopped one. This handles cases where a service was
      // recreated and the old stopped instance hasn't been pruned yet.
      const composeServiceWinner = new Map();
      for (const c of containers) {
        const project = c.labels?.['com.docker.compose.project'];
        const service = c.labels?.['com.docker.compose.service'];
        if (!project || !service) continue;
        const key = `${project}:${service}`;
        const prev = composeServiceWinner.get(key);
        if (!prev || (c.state === 'running' && prev.state !== 'running')) {
          composeServiceWinner.set(key, c);
        }
      }
      const winnersSet = new Set(composeServiceWinner.values());
      const dedupedContainers = containers.filter(c => {
        const project = c.labels?.['com.docker.compose.project'];
        const service = c.labels?.['com.docker.compose.service'];
        if (!project || !service) return true; // non-compose: always keep
        return winnersSet.has(c);
      });
      containers.length = 0;
      containers.push(...dedupedContainers);

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

const MAPPED_PORT_RE = /(?:(.+):)?(\d+)->(\d+)\/(\w+)/;
const EXPOSED_PORT_RE = /(\d+)\/(\w+)/;

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
    const mappedMatch = entry.match(MAPPED_PORT_RE);
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
      const exposedMatch = entry.match(EXPOSED_PORT_RE);
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

      // Parse all network listings first
      const netEntries = [];
      for (const line of lines) {
        try {
          netEntries.push(JSON.parse(line));
        } catch (parseError) {
          console.error('Error parsing network JSON:', parseError);
        }
      }

      // Batch inspect: single `docker network inspect` call for all networks
      const netInspectMap = new Map();
      if (netEntries.length > 0) {
        try {
          const ids = netEntries.map(n => n.ID);
          const inspectStdout = await runDocker(['network', 'inspect', ...ids]);
          const inspectArray = JSON.parse(inspectStdout);
          for (const entry of inspectArray) {
            if (entry?.Id) netInspectMap.set(entry.Id, entry);
          }
        } catch (inspectError) {
          // Fallback: if batch fails, inspect individually
          for (const entry of netEntries) {
            const data = await inspectNetwork(entry.ID);
            if (data?.Id) netInspectMap.set(data.Id, data);
          }
        }
      }

      for (const network of netEntries) {
        try {
          const inspectData = netInspectMap.get(network.ID) ||
            [...netInspectMap.values()].find(d => d.Id?.startsWith(network.ID)) ||
            null;

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
          console.error('Error processing network:', parseError);
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
    if (DEFAULT_NETWORKS.has(network.name)) {
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
  getDockerStatus,
  getLastDockerStatus,
  getDockerContainers,
  getDockerNetworks,
  getDockerSnapshot,
  stopContainer,
  startContainer,
  buildContainerConnections,
  containerHealthToGraphHealth,
  clearDockerCache,
};
