const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

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
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;

    const [command, pid, user, fd, type, device, sizeOff, node, name] = parts;

    // Parse the NAME field (e.g., "*:3000" or "127.0.0.1:5432" or "[::1]:8080")
    const portMatch = name.match(/:(\d+)$/);
    if (!portMatch) continue;

    const port = parseInt(portMatch[1], 10);
    const host = name.replace(`:${port}`, '') || '*';

    ports.push({
      port,
      host,
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
    const parts = line.trim().split(/\s+/);
    if (parts.length < 9) continue;

    const [command, pid, user, fd, type, device, sizeOff, node, name] = parts;

    // Parse connection format: "localhost:52341->localhost:5432"
    const connMatch = name.match(/(.+):(\d+)->(.+):(\d+)/);
    if (!connMatch) continue;

    const [, localHost, localPort, remoteHost, remotePort] = connMatch;

    connections.push({
      pid: parseInt(pid, 10),
      process: command,
      user,
      localHost,
      localPort: parseInt(localPort, 10),
      remoteHost,
      remotePort: parseInt(remotePort, 10),
      protocol: node.toLowerCase(),
    });
  }

  return connections;
}

/**
 * Get all listening ports
 */
async function getListeningPorts() {
  try {
    const { stdout } = await execAsync('lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null');
    return parseListeningPorts(stdout);
  } catch (error) {
    // lsof returns exit code 1 when no results found
    if (error.code === 1) return [];
    console.error('Error getting listening ports:', error);
    return [];
  }
}

/**
 * Get all established TCP connections
 */
async function getEstablishedConnections() {
  try {
    const { stdout } = await execAsync('lsof -iTCP -sTCP:ESTABLISHED -P -n 2>/dev/null');
    return parseConnections(stdout);
  } catch (error) {
    if (error.code === 1) return [];
    console.error('Error getting connections:', error);
    return [];
  }
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

module.exports = {
  getListeningPorts,
  getEstablishedConnections,
  getProcessOnPort,
  getPortDescription,
  parseListeningPorts,
  parseConnections,
  COMMON_DEV_PORTS,
};
