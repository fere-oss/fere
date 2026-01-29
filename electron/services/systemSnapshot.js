const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections } = require('./portMonitor');
const { buildConnectionGraph } = require('./connectionGraph');

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

  return {
    processes,
    ports,
    connections,
    graph: { nodes, edges },
    docker: dockerSnapshot || null,
  };
}

module.exports = {
  getSystemSnapshot,
};
