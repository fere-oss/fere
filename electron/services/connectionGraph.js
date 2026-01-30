const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const { getDevProcesses } = require('./processMonitor');
const { getListeningPorts, getEstablishedConnections, getPortDescription } = require('./portMonitor');
const { scanRoutes, matchRoutesToService } = require('./routeScanner');
const { updateHealthTracking, getHealthStatus } = require('./healthTracker');
const {
  getDockerSnapshot,
  containerHealthToGraphHealth,
} = require('./dockerMonitor');

const execAsync = promisify(exec);

// Performance timing
const PERF_LOGGING = process.env.FERE_PERF_LOG === '1';
const perfLog = (label, duration) => {
  if (PERF_LOGGING) {
    console.log(`[PERF] ${label}: ${duration.toFixed(2)}ms`);
  }
};

// Persistent cache for process CWD (survives across polls)
// Cache entries: { pid: { cwd: string, timestamp: number } }
const CWD_CACHE_TTL_MS = 60000; // 60 seconds
const persistentCwdCache = new Map();

/**
 * Known macOS system services and their descriptions
 */
const KNOWN_SERVICES = {
  // Common developer apps
  'visual studio code': {
    description: 'Visual Studio Code - a code editor for development workflows.',
    category: 'developer',
    displayName: 'VS Code'
  },
  'code': {
    description: 'Visual Studio Code - a code editor for development workflows.',
    category: 'developer',
    displayName: 'VS Code'
  },
  'google chrome': {
    description: 'Google Chrome - web browser often used for local dev testing.',
    category: 'developer',
    displayName: 'Google Chrome'
  },
  'discord': {
    description: 'Discord - collaboration and chat client.',
    category: 'developer',
    displayName: 'Discord'
  },
  'electron': {
    description: 'Electron - runtime for desktop apps built with web tech.',
    category: 'developer',
    displayName: 'Electron'
  },
  'next-server': {
    description: 'Next.js dev server.',
    category: 'frontend',
    displayName: 'Next.js Dev Server'
  },
  // macOS System Services
  // Note: macOS truncates process names in ps output, so we include both full and truncated versions
  'controlcenter': {
    description: 'macOS Control Center daemon - manages Control Center widgets, toggles, and system controls like Wi-Fi, Bluetooth, Do Not Disturb, and AirDrop.',
    category: 'system',
    displayName: 'Control Center'
  },
  'controlce': {  // Truncated version from ps
    description: 'macOS Control Center daemon - manages Control Center widgets, toggles, and system controls like Wi-Fi, Bluetooth, Do Not Disturb, and AirDrop.',
    category: 'system',
    displayName: 'Control Center'
  },
  'commcenter': {
    description: 'macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.',
    category: 'system',
    displayName: 'CommCenter'
  },
  'commcentre': {
    description: 'macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.',
    category: 'system',
    displayName: 'CommCenter'
  },
  'commcente': {  // Truncated version from ps
    description: 'macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.',
    category: 'system',
    displayName: 'CommCenter'
  },
  'airportd': {
    description: 'macOS AirPort daemon - manages Wi-Fi connections, network scanning, and wireless network configuration.',
    category: 'system',
    displayName: 'AirPort Daemon'
  },
  'bluetoothd': {
    description: 'macOS Bluetooth daemon - handles Bluetooth device pairing, connections, and communication.',
    category: 'system',
    displayName: 'Bluetooth Daemon'
  },
  'configd': {
    description: 'macOS System Configuration daemon - monitors and manages system configuration, network settings, and dynamic store.',
    category: 'system',
    displayName: 'Config Daemon'
  },
  'coreaudiod': {
    description: 'macOS Core Audio daemon - manages audio routing, device selection, and audio processing for the system.',
    category: 'system',
    displayName: 'Core Audio'
  },
  'distnoted': {
    description: 'macOS Distributed Notification daemon - handles inter-process notifications and communication between apps.',
    category: 'system',
    displayName: 'Distributed Notifications'
  },
  'fseventsd': {
    description: 'macOS File System Events daemon - monitors file system changes and provides notifications to apps watching for changes.',
    category: 'system',
    displayName: 'FS Events'
  },
  'launchd': {
    description: 'macOS Launch daemon - the master process manager that starts and manages all system and user services.',
    category: 'system',
    displayName: 'launchd'
  },
  'mDNSResponder': {
    description: 'macOS Multicast DNS Responder - handles Bonjour service discovery, local network name resolution, and zero-configuration networking.',
    category: 'network',
    displayName: 'mDNS Responder'
  },
  'mDNSRespon': {  // Truncated version
    description: 'macOS Multicast DNS Responder - handles Bonjour service discovery, local network name resolution, and zero-configuration networking.',
    category: 'network',
    displayName: 'mDNS Responder'
  },
  'netbiosd': {
    description: 'macOS NetBIOS daemon - provides Windows network compatibility for file sharing and network browsing.',
    category: 'network',
    displayName: 'NetBIOS Daemon'
  },
  'rapportd': {
    description: 'macOS Rapport daemon - enables device-to-device communication for features like Universal Clipboard, Handoff, and AirDrop.',
    category: 'system',
    displayName: 'Rapport Daemon'
  },
  'sharingd': {
    description: 'macOS Sharing daemon - manages AirDrop, Handoff, Shared Clipboard, and other device sharing features.',
    category: 'system',
    displayName: 'Sharing Daemon'
  },
  'symptomsd': {
    description: 'macOS Symptoms daemon - collects network diagnostics and performance data to improve connectivity.',
    category: 'system',
    displayName: 'Symptoms Daemon'
  },
  'UserEventAgent': {
    description: 'macOS User Event Agent - monitors and responds to user-level system events like display sleep, wake, and login.',
    category: 'system',
    displayName: 'User Event Agent'
  },
  'UserEventAg': {  // Truncated version
    description: 'macOS User Event Agent - monitors and responds to user-level system events like display sleep, wake, and login.',
    category: 'system',
    displayName: 'User Event Agent'
  },
  'WiFiAgent': {
    description: 'macOS Wi-Fi Agent - manages the Wi-Fi menu bar item and user-facing Wi-Fi controls.',
    category: 'network',
    displayName: 'Wi-Fi Agent'
  },
  'identityservicesd': {
    description: 'macOS Identity Services daemon - handles iCloud account authentication, iMessage, and FaceTime identity.',
    category: 'system',
    displayName: 'Identity Services'
  },
  'identityse': {  // Truncated version
    description: 'macOS Identity Services daemon - handles iCloud account authentication, iMessage, and FaceTime identity.',
    category: 'system',
    displayName: 'Identity Services'
  },
  'cloudd': {
    description: 'macOS CloudKit daemon - manages iCloud data synchronization and CloudKit framework operations.',
    category: 'system',
    displayName: 'CloudKit Daemon'
  },
  'nsurlsessiond': {
    description: 'macOS URL Session daemon - handles background network transfers and downloads for apps.',
    category: 'network',
    displayName: 'NSURLSession Daemon'
  },
  'nsurlsessi': {  // Truncated version
    description: 'macOS URL Session daemon - handles background network transfers and downloads for apps.',
    category: 'network',
    displayName: 'NSURLSession Daemon'
  },
  'apsd': {
    description: 'macOS Apple Push Services daemon - manages push notifications from Apple services and third-party apps.',
    category: 'network',
    displayName: 'Apple Push Services'
  },
  'locationd': {
    description: 'macOS Location Services daemon - provides location data to apps and manages location privacy.',
    category: 'system',
    displayName: 'Location Services'
  },
  'coreduetd': {
    description: 'macOS Core Duet daemon - tracks app usage patterns to improve Siri suggestions and system intelligence.',
    category: 'system',
    displayName: 'Core Duet'
  },
  'suggestd': {
    description: 'macOS Suggestions daemon - provides intelligent suggestions in Spotlight, Siri, and other system features.',
    category: 'system',
    displayName: 'Suggestions Daemon'
  },
  'tccd': {
    description: 'macOS Transparency, Consent, and Control daemon - manages privacy permissions for apps accessing sensitive data.',
    category: 'system',
    displayName: 'TCC Daemon'
  },
  'trustd': {
    description: 'macOS Trust daemon - handles certificate trust evaluation and security policy decisions.',
    category: 'system',
    displayName: 'Trust Daemon'
  },
  'securityd': {
    description: 'macOS Security daemon - manages keychain access, code signing verification, and security services.',
    category: 'system',
    displayName: 'Security Daemon'
  },
  'WindowServer': {
    description: 'macOS Window Server - the core process that manages the display, windows, and graphical user interface.',
    category: 'system',
    displayName: 'Window Server'
  },
  'WindowServe': {  // Truncated version
    description: 'macOS Window Server - the core process that manages the display, windows, and graphical user interface.',
    category: 'system',
    displayName: 'Window Server'
  },
  'Finder': {
    description: 'macOS Finder - the default file manager that provides the desktop and file browsing experience.',
    category: 'system',
    displayName: 'Finder'
  },
  'Dock': {
    description: 'macOS Dock - provides the application dock, Launchpad, and window management features.',
    category: 'system',
    displayName: 'Dock'
  },
  'SystemUIServer': {
    description: 'macOS System UI Server - manages menu bar extras, system dialogs, and UI elements.',
    category: 'system',
    displayName: 'System UI Server'
  },
  'SystemUISe': {  // Truncated version
    description: 'macOS System UI Server - manages menu bar extras, system dialogs, and UI elements.',
    category: 'system',
    displayName: 'System UI Server'
  },
  'NotificationCenter': {
    description: 'macOS Notification Center - displays and manages notifications from apps and system services.',
    category: 'system',
    displayName: 'Notification Center'
  },
  'Notificati': {  // Truncated version
    description: 'macOS Notification Center - displays and manages notifications from apps and system services.',
    category: 'system',
    displayName: 'Notification Center'
  },
  'Spotlight': {
    description: 'macOS Spotlight - provides system-wide search, app launching, and quick calculations.',
    category: 'system',
    displayName: 'Spotlight'
  },
  'mds': {
    description: 'macOS Metadata Server - indexes files for Spotlight search and manages file metadata.',
    category: 'system',
    displayName: 'Metadata Server'
  },
  'mds_stores': {
    description: 'macOS Metadata Server Stores - manages the Spotlight search index database.',
    category: 'system',
    displayName: 'Metadata Stores'
  },
  'kernel_task': {
    description: 'macOS Kernel Task - the core operating system process that manages hardware, memory, and system resources.',
    category: 'system',
    displayName: 'Kernel Task'
  },
  // Common development tools
  'node': {
    description: 'Node.js runtime - JavaScript runtime built on Chrome\'s V8 engine for building server-side applications.',
    category: 'development',
    displayName: 'Node.js'
  },
  'python': {
    description: 'Python interpreter - a versatile programming language used for web development, scripting, and data science.',
    category: 'development',
    displayName: 'Python'
  },
  'python3': {
    description: 'Python 3 interpreter - the modern version of Python with improved syntax and features.',
    category: 'development',
    displayName: 'Python 3'
  },
  'ruby': {
    description: 'Ruby interpreter - a dynamic programming language focused on simplicity and productivity.',
    category: 'development',
    displayName: 'Ruby'
  },
  'java': {
    description: 'Java Virtual Machine - runs Java applications with cross-platform compatibility.',
    category: 'development',
    displayName: 'Java'
  },
  'postgres': {
    description: 'PostgreSQL - a powerful, open-source relational database system.',
    category: 'database',
    displayName: 'PostgreSQL'
  },
  'mysqld': {
    description: 'MySQL Server - a popular open-source relational database management system.',
    category: 'database',
    displayName: 'MySQL'
  },
  'mongod': {
    description: 'MongoDB Server - a NoSQL document database for modern applications.',
    category: 'database',
    displayName: 'MongoDB'
  },
  'redis-server': {
    description: 'Redis Server - an in-memory data structure store used as database, cache, and message broker.',
    category: 'cache',
    displayName: 'Redis'
  },
  'nginx': {
    description: 'Nginx - a high-performance web server, reverse proxy, and load balancer.',
    category: 'webserver',
    displayName: 'Nginx'
  },
  'httpd': {
    description: 'Apache HTTP Server - a widely-used open-source web server.',
    category: 'webserver',
    displayName: 'Apache'
  },
  'Docker': {
    description: 'Docker Desktop - container platform for building, sharing, and running containerized applications.',
    category: 'container',
    displayName: 'Docker'
  },
  'com.docker.backend': {
    description: 'Docker Backend - the background service that manages Docker containers and images.',
    category: 'container',
    displayName: 'Docker Backend'
  },
  'com.docker': {  // Truncated version
    description: 'Docker Backend - the background service that manages Docker containers and images.',
    category: 'container',
    displayName: 'Docker Backend'
  },
};

