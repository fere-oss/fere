const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortDescription } = require('./portMonitor');

/**
 * Build a complete picture of the local dev environment
 * Returns nodes (processes/services) and edges (connections between them)
 */
async function buildConnectionGraph(snapshot = null) {
  const processes = snapshot?.processes || await getDevProcesses();
  const ports = snapshot?.ports || await getListeningPorts();
  const connections = snapshot?.connections || await getEstablishedConnections();

  // Create a map of PID to process info
  const processMap = new Map();
  for (const proc of processes) {
    processMap.set(proc.pid, proc);
  }

  // Create nodes from processes that have listening ports
  const nodes = [];
  const nodesByPid = new Map();
  const portToPid = new Map();
  const portProcessByPid = new Map();
  const portUserByPid = new Map();

  const ensureProcessNode = (pid, portProcess) => {
    if (nodesByPid.has(pid)) {
      return nodesByPid.get(pid);
    }

    const proc = processMap.get(pid);
    const fallbackProcess = portProcessByPid.get(pid) || portProcess;
    const name = proc ? proc.name : fallbackProcess;
    const command = proc ? proc.command : fallbackProcess;
    const node = {
      id: `proc-${pid}`,
      pid,
      name,
      command,
      type: categorizeProcess(name, command),
      cpu: proc?.cpu || 0,
      memory: proc?.memory || 0,
      user: proc?.user || portUserByPid.get(pid) || 'unknown',
      tty: proc?.tty || null,
      project: inferProjectFromCommand(command),
      ports: [],
    };

    nodes.push(node);
    nodesByPid.set(pid, node);
    return node;
  };

  for (const port of ports) {
    portToPid.set(port.port, port.pid);
    if (!portProcessByPid.has(port.pid)) {
      portProcessByPid.set(port.pid, port.process);
      portUserByPid.set(port.pid, port.user);
    }

    const node = ensureProcessNode(port.pid, port.process);
    node.ports.push({
      port: port.port,
      host: port.host,
      description: getPortDescription(port.port),
    });
  }

  // Build edges from established connections
  const edges = [];
  const edgeSet = new Set(); // Prevent duplicate edges
  const externalNodes = new Map();

  const getExternalNode = (host, port) => {
    const key = `${host}:${port}`;
    if (externalNodes.has(key)) {
      return externalNodes.get(key);
    }

    const node = {
      id: `external-${host}:${port}`,
      pid: -1,
      name: key,
      command: key,
      type: 'external',
      cpu: 0,
      memory: 0,
      user: 'external',
      tty: null,
      project: null,
      ports: [{
        port,
        host,
        description: null,
      }],
    };

    nodes.push(node);
    externalNodes.set(key, node);
    return node;
  };

  for (const conn of connections) {
    const sourceProc = processMap.get(conn.pid);
    if (!sourceProc) continue;

    const sourceNode = ensureProcessNode(conn.pid, conn.process);
    const targetPid = portToPid.get(conn.remotePort);
    const targetNode = targetPid
      ? ensureProcessNode(targetPid, conn.process)
      : getExternalNode(conn.remoteHost, conn.remotePort);

    if (sourceNode.id === targetNode.id) continue;

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

function inferProjectFromCommand(command = '') {
  const match = command.match(/\/Users\/[^/\s]+\/[^/\s]+/);
  if (match) {
    return match[0].split('/').pop();
  }

  const homeMatch = command.match(/\/home\/[^/\s]+\/[^/\s]+/);
  if (homeMatch) {
    return homeMatch[0].split('/').pop();
  }

  return null;
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
  inferProjectFromCommand,
};
