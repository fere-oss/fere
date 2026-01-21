const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections } = require('./portMonitor');
const { buildConnectionGraph } = require('./connectionGraph');

async function getSystemSnapshot() {
  const [processes, ports, connections] = await Promise.all([
    getDevProcesses(),
    getListeningPorts(),
    getEstablishedConnections(),
  ]);

  const graph = await buildConnectionGraph({ processes, ports, connections });

  return {
    processes,
    ports,
    connections,
    graph,
  };
}

module.exports = {
  getSystemSnapshot,
};
