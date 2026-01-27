const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections } = require('./portMonitor');
const { buildConnectionGraph } = require('./connectionGraph');

async function getSystemSnapshot() {
  const [processes, ports, connections] = await Promise.all([
    getDevProcesses(),
    getListeningPorts(),
    getEstablishedConnections(),
  ]);

  const graphResult = await buildConnectionGraph({ processes, ports, connections });

  // Extract docker snapshot from graph result (if available)
  const { nodes, edges, dockerSnapshot } = graphResult;

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
