const platform = require('../platform');

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
  return runCached(listeningCache, () => platform.fetchListeningPorts());
}

/**
 * Get all established TCP connections
 */
async function getEstablishedConnections() {
  return runCached(connectionsCache, () => platform.fetchEstablishedConnections());
}

/**
 * Get what process is using a specific port
 */
async function getProcessOnPort(port) {
  return platform.fetchProcessOnPort(port);
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
    return await platform.fetchListeningPortNumbers();
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

// Re-export parsers for backward compatibility (used by tests)
const parseListeningPorts = platform.parseListeningPorts;
const parseConnections = platform.parseEstablishedConnections;

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
