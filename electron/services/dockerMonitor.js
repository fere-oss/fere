const fs = require('fs');
const path = require('path');
const { runDocker, clearDockerBinCache } = require('./platform/docker');
const { scanDockerServiceConnections } = require('./localConnectionScanner');

const CACHE_TTL_MS = 2000; // 2 second cache for Docker data (Docker commands are slower)
const containersCache = { timestamp: 0, data: [], promise: null };
const networksCache = { timestamp: 0, data: [], promise: null };
const RUNNING_STATES = new Set(['running', 'paused', 'restarting']);
const DEFAULT_NETWORKS = new Set(['bridge', 'host', 'none']);
let lastDockerStatus = { code: 'ok' };

/**
 * Check if Docker is available and running
 */
async function isDockerAvailable() {
  try {
    await runDocker(['info'], { allowFailure: true });
    lastDockerStatus = { code: 'ok' };
    return true;
  } catch (error) {
    const msg = String(error?.message || error?.stderr || '');
    if (/cannot connect|connection refused|daemon.*not running|is the docker daemon running/i.test(msg)) {
      lastDockerStatus = {
        code: 'unavailable',
        message: 'Docker Desktop is not running',
      };
    } else if (/permission denied|access denied/i.test(msg)) {
      lastDockerStatus = {
        code: 'permission_denied',
        message: 'Cannot access Docker',
      };
    } else if (/not found|enoent/i.test(msg)) {
      lastDockerStatus = {
        code: 'unavailable',
        message: 'Docker Desktop is not installed',
      };
    } else {
      lastDockerStatus = {
        code: 'degraded',
        message: 'Docker check failed',
      };
    }
    return false;
  }
}

