const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortDescription } = require('./portMonitor');

/**
 * Build a complete picture of the local dev environment
 * Returns nodes (processes/services) and edges (connections between them)
 */
async function buildConnectionGraph() {
  const [processes, ports, connections] = await Promise.all([
    getDevProcesses(),
    getListeningPorts(),
    getEstablishedConnections(),
  ]);

  // Create a map of PID to process info
  const processMap = new Map();
  for (const proc of processes) {
    processMap.set(proc.pid, proc);
  }

  // Create nodes from processes that have listening ports
  const nodes = [];
  const portToPid = new Map();

  for (const port of ports) {
    portToPid.set(port.port, port.pid);

    const proc = processMap.get(port.pid);
    const existingNode = nodes.find(n => n.pid === port.pid);

    if (existingNode) {
      // Add port to existing node
      existingNode.ports.push({
        port: port.port,
        host: port.host,
        description: getPortDescription(port.port),
      });
    } else {
      // Create new node
      nodes.push({
        id: `proc-${port.pid}`,
        pid: port.pid,
        name: proc ? proc.name : port.process,
        command: proc ? proc.command : port.process,
        type: categorizeProcess(port.process, proc?.command),
        cpu: proc?.cpu || 0,
        memory: proc?.memory || 0,
        user: port.user,
        ports: [{
          port: port.port,
          host: port.host,
          description: getPortDescription(port.port),
        }],
      });
    }
  }

  // Build edges from established connections
  const edges = [];
  const edgeSet = new Set(); // Prevent duplicate edges

  for (const conn of connections) {
    // Check if this connection is to a local listening port
    const targetPid = portToPid.get(conn.remotePort);
    if (!targetPid) continue; // Connection to external service

    // Check if the source process is in our dev processes
    const sourceNode = nodes.find(n => n.pid === conn.pid);
    const targetNode = nodes.find(n => n.pid === targetPid);

    if (sourceNode && targetNode && sourceNode.id !== targetNode.id) {
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
        });
      }
    }
  }

  return { nodes, edges };
}

/**
 * Categorize a process into a type for visualization
 */
function categorizeProcess(processName, command = '') {
  const name = processName.toLowerCase();
  const cmd = command.toLowerCase();

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
};
