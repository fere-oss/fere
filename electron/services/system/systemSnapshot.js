const { getDevProcesses, getProcessCacheInfo } = require('../monitoring/processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortCacheInfo } = require('../monitoring/portMonitor');
const { buildConnectionGraph } = require('../graph/connectionGraph');
const { getLastDockerStatus } = require('../docker/dockerMonitor');

// Performance timing - only log if enabled via env var
const PERF_LOGGING = process.env.FERE_PERF_LOG === '1';
const perfLog = (label, duration) => {
  if (PERF_LOGGING) {
    console.log(`[PERF] ${label}: ${duration.toFixed(2)}ms`);
  }
};

async function getSystemSnapshot() {
  const startTotal = Date.now();

  // Step 1: Gather base data in parallel (already optimized)
  const startData = Date.now();
  const [processes, ports, connections] = await Promise.all([
    getDevProcesses(),
    getListeningPorts(),
    getEstablishedConnections(),
  ]);
  perfLog('Data gathering (processes, ports, connections)', Date.now() - startData);

  // Step 2: Build connection graph
  const startGraph = Date.now();
  const graphResult = await buildConnectionGraph({ processes, ports, connections });
  perfLog('Graph building', Date.now() - startGraph);

  // Extract docker snapshot from graph result (if available)
  const { nodes, edges, dockerSnapshot } = graphResult;

  perfLog('Total snapshot time', Date.now() - startTotal);

  const collectedAt = Date.now();
  const processCacheInfo = getProcessCacheInfo();
  const portCacheInfo = getPortCacheInfo();

  const processesAgeMs = processCacheInfo.timestamp
    ? collectedAt - processCacheInfo.timestamp
    : null;
  const portsAgeMs = portCacheInfo.listeningTimestamp
    ? collectedAt - portCacheInfo.listeningTimestamp
    : null;
  const connectionsAgeMs = portCacheInfo.connectionsTimestamp
    ? collectedAt - portCacheInfo.connectionsTimestamp
    : null;

  return {
    processes,
    ports,
    connections,
    graph: { nodes, edges },
    docker: dockerSnapshot || null,
    meta: {
      collectedAt,
      processesAgeMs,
      portsAgeMs,
      connectionsAgeMs,
      status: {
        ports: portCacheInfo.status,
        processes: processCacheInfo.status,
        docker: getLastDockerStatus(),
      },
    },
  };
}

module.exports = {
  getSystemSnapshot,
};
