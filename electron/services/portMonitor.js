const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

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
  return name.replace(NORMALIZE_SUFFIX_RE, '').replace(NORMALIZE_PREFIX_RE, '').trim();
}

function stripBrackets(host) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function parseHostPort(part) {
  const portMatch = part.match(HOST_PORT_RE);
  if (!portMatch) return null;
  const port = parseInt(portMatch[1], 10);
  const hostRaw = part.slice(0, part.lastIndexOf(':'));
  const host = stripBrackets(hostRaw) || '*';
  return { host, port };
}

/**
 * Parse lsof output for listening ports
 * lsof -iTCP -sTCP:LISTEN -P -n format:
 * COMMAND  PID  USER  FD  TYPE  DEVICE  SIZE/OFF  NODE  NAME
 */
function parseListeningPorts(lsofOutput) {
  if (!lsofOutput || !lsofOutput.trim()) return [];

  const lines = lsofOutput.trim().split('\n');
  const ports = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseLsofLine(line);
    if (!parsed) continue;

    const { command, pid, user, fd, node, name } = parsed;
    const cleaned = normalizeName(name);
    const localPart = cleaned.split('->')[0].trim();
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

  // Deduplicate by port (same process can have multiple FDs for same port)
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
 * Parse lsof output for established connections
 */
function parseConnections(lsofOutput) {
  if (!lsofOutput || !lsofOutput.trim()) return [];

  const lines = lsofOutput.trim().split('\n');
  const connections = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const parsed = parseLsofLine(line);
    if (!parsed) continue;

    const { command, pid, user, node, name } = parsed;
    const cleaned = normalizeName(name);

    const parts = cleaned.split('->');
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

const CACHE_TTL_MS = 5000;
const listeningCache = { timestamp: 0, data: [], promise: null };
const connectionsCache = { timestamp: 0, data: [], promise: null };

async function runCached(cache, fetcher) {
  const now = Date.now();
  if (cache.data.length && now - cache.timestamp < CACHE_TTL_MS) {
    return cache.data;
  }
  if (cache.promise) {
    return cache.promise;
  }

  cache.promise = (async () => {
    try {
      const data = await fetcher();
      cache.data = data;
      cache.timestamp = Date.now();
      return data;
    } finally {
      cache.promise = null;
    }
  })();

  return cache.promise;
}

/**
 * Get all listening ports
 */
async function getListeningPorts() {
  return runCached(listeningCache, async () => {
    try {
      const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null');
      return parseListeningPorts(stdout);
    } catch (error) {
      // lsof returns exit code 1 when no results found
      if (error.code === 1) return [];
      console.error('Error getting listening ports:', error);
      return [];
    }
  });
}

/**
 * Get all established TCP connections
 */
async function getEstablishedConnections() {
  return runCached(connectionsCache, async () => {
    try {
      const { stdout } = await execAsync('lsof -iTCP -sTCP:ESTABLISHED -P -n 2>/dev/null');
      return parseConnections(stdout);
    } catch (error) {
      if (error.code === 1) return [];
      console.error('Error getting connections:', error);
      return [];
    }
  });
}

/**
 * Get what process is using a specific port
 */
async function getProcessOnPort(port) {
  try {
    const { stdout } = await execAsync(`lsof -iTCP:${port} -sTCP:LISTEN -P -n 2>/dev/null`);
    const ports = parseListeningPorts(stdout);
    return ports[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Common dev ports and their typical services
 */
const COMMON_DEV_PORTS = {
  22: 'SSH',
  3000: 'React/Node Dev Server',
  3001: 'React Dev Server (alt)',
  4000: 'GraphQL/API Server',
  5000: 'Flask/Python Dev Server',
  5173: 'Vite Dev Server',
  5432: 'PostgreSQL',
  6379: 'Redis',
  8000: 'Django/Python Server',
  8080: 'HTTP Alt / Java',
  8081: 'HTTP Alt',
  8443: 'HTTPS Alt',
  9000: 'PHP-FPM / SonarQube',
  27017: 'MongoDB',
  3306: 'MySQL',
};

/**
 * Get port description
 */
function getPortDescription(port) {
  return COMMON_DEV_PORTS[port] || null;
}

/**
 * Lightweight port enumeration (cheaper than full lsof parse)
 */
async function getListeningPortNumbers() {
  try {
    const { stdout } = await execAsync('netstat -an -p tcp 2>/dev/null');
    const ports = new Set();
    for (const line of stdout.trim().split('\n')) {
      if (!line.includes('LISTEN')) continue;
      const match = line.match(NETSTAT_LISTEN_RE);
      if (match) {
        ports.add(parseInt(match[1], 10));
      }
    }
    return ports;
  } catch (error) {
    // Fallback: extract from cached listening ports if available
    if (listeningCache.data.length) {
      return new Set(listeningCache.data.map(p => p.port));
    }
    return new Set();
  }
}

function clearPortCache() {
  listeningCache.timestamp = 0;
  listeningCache.data = [];
  listeningCache.promise = null;
  connectionsCache.timestamp = 0;
  connectionsCache.data = [];
  connectionsCache.promise = null;
}

module.exports = {
  getListeningPorts,
  getEstablishedConnections,
  getProcessOnPort,
  getPortDescription,
  parseListeningPorts,
  parseConnections,
  COMMON_DEV_PORTS,
  getPortCacheInfo: () => ({
    listeningTimestamp: listeningCache.timestamp || 0,
    connectionsTimestamp: connectionsCache.timestamp || 0,
  }),
  getListeningPortNumbers,
  clearPortCache,
};