function extractAppNameFromCommand(command = '') {
  if (!command) return null;
  const appMatch = command.match(/\/Applications\/([^/]+)\.app\//i)
    || command.match(/\/System\/Applications\/([^/]+)\.app\//i)
    || command.match(/\/Users\/[^/]+\/Applications\/([^/]+)\.app\//i);
  if (appMatch && appMatch[1]) {
    return appMatch[1];
  }
  return null;
}

/**
 * Get service info (description and display name) for a known service
 */
function getServiceInfo(processName, command = '') {
  if (!processName) return null;

  // Normalize the process name: trim whitespace and convert to lowercase
  const name = processName.trim().toLowerCase();
  if (!name) return null;

  // Extract base name if it looks like a path (e.g., /usr/sbin/rapportd -> rapportd)
  const baseName = name.includes('/') ? name.split('/').pop() : name;
  const appName = extractAppNameFromCommand(command);
  const appKey = appName ? appName.trim().toLowerCase() : null;

  const shouldLog = process.env.FERE_DEBUG_SERVICE_INFO === '1';
  if (shouldLog) {
    console.log('[getServiceInfo] Looking up:', { processName, name, baseName });
  }

  // Check direct match first (case-sensitive)
  if (KNOWN_SERVICES[processName]) {
    if (shouldLog) console.log('[getServiceInfo] Direct match found for:', processName);
    return KNOWN_SERVICES[processName];
  }

  // Check lowercase match
  if (KNOWN_SERVICES[name]) {
    if (shouldLog) console.log('[getServiceInfo] Lowercase match found for:', name);
    return KNOWN_SERVICES[name];
  }

  // Check base name match
  if (baseName && KNOWN_SERVICES[baseName]) {
    if (shouldLog) console.log('[getServiceInfo] Base name match found for:', baseName);
    return KNOWN_SERVICES[baseName];
  }

  // Check app name inferred from command path
  if (appKey && KNOWN_SERVICES[appKey]) {
    if (shouldLog) console.log('[getServiceInfo] App name match found for:', appKey);
    return KNOWN_SERVICES[appKey];
  }

  // Check case-insensitive match against all keys
  for (const [key, value] of Object.entries(KNOWN_SERVICES)) {
    const keyLower = key.toLowerCase();
    if (keyLower === name || keyLower === baseName || (appKey && keyLower === appKey)) {
      if (shouldLog) console.log('[getServiceInfo] Case-insensitive match found:', key);
      return value;
    }
  }

  // Check partial match - both directions
  // This handles truncated names (e.g., "commcen" matching "commcente")
  for (const [key, value] of Object.entries(KNOWN_SERVICES)) {
    const keyLower = key.toLowerCase();
    // Check if name starts with key or key starts with name (handles truncation)
    if (name.startsWith(keyLower) || keyLower.startsWith(name)) {
      if (shouldLog) console.log('[getServiceInfo] Prefix match found:', key, 'for', name);
      return value;
    }
    if (baseName && (baseName.startsWith(keyLower) || keyLower.startsWith(baseName))) {
      if (shouldLog) console.log('[getServiceInfo] Base prefix match found:', key, 'for', baseName);
      return value;
    }
    // Check substring matching
    if (name.includes(keyLower) || keyLower.includes(name)) {
      if (shouldLog) console.log('[getServiceInfo] Substring match found:', key, 'for', name);
      return value;
    }
  }

  if (shouldLog) console.log('[getServiceInfo] No match found for:', processName);
  return null;
}

/**
 * Get description for a known service
 */
function getServiceDescription(processName, command = '') {
  const info = getServiceInfo(processName, command);
  return info?.description || null;
}

function formatScriptLabel(scriptName) {
  const base = scriptName.replace(/\.[a-z0-9]+$/i, '');
  return base
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Get display name for a known service (falls back to process name)
 */
function getServiceDisplayName(processName, command = '') {
  if (processName && processName.includes(':')) {
    const [, scriptPart] = processName.split(':').map(part => part.trim());
    if (scriptPart) {
      return formatScriptLabel(scriptPart);
    }
  }
  const info = getServiceInfo(processName, command);
  return info?.displayName || processName;
}

/**
 * Build a complete picture of the local dev environment
 * Returns nodes (processes/services) and edges (connections between them)
 */
async function buildConnectionGraph(snapshot = null) {
  const processes = snapshot?.processes || await getDevProcesses();
  const ports = snapshot?.ports || await getListeningPorts();
  const connections = snapshot?.connections || await getEstablishedConnections();

  // Update health tracking with current snapshot
  updateHealthTracking({ processes, ports, connections });

  // Build a set of PIDs with active connections for health status
  const pidsWithConnections = new Set();
  for (const conn of connections) {
    pidsWithConnections.add(conn.pid);
  }

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
    const rawName = proc ? proc.name : fallbackProcess;
    const command = proc ? proc.command : fallbackProcess;
    // Use display name if available (handles truncated macOS process names)
    const name = getServiceDisplayName(rawName, command);

    // Calculate health status
    const isListening = portProcessByPid.has(pid);
    const hasConnections = pidsWithConnections.has(pid);
    const { healthStatus, lastSeen } = getHealthStatus(pid, isListening, hasConnections);

    const node = {
      id: `proc-${pid}`,
      pid,
      name,
      command,
      type: categorizeProcess(rawName, command),
      cpu: proc?.cpu || 0,
      memory: proc?.memory || 0,
      user: proc?.user || portUserByPid.get(pid) || 'unknown',
      tty: proc?.tty || null,
      project: null,
      projectPath: null,
      description: getServiceDescription(rawName, command),
      ports: [],
      routes: [],
      healthStatus,
      lastSeen,
    };

    nodes.push(node);
    nodesByPid.set(pid, node);
    return node;
  };

  // First pass: build lookup maps and deduplicate by port number
  // This handles cases like Flask debug mode where both reloader and server show up
  const seenPorts = new Set();
  for (const port of ports) {
    portToPid.set(port.port, port.pid);
    if (!portProcessByPid.has(port.pid)) {
      portProcessByPid.set(port.pid, port.process);
      portUserByPid.set(port.pid, port.user);
    }
  }

  // Second pass: create nodes, but only one node per unique port number
  for (const port of ports) {
    // Skip if we've already processed this port number (deduplicate)
    if (seenPorts.has(port.port)) continue;
    seenPorts.add(port.port);

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

    // External nodes are always yellow (we can't track their health)
    const { healthStatus, lastSeen } = getHealthStatus(-1, true, true);

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
      projectPath: null,
      ports: [{
        port,
        host,
        description: null,
      }],
      routes: [],
      healthStatus,
      lastSeen,
    };

    nodes.push(node);
    externalNodes.set(key, node);
    return node;
  };

  for (const conn of connections) {
    const sourceProc = processMap.get(conn.pid);
    if (!sourceProc) continue;

    const sourceNode = ensureProcessNode(conn.pid, conn.process);
    const targetPid = isLocalHost(conn.remoteHost) ? portToPid.get(conn.remotePort) : null;
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

  // OPTIMIZATION: Parallelize route attachment and Docker snapshot
  // These operations are independent and can run concurrently
  const startParallel = Date.now();
  const [dockerSnapshot] = await Promise.all([
    getDockerSnapshot(),
    attachRoutesToNodes(nodes),
  ]);
  perfLog('Parallel operations (routes + docker)', Date.now() - startParallel);

  // Add Docker containers as nodes
  if (dockerSnapshot.isAvailable && dockerSnapshot.containers.length > 0) {
    const startDocker = Date.now();
    addDockerContainerNodes(nodes, edges, dockerSnapshot, nodesByPid, portToPid);
    perfLog('Add Docker container nodes', Date.now() - startDocker);
  }

  return { nodes, edges, dockerSnapshot };
}

/**
 * Categorize a process into a type for visualization
 */
function categorizeProcess(processName, command = '') {
  const name = processName.toLowerCase();
  const cmd = command.toLowerCase();

  if (cmd.includes('postgres-client-mock')) {
    return 'database';
  }
  if (cmd.includes('broker-mock') || cmd.includes('nats')) {
    return 'broker';
  }
  if (cmd.includes('ws-server-mock')) {
    return 'realtime';
  }
  if (cmd.includes('ws-client-mock')) {
    return 'client';
  }
  if (cmd.includes('http-client-mock')) {
    return 'client';
  }
  if (cmd.includes('worker-mock')) {
    return 'worker';
  }

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

function isLocalHost(host = '') {
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0' ||
    normalized === '::'
  );
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

const PROJECT_MARKERS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'Makefile',
];

function findProjectRoot(startPath) {
  let current = startPath;
  if (!current) return null;

  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) {
      current = path.dirname(current);
    }
  } catch (error) {
    return null;
  }

  // Prefer the closest git root if present.
  let probe = current;
  let probePrev = null;
  while (probe && probe !== probePrev) {
    if (fs.existsSync(path.join(probe, '.git'))) {
      return probe;
    }
    probePrev = probe;
    probe = path.dirname(probe);
  }

  let previous = null;
  while (current && current !== previous) {
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) {
        return current;
      }
    }
    previous = current;
    current = path.dirname(current);
  }

  return null;
}