async function getDockerStatus() {
  await isDockerAvailable();
  return lastDockerStatus;
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
 * Parse build.context for each service in a compose file.
 * Returns Map<serviceName, absoluteSourcePath>.
 * Services using `image:` (no build) are omitted.
 */
function parseComposeBuildContexts(composePath) {
  try {
    const composeDir = path.dirname(composePath);
    const content = fs.readFileSync(composePath, 'utf8');
    const lines = content.split('\n');
    const contexts = new Map();

    let inServices = false;
    let currentService = null;
    let inBuild = false;

    for (const rawLine of lines) {
      if (/^\S/.test(rawLine)) {
        inServices = rawLine.trimEnd() === 'services:';
        currentService = null;
        inBuild = false;
        continue;
      }
      if (!inServices) continue;

      const serviceMatch = rawLine.match(/^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/);
      if (serviceMatch) {
        currentService = serviceMatch[1];
        inBuild = false;
        continue;
      }

      if (!currentService) continue;

      const buildStringMatch = rawLine.match(/^    build:\s+(.+)\s*$/);
      if (buildStringMatch) {
        const val = buildStringMatch[1].trim().replace(/['"]/g, '');
        if (!val.startsWith('{')) {
          contexts.set(currentService, path.resolve(composeDir, val));
          inBuild = false;
        } else {
          inBuild = true;
        }
        continue;
      }

      if (/^    build:\s*$/.test(rawLine)) {
        inBuild = true;
        continue;
      }

      if (inBuild) {
        if (!/^    /.test(rawLine) || /^    \S/.test(rawLine)) {
          inBuild = false;
          continue;
        }
        const ctxMatch = rawLine.match(/^      context:\s+(.+)\s*$/);
        if (ctxMatch) {
          const ctx = ctxMatch[1].trim().replace(/['"]/g, '');
          contexts.set(currentService, path.resolve(composeDir, ctx));
          inBuild = false;
        }
      }
    }

    return contexts;
  } catch {
    return new Map();
  }
}

function parseComposeDependsOn(composePath) {
  try {
    const content = fs.readFileSync(composePath, 'utf8');
    const result = new Map();
    const lines = content.split('\n');

    let inServices = false;
    let currentService = null;
    let inDependsOn = false;

    for (const rawLine of lines) {
      if (/^\S/.test(rawLine)) {
        inServices = rawLine.trimEnd() === 'services:';
        currentService = null;
        inDependsOn = false;
        continue;
      }

      if (!inServices) continue;

      const serviceMatch = rawLine.match(/^  ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/);
      if (serviceMatch) {
        currentService = serviceMatch[1];
        inDependsOn = false;
        continue;
      }

      if (!currentService) continue;

      if (/^    depends_on:/.test(rawLine)) {
        const inlineMatch = rawLine.match(/depends_on:\s*\[([^\]]*)\]/);
        if (inlineMatch) {
          const deps = result.get(currentService) || new Set();
          for (const dep of inlineMatch[1].split(',')) {
            const d = dep.trim().replace(/['"]/g, '');
            if (d) deps.add(d);
          }
          if (deps.size > 0) result.set(currentService, deps);
          inDependsOn = false;
        } else {
          inDependsOn = true;
        }
        continue;
      }

      if (inDependsOn) {
        if (!/^    /.test(rawLine) || /^    \S/.test(rawLine)) {
          inDependsOn = false;
          continue;
        }

        const listMatch = rawLine.match(/^\s+-\s+([A-Za-z0-9][A-Za-z0-9_.-]*)\s*$/);
        if (listMatch) {
          const deps = result.get(currentService) || new Set();
          deps.add(listMatch[1]);
          result.set(currentService, deps);
          continue;
        }

        const condMatch = rawLine.match(/^      ([A-Za-z0-9][A-Za-z0-9_.-]*):\s*$/);
        if (condMatch) {
          const deps = result.get(currentService) || new Set();
          deps.add(condMatch[1]);
          result.set(currentService, deps);
        }
      }
    }

    return result;
  } catch {
    return new Map();
  }
}

/**
 * Build container-to-container connections based on docker-compose source
 * analysis or depends_on metadata.
 * Returns edges representing which containers depend on which.
 */
function buildContainerConnections(containers, networks) {
  const connections = [];
  const connectionSet = new Set();

  // Build a global service name -> container map so cross-project references
  // still resolve when services are started from separate compose projects.
  const globalServiceToContainer = new Map();
  for (const container of containers) {
    const svc = container.labels?.['com.docker.compose.service'];
    if (svc) globalServiceToContainer.set(svc, container);
  }
  const globalServiceNames = new Set(globalServiceToContainer.keys());

  // Group containers by Docker Compose project
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

  // For each compose project, infer only meaningful edges.
  for (const [project, projectContainers] of containersByProject) {
    let composePath = null;
    for (const c of projectContainers) {
      const configFiles = c.labels?.['com.docker.compose.project.config_files'];
      if (configFiles) {
        composePath = configFiles.split(',')[0].trim();
        break;
      }
    }

    if (!composePath) {
      continue;
    }

    const serviceToContainer = new Map();
    for (const c of projectContainers) {
      const svc = c.labels?.['com.docker.compose.service'];
      if (svc) serviceToContainer.set(svc, c);
    }

    const buildContexts = parseComposeBuildContexts(composePath);

    if (buildContexts.size > 0) {
      for (const [serviceName, sourceDir] of buildContexts) {
        const sourceContainer =
          serviceToContainer.get(serviceName) ||
          globalServiceToContainer.get(serviceName);
        if (!sourceContainer) continue;

        const otherServices = new Set(globalServiceNames);
        otherServices.delete(serviceName);
        const referencedServices = scanDockerServiceConnections(
          sourceDir,
          otherServices,
        );

        for (const dep of referencedServices) {
          const targetContainer = globalServiceToContainer.get(dep);
          if (!targetContainer) continue;
          const edgeKey = `${sourceContainer.id}->${targetContainer.id}`;
          if (connectionSet.has(edgeKey)) continue;
          connectionSet.add(edgeKey);
          connections.push({
            sourceContainerId: sourceContainer.id,
            targetContainerId: targetContainer.id,
            networkName: `compose:${project}`,
            networkId: null,
          });
        }
      }
    } else {
      const dependsOn = parseComposeDependsOn(composePath);
      for (const [serviceName, deps] of dependsOn) {
        const sourceContainer = serviceToContainer.get(serviceName);
        if (!sourceContainer) continue;
        for (const dep of deps) {
          const targetContainer =
            globalServiceToContainer.get(dep) || serviceToContainer.get(dep);
          if (!targetContainer) continue;
          const edgeKey = `${sourceContainer.id}->${targetContainer.id}`;
          if (connectionSet.has(edgeKey)) continue;
          connectionSet.add(edgeKey);
          connections.push({
            sourceContainerId: sourceContainer.id,
            targetContainerId: targetContainer.id,
            networkName: `compose:${project}`,
            networkId: null,
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
  const healthStatus = container.health?.status;
  const state = container.state;

  // Running but unhealthy = degraded (yellow), not down
  if (state === 'running' && healthStatus === 'unhealthy') {
    return 'yellow';
  }

  const status = healthStatus || state;

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
  clearDockerBinCache();
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

async function restartContainer(containerId) {
  if (!sanitizeContainerId(containerId)) {
    return { success: false, error: 'Invalid container ID' };
  }

  try {
    await runDocker(['restart', containerId]);
    clearDockerCache();
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============================================
// Compose File Parsing — Ghost Node Support
// ============================================

const COMPOSE_FILENAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

/**
 * Scan project directories for compose files.
 * Returns array of absolute paths to compose files.
 */
function findComposeFiles(projectPaths) {
  const found = [];
  for (const projectPath of projectPaths) {
    for (const name of COMPOSE_FILENAMES) {
      const candidate = path.join(projectPath, name);
      try {
        if (fs.existsSync(candidate)) {
          found.push(candidate);
          break; // first match wins per project
        }
      } catch { /* skip inaccessible dirs */ }
    }
  }
  return found;
}

// Extended cache for full compose metadata (not just service names)
const composeMetadataCache = new Map();

/**
 * Parse a compose file for full service metadata.
 * Returns array of { name, image, buildContext, ports, dependsOn }.
 */
function parseComposeServices(composePath) {
  try {
    const mtime = fs.statSync(composePath).mtimeMs;
    const cached = composeMetadataCache.get(composePath);
    if (cached && cached.mtime === mtime) return cached.services;

    const content = fs.readFileSync(composePath, 'utf8');
    const composeDir = path.dirname(composePath);

    const servicesBlockMatch = content.match(/^services:\s*\n([\s\S]*?)(?=\n\S|$)/m);
    if (!servicesBlockMatch) {
      composeMetadataCache.set(composePath, { mtime, services: [] });
      return [];
    }

    const servicesBlock = servicesBlockMatch[1];
    const services = [];

    // Find each service name (2-space-indented top-level key under services:)
    const serviceNames = [...servicesBlock.matchAll(/^  ([A-Za-z0-9][A-Za-z0-9_-]*):/gm)].map(m => m[1]);

    for (const name of serviceNames) {
      // Extract this service's block (everything until next service or end)
      const nameEscaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const blockMatch = servicesBlock.match(
        new RegExp(`^  ${nameEscaped}[ \\t]*:[ \\t]*\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9]|$)`, 'm')
      );
      const block = blockMatch ? blockMatch[1] : '';

      // Parse image
      const imageMatch = block.match(/image:[ \t]*([^\n\r]+)/);
      const image = imageMatch ? imageMatch[1].trim() : null;

      // Parse build context
      const buildContext = resolveServiceBuildContext(composeDir, block);

      // Parse ports (host:container format)
      const ports = [];
      const portsMatch = block.match(/ports:\s*\n((?:[ \t]*-[^\n]*\n?)*)/);
      if (portsMatch) {
        for (const pm of portsMatch[1].matchAll(/- ["']?(\d+):(\d+)/g)) {
          ports.push({ host: parseInt(pm[1], 10), container: parseInt(pm[2], 10) });
        }
      }

      // Parse depends_on (list format)
      const dependsOn = [];
      const dependsMatch = block.match(/depends_on:\s*\n((?:[ \t]*-[^\n]*\n?|[ \t]+[A-Za-z0-9][^\n]*\n?)*)/);
      if (dependsMatch) {
        // List format: - service_name
        for (const dm of dependsMatch[1].matchAll(/- [ \t]*([A-Za-z0-9][A-Za-z0-9_-]*)/g)) {
          dependsOn.push(dm[1]);
        }
        // Map format: service_name:\n  condition: ...
        if (dependsOn.length === 0) {
          for (const dm of dependsMatch[1].matchAll(/^[ \t]+([A-Za-z0-9][A-Za-z0-9_-]*):/gm)) {
            dependsOn.push(dm[1]);
          }
        }
      }

      services.push({ name, image, buildContext, ports, dependsOn });
    }

    composeMetadataCache.set(composePath, { mtime, services });
    return services;
  } catch {
    return [];
  }
}

/**
 * Discover all compose-defined services from both running container labels
 * and project path scanning.
 * Returns { composeFiles: [{ filePath, projectName, projectPath, services }] }
 */
function getComposeDefinedServices(containers, projectPaths) {
  const composeFiles = new Map(); // filePath -> info

  // 1. From running container labels
  for (const container of containers) {
    const configFiles = container.labels?.['com.docker.compose.project.config_files'];
    const projectName = container.labels?.['com.docker.compose.project'];
    const workingDir = container.labels?.['com.docker.compose.project.working_dir'];
    if (!configFiles) continue;

    const filePath = configFiles.split(',')[0].trim();
    if (composeFiles.has(filePath)) continue;

    const services = parseComposeServices(filePath);
    composeFiles.set(filePath, {
      filePath,
      projectName: projectName || path.basename(path.dirname(filePath)),
      projectPath: workingDir || path.dirname(filePath),
      services,
    });
  }

  // 2. From project path scanning
  const discoveredFiles = findComposeFiles(projectPaths);
  for (const filePath of discoveredFiles) {
    if (composeFiles.has(filePath)) continue;

    const services = parseComposeServices(filePath);
    if (services.length === 0) continue;

    composeFiles.set(filePath, {
      filePath,
      projectName: path.basename(path.dirname(filePath)),
      projectPath: path.dirname(filePath),
      services,
    });
  }

  // 3. Deduplicate: remove compose files whose directory is a subdirectory
  // of another compose project. e.g. robot-shop/payment/docker-compose.yaml
  // is redundant when robot-shop/docker-compose.yaml exists.
  const projectDirs = [...composeFiles.values()].map(f => f.projectPath);
  for (const [filePath, info] of composeFiles) {
    const dir = info.projectPath;
    const isSubdir = projectDirs.some(
      parentDir => dir !== parentDir && dir.startsWith(parentDir + '/')
    );
    if (isSubdir) composeFiles.delete(filePath);
  }

  return { composeFiles: [...composeFiles.values()] };
}

// ============================================
// Start Compose Project
// ============================================

async function startComposeProject(composeFilePath, services = []) {
  // Validate file path
  const resolved = path.resolve(composeFilePath);
  if (!fs.existsSync(resolved)) {
    return { success: false, error: 'Compose file not found' };
  }
  const ext = path.extname(resolved).toLowerCase();
  if (ext !== '.yml' && ext !== '.yaml') {
    return { success: false, error: 'Invalid compose file extension' };
  }

  // Validate service names against actual compose file to prevent injection
  if (services.length > 0) {
    const definedServices = getServiceNamesFromCompose(resolved);
    if (definedServices) {
      for (const svc of services) {
        if (!definedServices.has(svc)) {
          return { success: false, error: `Unknown service: ${svc}` };
        }
      }
    }
  }

  try {
    const args = ['compose', '-f', resolved, 'up', '-d'];
    if (services.length > 0) args.push(...services);
    await runDocker(args);
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
  restartContainer,
  buildContainerConnections,
  containerHealthToGraphHealth,
  clearDockerCache,
  getComposeDefinedServices,
  startComposeProject,
};