function inferProjectPathFromCommand(command = '') {
  const tokens = command.split(/\s+/);
  const candidates = [];

  for (const token of tokens) {
    if (token.startsWith('/Users/') || token.startsWith('/home/')) {
      const cleaned = token.replace(/[",']/g, '');
      candidates.push(cleaned);
    }
  }

  for (const candidate of candidates) {
    const projectRoot = findProjectRoot(candidate);
    if (projectRoot) {
      return projectRoot;
    }
  }

  return null;
}

/**
 * Add Docker containers as graph nodes and create edges for container networking
 */
function addDockerContainerNodes(nodes, edges, dockerSnapshot, nodesByPid, portToPid) {
  const { containers, containerConnections } = dockerSnapshot;
  const containerNodesById = new Map();

  // Create nodes for each Docker container
  for (const container of containers) {
    const nodeId = `docker-${container.id}`;

    // Check if we should merge with an existing node (e.g., if container has a mapped port
    // that matches a native process port - unlikely but possible with port forwarding)
    const existingNode = findMatchingNativeNode(container, nodes);
    if (existingNode) {
      // Enhance existing node with Docker info
      enhanceNodeWithDockerInfo(existingNode, container);
      containerNodesById.set(container.id, existingNode);
      continue;
    }

    // Convert container ports to graph port format
    const graphPorts = container.ports
      .filter(p => p.hostPort) // Only show mapped ports
      .map(p => ({
        port: p.hostPort,
        host: p.hostIp || '0.0.0.0',
        description: `Container port ${p.containerPort}/${p.protocol}`,
      }));

    // Determine node type based on container image
    const nodeType = categorizeContainerImage(container.image);

    // Create the Docker container node
    // Infer projectPath from Docker Compose labels or bind mounts
    const containerProjectPath = inferProjectPathFromContainer(container);
    const containerProject = containerProjectPath
      ? path.basename(containerProjectPath)
      : extractProjectFromContainerName(container.name);

    const node = {
      id: nodeId,
      pid: -1, // Docker containers don't have a direct PID in host context
      name: container.name,
      command: `docker: ${container.image}`,
      type: nodeType,
      cpu: container.cpu || 0,
      memory: container.memory || 0,
      user: 'docker',
      tty: null,
      project: containerProject,
      projectPath: containerProjectPath,
      description: `Docker container running ${container.image}`,
      ports: graphPorts,
      routes: [],
      healthStatus: containerHealthToGraphHealth(container),
      lastSeen: Date.now(),
      // Docker-specific properties
      isDockerContainer: true,
      containerId: container.id,
      containerImage: container.image,
      containerState: container.state,
      containerStatus: container.status,
      containerHealth: container.health,
      containerNetworks: container.networks,
      containerMounts: container.mounts,
      containerPorts: container.ports,
      memoryUsage: container.memoryUsage,
    };

    nodes.push(node);
    containerNodesById.set(container.id, node);

    // Register mapped ports so native processes can connect to containers
    for (const port of container.ports) {
      if (port.hostPort) {
        portToPid.set(port.hostPort, nodeId);
      }
    }
  }

  // Create edges for container-to-container connections (shared networks)
  const edgeSet = new Set(edges.map(e => e.id));
  for (const conn of containerConnections) {
    const sourceNode = containerNodesById.get(conn.sourceContainerId);
    const targetNode = containerNodesById.get(conn.targetContainerId);

    if (!sourceNode || !targetNode) continue;

    const edgeId = `docker-network-${conn.sourceContainerId.substring(0, 12)}-${conn.targetContainerId.substring(0, 12)}`;
    if (edgeSet.has(edgeId)) continue;

    edgeSet.add(edgeId);
    edges.push({
      id: edgeId,
      source: sourceNode.id,
      target: targetNode.id,
      sourcePort: 0, // Network-level connection, no specific port
      targetPort: 0,
      protocol: `docker-network:${conn.networkName}`,
    });
  }
}

/**
 * Find a native process node that might correspond to a Docker container
 * (e.g., if they're using the same mapped port)
 */
function findMatchingNativeNode(container, nodes) {
  // Look for a node that has the same mapped port
  for (const port of container.ports) {
    if (port.hostPort) {
      const matchingNode = nodes.find(n =>
        !n.isDockerContainer &&
        n.ports.some(p => p.port === port.hostPort)
      );
      if (matchingNode) return matchingNode;
    }
  }
  return null;
}

/**
 * Enhance an existing native node with Docker container information
 */
function enhanceNodeWithDockerInfo(node, container) {
  node.isDockerContainer = true;
  node.containerId = container.id;
  node.containerImage = container.image;
  node.containerState = container.state;
  node.containerStatus = container.status;
  node.containerHealth = container.health;
  node.containerNetworks = container.networks;
  node.containerMounts = container.mounts;
  node.containerPorts = container.ports;
  node.memoryUsage = container.memoryUsage;
  // Update description
  node.description = `Docker container: ${container.image}`;
}

/**
 * Categorize container image into a node type
 */
function categorizeContainerImage(image) {
  const imageLower = image.toLowerCase();

  // Databases
  if (imageLower.includes('postgres') || imageLower.includes('pg')) return 'database';
  if (imageLower.includes('mysql') || imageLower.includes('mariadb')) return 'database';
  if (imageLower.includes('mongo')) return 'database';
  if (imageLower.includes('sqlite')) return 'database';

  // Cache/Memory stores
  if (imageLower.includes('redis')) return 'cache';
  if (imageLower.includes('memcached')) return 'cache';

  // Message brokers
  if (imageLower.includes('rabbitmq')) return 'broker';
  if (imageLower.includes('kafka')) return 'broker';
  if (imageLower.includes('nats')) return 'broker';

  // Web servers
  if (imageLower.includes('nginx')) return 'webserver';
  if (imageLower.includes('apache') || imageLower.includes('httpd')) return 'webserver';
  if (imageLower.includes('traefik')) return 'webserver';
  if (imageLower.includes('haproxy')) return 'webserver';

  // Frontend
  if (imageLower.includes('node') && (imageLower.includes('react') || imageLower.includes('vue') || imageLower.includes('angular'))) {
    return 'frontend';
  }

  // Python backends
  if (imageLower.includes('python') || imageLower.includes('django') || imageLower.includes('flask') || imageLower.includes('fastapi')) {
    return 'backend';
  }

  // Node backends
  if (imageLower.includes('node') || imageLower.includes('express') || imageLower.includes('nestjs')) {
    return 'nodejs';
  }

  // Workers
  if (imageLower.includes('worker') || imageLower.includes('celery') || imageLower.includes('sidekiq')) {
    return 'worker';
  }

  // Default to container type
  return 'container';
}

/**
 * Extract project name from container name (e.g., "myproject_web_1" -> "myproject")
 */
function extractProjectFromContainerName(containerName) {
  // Docker Compose naming: project_service_number
  const composeMatch = containerName.match(/^([^_]+)_[^_]+_\d+$/);
  if (composeMatch) return composeMatch[1];

  // Try to extract meaningful project name from container name
  const cleanName = containerName.replace(/^\//, ''); // Remove leading slash
  const parts = cleanName.split(/[-_]/);
  if (parts.length > 1) {
    return parts[0];
  }

  return null;
}

/**
 * Infer projectPath from Docker container labels (Docker Compose) or bind mounts
 */
function inferProjectPathFromContainer(container) {
  // First, check Docker Compose labels - this is the most reliable source
  if (container.labels) {
    // Docker Compose v2 uses this label for the working directory
    const workingDir = container.labels['com.docker.compose.project.working_dir'];
    if (workingDir) {
      const projectRoot = findProjectRoot(workingDir);
      if (projectRoot) {
        return projectRoot;
      }
      // If no project markers found, use the working dir itself
      return workingDir;
    }
  }

  // Fallback: check bind mounts for project directories
  if (container.mounts && Array.isArray(container.mounts)) {
    for (const mount of container.mounts) {
      if (mount.type === 'bind' && mount.source) {
        const projectRoot = findProjectRoot(mount.source);
        if (projectRoot) {
          return projectRoot;
        }
      }
    }
  }

  return null;
}

async function attachRoutesToNodes(nodes) {
  const startRoutes = Date.now();
  const projects = new Map();
  const cwdByPid = new Map();

  // Collect known project paths
  for (const node of nodes) {
    if (node.projectPath) {
      projects.set(node.projectPath, null);
      if (!node.project) {
        node.project = path.basename(node.projectPath);
      }
    }
  }

  // Discover project paths from process CWDs
  const startCwd = Date.now();
  let cwdLookupCount = 0;
  for (const node of nodes) {
    if (node.pid <= 0) continue;
    cwdLookupCount++;
    const cwd = await getProcessCwd(node.pid, cwdByPid);
    if (!cwd) continue;
    const projectRoot = findProjectRoot(cwd);
    if (!projectRoot) continue;

    if (node.projectPath !== projectRoot) {
      node.projectPath = projectRoot;
    }
    node.project = path.basename(projectRoot);
    projects.set(projectRoot, null);
  }
  perfLog(`CWD lookups (${cwdLookupCount} processes)`, Date.now() - startCwd);

  // Scan routes for all projects in parallel
  const startScan = Date.now();
  const scanPromises = Array.from(projects.keys()).map(async (projectPath) => {
    try {
      const routes = await scanRoutes(projectPath);
      return { projectPath, routes };
    } catch (error) {
      return { projectPath, routes: [] };
    }
  });

  const scanResults = await Promise.all(scanPromises);
  for (const { projectPath, routes } of scanResults) {
    projects.set(projectPath, routes);
  }
  perfLog(`Route scanning (${projects.size} projects)`, Date.now() - startScan);

  // Attach routes to nodes
  for (const node of nodes) {
    if (!node.projectPath) continue;
    const routes = projects.get(node.projectPath) || [];
    node.routes = matchRoutesToService(routes, node);
  }

  for (const node of nodes) {
    if (!node.projectPath) {
      node.project = null;
    }
  }

  perfLog('Total route attachment', Date.now() - startRoutes);
}


async function getProcessCwd(pid, cache) {
  // Check per-request cache first
  if (cache.has(pid)) {
    return cache.get(pid);
  }

  // Check persistent cache (survives across polls)
  const persistentEntry = persistentCwdCache.get(pid);
  if (persistentEntry && Date.now() - persistentEntry.timestamp < CWD_CACHE_TTL_MS) {
    const cwd = persistentEntry.cwd;
    cache.set(pid, cwd); // Also populate per-request cache
    return cwd;
  }

  // Cache miss - fetch from system
  try {
    const { stdout } = await execAsync(`lsof -a -p ${pid} -d cwd -Fn`);
    const line = stdout.split('\n').find(entry => entry.startsWith('n'));
    const cwd = line ? line.slice(1).trim() : null;

    // Update both caches
    cache.set(pid, cwd);
    persistentCwdCache.set(pid, { cwd, timestamp: Date.now() });

    return cwd;
  } catch (error) {
    cache.set(pid, null);
    persistentCwdCache.set(pid, { cwd: null, timestamp: Date.now() });
    return null;
  }
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
  inferProjectPathFromCommand,
};
