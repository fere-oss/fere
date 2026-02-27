/**
 * Pure functions for graph building — shared between main thread and Worker.
 *
 * This module contains all CPU-bound, Worker-safe functions extracted from
 * connectionGraph.js. No child_process, no async I/O, no module-level mutable state.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { getPortDescription } = require('./portMonitor');
const { matchRoutesToService } = require('./routeScanner');

// ============================================
// Known Services Dictionary
// ============================================

const KNOWN_SERVICES = {
  'visual studio code': { description: 'Visual Studio Code - a code editor for development workflows.', category: 'developer', displayName: 'VS Code' },
  'code': { description: 'Visual Studio Code - a code editor for development workflows.', category: 'developer', displayName: 'VS Code' },
  'google chrome': { description: 'Google Chrome - web browser often used for local dev testing.', category: 'developer', displayName: 'Google Chrome' },
  'discord': { description: 'Discord - collaboration and chat client.', category: 'developer', displayName: 'Discord' },
  'electron': { description: 'Electron - runtime for desktop apps built with web tech.', category: 'developer', displayName: 'Electron' },
  'next-server': { description: 'Next.js dev server.', category: 'frontend', displayName: 'Next.js Dev Server' },
  'controlcenter': { description: 'macOS Control Center daemon - manages Control Center widgets, toggles, and system controls like Wi-Fi, Bluetooth, Do Not Disturb, and AirDrop.', category: 'system', displayName: 'Control Center' },
  'controlce': { description: 'macOS Control Center daemon - manages Control Center widgets, toggles, and system controls like Wi-Fi, Bluetooth, Do Not Disturb, and AirDrop.', category: 'system', displayName: 'Control Center' },
  'commcenter': { description: 'macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.', category: 'system', displayName: 'CommCenter' },
  'commcentre': { description: 'macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.', category: 'system', displayName: 'CommCenter' },
  'commcente': { description: 'macOS Communications Center - handles cellular, SMS, MMS, and phone-related communications for devices with cellular capability.', category: 'system', displayName: 'CommCenter' },
  'airportd': { description: 'macOS AirPort daemon - manages Wi-Fi connections, network scanning, and wireless network configuration.', category: 'system', displayName: 'AirPort Daemon' },
  'bluetoothd': { description: 'macOS Bluetooth daemon - handles Bluetooth device pairing, connections, and communication.', category: 'system', displayName: 'Bluetooth Daemon' },
  'configd': { description: 'macOS System Configuration daemon - monitors and manages system configuration, network settings, and dynamic store.', category: 'system', displayName: 'Config Daemon' },
  'coreaudiod': { description: 'macOS Core Audio daemon - manages audio routing, device selection, and audio processing for the system.', category: 'system', displayName: 'Core Audio' },
  'distnoted': { description: 'macOS Distributed Notification daemon - handles inter-process notifications and communication between apps.', category: 'system', displayName: 'Distributed Notifications' },
  'fseventsd': { description: 'macOS File System Events daemon - monitors file system changes and provides notifications to apps watching for changes.', category: 'system', displayName: 'FS Events' },
  'launchd': { description: 'macOS Launch daemon - the master process manager that starts and manages all system and user services.', category: 'system', displayName: 'launchd' },
  'mDNSResponder': { description: 'macOS Multicast DNS Responder - handles Bonjour service discovery, local network name resolution, and zero-configuration networking.', category: 'network', displayName: 'mDNS Responder' },
  'mDNSRespon': { description: 'macOS Multicast DNS Responder - handles Bonjour service discovery, local network name resolution, and zero-configuration networking.', category: 'network', displayName: 'mDNS Responder' },
  'netbiosd': { description: 'macOS NetBIOS daemon - provides Windows network compatibility for file sharing and network browsing.', category: 'network', displayName: 'NetBIOS Daemon' },
  'rapportd': { description: 'macOS Rapport daemon - enables device-to-device communication for features like Universal Clipboard, Handoff, and AirDrop.', category: 'system', displayName: 'Rapport Daemon' },
  'sharingd': { description: 'macOS Sharing daemon - manages AirDrop, Handoff, Shared Clipboard, and other device sharing features.', category: 'system', displayName: 'Sharing Daemon' },
  'symptomsd': { description: 'macOS Symptoms daemon - collects network diagnostics and performance data to improve connectivity.', category: 'system', displayName: 'Symptoms Daemon' },
  'UserEventAgent': { description: 'macOS User Event Agent - monitors and responds to user-level system events like display sleep, wake, and login.', category: 'system', displayName: 'User Event Agent' },
  'UserEventAg': { description: 'macOS User Event Agent - monitors and responds to user-level system events like display sleep, wake, and login.', category: 'system', displayName: 'User Event Agent' },
  'WiFiAgent': { description: 'macOS Wi-Fi Agent - manages the Wi-Fi menu bar item and user-facing Wi-Fi controls.', category: 'network', displayName: 'Wi-Fi Agent' },
  'identityservicesd': { description: 'macOS Identity Services daemon - handles iCloud account authentication, iMessage, and FaceTime identity.', category: 'system', displayName: 'Identity Services' },
  'identityse': { description: 'macOS Identity Services daemon - handles iCloud account authentication, iMessage, and FaceTime identity.', category: 'system', displayName: 'Identity Services' },
  'cloudd': { description: 'macOS CloudKit daemon - manages iCloud data synchronization and CloudKit framework operations.', category: 'system', displayName: 'CloudKit Daemon' },
  'nsurlsessiond': { description: 'macOS URL Session daemon - handles background network transfers and downloads for apps.', category: 'network', displayName: 'NSURLSession Daemon' },
  'nsurlsessi': { description: 'macOS URL Session daemon - handles background network transfers and downloads for apps.', category: 'network', displayName: 'NSURLSession Daemon' },
  'apsd': { description: 'macOS Apple Push Services daemon - manages push notifications from Apple services and third-party apps.', category: 'network', displayName: 'Apple Push Services' },
  'locationd': { description: 'macOS Location Services daemon - provides location data to apps and manages location privacy.', category: 'system', displayName: 'Location Services' },
  'coreduetd': { description: 'macOS Core Duet daemon - tracks app usage patterns to improve Siri suggestions and system intelligence.', category: 'system', displayName: 'Core Duet' },
  'suggestd': { description: 'macOS Suggestions daemon - provides intelligent suggestions in Spotlight, Siri, and other system features.', category: 'system', displayName: 'Suggestions Daemon' },
  'tccd': { description: 'macOS Transparency, Consent, and Control daemon - manages privacy permissions for apps accessing sensitive data.', category: 'system', displayName: 'TCC Daemon' },
  'trustd': { description: 'macOS Trust daemon - handles certificate trust evaluation and security policy decisions.', category: 'system', displayName: 'Trust Daemon' },
  'securityd': { description: 'macOS Security daemon - manages keychain access, code signing verification, and security services.', category: 'system', displayName: 'Security Daemon' },
  'WindowServer': { description: 'macOS Window Server - the core process that manages the display, windows, and graphical user interface.', category: 'system', displayName: 'Window Server' },
  'WindowServe': { description: 'macOS Window Server - the core process that manages the display, windows, and graphical user interface.', category: 'system', displayName: 'Window Server' },
  'Finder': { description: 'macOS Finder - the default file manager that provides the desktop and file browsing experience.', category: 'system', displayName: 'Finder' },
  'Dock': { description: 'macOS Dock - provides the application dock, Launchpad, and window management features.', category: 'system', displayName: 'Dock' },
  'SystemUIServer': { description: 'macOS System UI Server - manages menu bar extras, system dialogs, and UI elements.', category: 'system', displayName: 'System UI Server' },
  'SystemUISe': { description: 'macOS System UI Server - manages menu bar extras, system dialogs, and UI elements.', category: 'system', displayName: 'System UI Server' },
  'NotificationCenter': { description: 'macOS Notification Center - displays and manages notifications from apps and system services.', category: 'system', displayName: 'Notification Center' },
  'Notificati': { description: 'macOS Notification Center - displays and manages notifications from apps and system services.', category: 'system', displayName: 'Notification Center' },
  'Spotlight': { description: 'macOS Spotlight - provides system-wide search, app launching, and quick calculations.', category: 'system', displayName: 'Spotlight' },
  'mds': { description: 'macOS Metadata Server - indexes files for Spotlight search and manages file metadata.', category: 'system', displayName: 'Metadata Server' },
  'mds_stores': { description: 'macOS Metadata Server Stores - manages the Spotlight search index database.', category: 'system', displayName: 'Metadata Stores' },
  'kernel_task': { description: 'macOS Kernel Task - the core operating system process that manages hardware, memory, and system resources.', category: 'system', displayName: 'Kernel Task' },
  'node': { description: 'Node.js runtime - JavaScript runtime built on Chrome\'s V8 engine for building server-side applications.', category: 'development', displayName: 'Node.js' },
  'python': { description: 'Python interpreter - a versatile programming language used for web development, scripting, and data science.', category: 'development', displayName: 'Python' },
  'python3': { description: 'Python 3 interpreter - the modern version of Python with improved syntax and features.', category: 'development', displayName: 'Python 3' },
  'ruby': { description: 'Ruby interpreter - a dynamic programming language focused on simplicity and productivity.', category: 'development', displayName: 'Ruby' },
  'java': { description: 'Java Virtual Machine - runs Java applications with cross-platform compatibility.', category: 'development', displayName: 'Java' },
  'postgres': { description: 'PostgreSQL - a powerful, open-source relational database system.', category: 'database', displayName: 'PostgreSQL' },
  'mysqld': { description: 'MySQL Server - a popular open-source relational database management system.', category: 'database', displayName: 'MySQL' },
  'mongod': { description: 'MongoDB Server - a NoSQL document database for modern applications.', category: 'database', displayName: 'MongoDB' },
  'redis-server': { description: 'Redis Server - an in-memory data structure store used as database, cache, and message broker.', category: 'cache', displayName: 'Redis' },
  'nginx': { description: 'Nginx - a high-performance web server, reverse proxy, and load balancer.', category: 'webserver', displayName: 'Nginx' },
  'httpd': { description: 'Apache HTTP Server - a widely-used open-source web server.', category: 'webserver', displayName: 'Apache' },
  'Docker': { description: 'Docker Desktop - container platform for building, sharing, and running containerized applications.', category: 'container', displayName: 'Docker' },
  'com.docker.backend': { description: 'Docker Backend - the background service that manages Docker containers and images.', category: 'container', displayName: 'Docker Backend' },
  'com.docker': { description: 'Docker Backend - the background service that manages Docker containers and images.', category: 'container', displayName: 'Docker Backend' },
};

// ============================================
// Service Info / Display Name Functions
// ============================================

// Pre-compute lowercase lookup map — avoids re-lowercasing KNOWN_SERVICES keys
// on every getServiceInfo call (hot path during graph building)
const KNOWN_SERVICES_LOWER = new Map();
for (const [key, value] of Object.entries(KNOWN_SERVICES)) {
  KNOWN_SERVICES_LOWER.set(key.toLowerCase(), value);
}
// Pre-compute sorted keys for prefix/substring matching (longest first for better matches)
const KNOWN_SERVICES_KEYS_SORTED = [...KNOWN_SERVICES_LOWER.keys()]
  .sort((a, b) => b.length - a.length);

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

function getServiceInfo(processName, command = '') {
  if (!processName) return null;
  const name = processName.trim().toLowerCase();
  if (!name) return null;

  const baseName = name.includes('/') ? name.split('/').pop() : name;
  const appName = extractAppNameFromCommand(command);
  const appKey = appName ? appName.trim().toLowerCase() : null;

  // Fast exact lookup via pre-computed lowercase Map
  let result = KNOWN_SERVICES_LOWER.get(name);
  if (result) return result;
  if (baseName) {
    result = KNOWN_SERVICES_LOWER.get(baseName);
    if (result) return result;
  }
  if (appKey) {
    result = KNOWN_SERVICES_LOWER.get(appKey);
    if (result) return result;
  }

  // Prefix/substring matching using pre-sorted keys
  for (const keyLower of KNOWN_SERVICES_KEYS_SORTED) {
    if (name.startsWith(keyLower) || keyLower.startsWith(name)) return KNOWN_SERVICES_LOWER.get(keyLower);
    if (baseName && (baseName.startsWith(keyLower) || keyLower.startsWith(baseName))) return KNOWN_SERVICES_LOWER.get(keyLower);
    if (name.includes(keyLower) || keyLower.includes(name)) return KNOWN_SERVICES_LOWER.get(keyLower);
  }

  return null;
}

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

function getServiceDisplayName(processName, command = '') {
  if (processName && processName.includes(':')) {
    const [, scriptPart] = processName.split(':').map(part => part.trim());
    if (scriptPart) return formatScriptLabel(scriptPart);
  }
  const info = getServiceInfo(processName, command);
  return info?.displayName || processName;
}

// ============================================
// Process / Container Classification
// ============================================

function categorizeProcess(processName, command = '') {
  const name = processName.toLowerCase();
  const cmd = command.toLowerCase();

  if (cmd.includes('postgres-client-mock')) return 'database';
  if (cmd.includes('broker-mock') || cmd.includes('nats')) return 'broker';
  if (cmd.includes('ws-server-mock')) return 'realtime';
  if (cmd.includes('ws-client-mock')) return 'client';
  if (cmd.includes('http-client-mock')) return 'client';
  if (cmd.includes('worker-mock')) return 'worker';

  if (name.includes('postgres') || name.includes('psql') || cmd.includes('postgres')) return 'database';
  if (name.includes('mysql') || cmd.includes('mysql')) return 'database';
  if (name.includes('mongo') || cmd.includes('mongo')) return 'database';
  if (name.includes('redis') || cmd.includes('redis')) return 'cache';

  if (name.includes('nginx') || name.includes('apache') || name.includes('httpd')) return 'webserver';
  if (name.includes('docker') || name.includes('podman')) return 'container';

  if (cmd.includes('webpack') || cmd.includes('vite') || cmd.includes('next') ||
      cmd.includes('react-scripts') || cmd.includes('parcel')) return 'frontend';

  if (cmd.includes('uvicorn') || cmd.includes('gunicorn') || cmd.includes('flask') ||
      cmd.includes('django') || cmd.includes('fastapi')) return 'backend';
  if (cmd.includes('express') || cmd.includes('nestjs') || cmd.includes('fastify')) return 'backend';
  if (cmd.includes('go run') || cmd.includes('/go-build') ||
      cmd.includes('gin') || cmd.includes('echo') ||
      cmd.includes('chi')) return 'backend';
  if (cmd.includes('rails') || cmd.includes('puma') || cmd.includes('unicorn') ||
      cmd.includes('passenger')) return 'backend';
  if (cmd.includes('spring') || cmd.includes('tomcat') || cmd.includes('jetty')) return 'backend';
  if (cmd.includes('artisan serve') || cmd.includes('laravel')) return 'backend';

  // Message brokers
  if (name.includes('rabbitmq') || cmd.includes('rabbitmq') || cmd.includes('rabbit')) return 'broker';
  if (name.includes('kafka') || cmd.includes('kafka')) return 'broker';
  if (name.includes('zookeeper') || cmd.includes('zookeeper')) return 'broker';
  if (name.includes('activemq') || cmd.includes('activemq')) return 'broker';

  // Caching
  if (name.includes('memcached') || cmd.includes('memcached')) return 'cache';

  // Search engines (data stores — categorized as database)
  if (name.includes('elasticsearch') || cmd.includes('elasticsearch')) return 'database';
  if (name.includes('opensearch') || cmd.includes('opensearch')) return 'database';
  if (name.includes('meilisearch') || cmd.includes('meilisearch')) return 'database';
  if (name.includes('solr') || cmd.includes('solr')) return 'database';

  // Workers / background jobs
  if (cmd.includes('celery') || cmd.includes('sidekiq') || cmd.includes('resque')) return 'worker';

  // Proxy / load balancer
  if (name.includes('traefik') || name.includes('haproxy') || name.includes('envoy')) return 'webserver';

  if (name.includes('node')) return 'nodejs';
  if (name.includes('python')) return 'python';
  if (name.includes('java') || name.includes('java')) return 'backend';
  if (name.includes('ruby') || name.includes('php')) return 'backend';

  return 'service';
}

function categorizeContainerImage(image) {
  const imageLower = image.toLowerCase();
  if (imageLower.includes('postgres') || imageLower.includes('pg')) return 'database';
  if (imageLower.includes('mysql') || imageLower.includes('mariadb')) return 'database';
  if (imageLower.includes('mongo')) return 'database';
  if (imageLower.includes('sqlite')) return 'database';
  if (imageLower.includes('redis')) return 'cache';
  if (imageLower.includes('memcached')) return 'cache';
  if (imageLower.includes('rabbitmq')) return 'broker';
  if (imageLower.includes('kafka')) return 'broker';
  if (imageLower.includes('nats')) return 'broker';
  if (imageLower.includes('zookeeper')) return 'broker';
  if (imageLower.includes('nginx')) return 'webserver';
  if (imageLower.includes('apache') || imageLower.includes('httpd')) return 'webserver';
  if (imageLower.includes('traefik')) return 'webserver';
  if (imageLower.includes('haproxy')) return 'webserver';
  if (imageLower.includes('node') && (imageLower.includes('react') || imageLower.includes('vue') || imageLower.includes('angular'))) return 'frontend';
  if (imageLower.includes('python') || imageLower.includes('django') || imageLower.includes('flask') || imageLower.includes('fastapi')) return 'python';
  if (imageLower.includes('node') || imageLower.includes('express') || imageLower.includes('nestjs')) return 'nodejs';
  if (imageLower.includes('worker') || imageLower.includes('celery') || imageLower.includes('sidekiq') ||
      imageLower.includes('resque')) return 'worker';

  // Search engines (data stores)
  if (imageLower.includes('elasticsearch') || imageLower.includes('opensearch')) return 'database';
  if (imageLower.includes('meilisearch') || imageLower.includes('solr') || imageLower.includes('typesense')) return 'database';

  // Additional brokers
  if (imageLower.includes('activemq') || imageLower.includes('pulsar') || imageLower.includes('mosquitto')) return 'broker';

  // Object storage
  if (imageLower.includes('minio') || imageLower.includes('localstack')) return 'database';

  // Proxy / load balancer
  if (imageLower.includes('envoy') || imageLower.includes('caddy')) return 'webserver';

  // Infrastructure services
  if (imageLower.includes('vault') || imageLower.includes('consul') || imageLower.includes('etcd')) return 'service';
  if (imageLower.includes('keycloak') || imageLower.includes('authelia')) return 'service';
  if (imageLower.includes('prometheus') || imageLower.includes('grafana') || imageLower.includes('jaeger')) return 'service';
  if (imageLower.includes('mailhog') || imageLower.includes('mailpit') || imageLower.includes('mailtrap')) return 'service';

  // Language runtimes
  if (imageLower.includes('ruby') || imageLower.includes('rails')) return 'backend';
  if (imageLower.includes('php') || imageLower.includes('laravel')) return 'backend';
  if (imageLower.includes('golang') || imageLower.includes('go:')) return 'backend';
  if (imageLower.includes('openjdk') || imageLower.includes('java') || imageLower.includes('spring')) return 'backend';

  return 'container';
}

// Hoisted to module level — avoids Set recreation on every call
const ALLOWED_CONTAINER_TYPES = new Set([
  'frontend', 'backend', 'webserver', 'database', 'cache', 'nodejs',
  'python', 'container', 'broker', 'realtime', 'worker', 'client',
  'service', 'external',
]);

function resolveContainerType(container) {
  const labeledType = container?.labels?.['fere.type'];
  if (typeof labeledType === 'string') {
    const normalized = labeledType.trim().toLowerCase();
    if (ALLOWED_CONTAINER_TYPES.has(normalized)) {
      return normalized;
    }
  }
  const imageType = categorizeContainerImage(container.image || '');
  if (imageType !== 'container') return imageType;
  // For build-context services the image name is project_service, not the base image.
  // Fall back to the Dockerfile FROM image when available.
  if (container.baseImage) {
    const baseType = categorizeContainerImage(container.baseImage);
    if (baseType !== 'container') return baseType;
  }
  return 'container';
}

// ============================================
// Project / Path Helpers
// ============================================

function isLocalHost(host = '') {
  const normalized = host.toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' ||
    normalized === '::1' || normalized === '0.0.0.0' || normalized === '::';
}

function inferProjectFromCommand(command = '') {
  const match = command.match(/\/Users\/[^/\s]+\/[^/\s]+/);
  if (match) return match[0].split('/').pop();
  const homeMatch = command.match(/\/home\/[^/\s]+\/[^/\s]+/);
  if (homeMatch) return homeMatch[0].split('/').pop();
  return null;
}

const PROJECT_MARKERS = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile',
  'setup.py', 'go.mod', 'Cargo.toml', 'composer.json', 'Gemfile',
  'pom.xml', 'build.gradle', 'Makefile',
];

function findProjectRoot(startPath) {
  let current = startPath;
  if (!current) return null;
  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) current = path.dirname(current);
  } catch (error) {
    return null;
  }

  // Never treat $HOME (or ancestors) as a project root — ~/.git is
  // commonly used for dotfile management, not as a real project.
  const homeDir = os.homedir();

  // First pass: find the enclosing .git root (canonical repo identity).
  let probe = current;
  let probePrev = null;
  while (probe && probe !== probePrev) {
    if (probe === homeDir) break;
    if (fs.existsSync(path.join(probe, '.git'))) return probe;
    probePrev = probe;
    probe = path.dirname(probe);
  }

  // Fallback: nearest PROJECT_MARKER when no .git is present.
  let previous = null;
  while (current && current !== previous) {
    if (current === homeDir) break;
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return current;
    }
    previous = current;
    current = path.dirname(current);
  }
  return null;
}

function findNearestProjectMarkerRoot(startPath) {
  let current = startPath;
  if (!current) return null;
  try {
    const stat = fs.statSync(current);
    if (stat.isFile()) current = path.dirname(current);
  } catch (error) {
    return null;
  }

  const homeDir = os.homedir();
  let previous = null;
  while (current && current !== previous) {
    if (current === homeDir) break;
    for (const marker of PROJECT_MARKERS) {
      if (fs.existsSync(path.join(current, marker))) return current;
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
      candidates.push(token.replace(/[",']/g, ''));
    }
  }
  for (const candidate of candidates) {
    const projectRoot = findProjectRoot(candidate);
    if (projectRoot) return projectRoot;
  }
  return null;
}

function extractProjectFromContainerName(containerName) {
  const composeMatch = containerName.match(/^([^_]+)_[^_]+_\d+$/);
  if (composeMatch) return composeMatch[1];
  const cleanName = containerName.replace(/^\//, '');
  const parts = cleanName.split(/[-_]/);
  if (parts.length > 1) return parts[0];
  return null;
}

function inferProjectPathFromContainer(container) {
  if (container.mounts && Array.isArray(container.mounts)) {
    for (const mount of container.mounts) {
      if (mount.type === 'bind' && mount.source) {
        const projectRoot =
          findNearestProjectMarkerRoot(mount.source) ||
          findProjectRoot(mount.source);
        if (projectRoot) return projectRoot;
      }
    }
  }
  // Prefer build context path (specific service subdirectory) over the broader
  // compose working_dir so route scanning targets the right service's source files.
  if (container.buildContextPath && fs.existsSync(container.buildContextPath)) {
    return container.buildContextPath;
  }
  if (container.labels) {
    const workingDir = container.labels['com.docker.compose.project.working_dir'];
    if (workingDir) {
      // Keep compose working_dir as the container project path so subproject
      // grouping reflects the compose stack directory (e.g. ".../docker-test")
      // instead of collapsing to the repo git root.
      return workingDir;
    }
  }
  return null;
}

// ============================================
// Docker Node Helpers
// ============================================

function findMatchingNativeNode(container, nodes) {
  const isDockerBackendNode = (node) => {
    const name = String(node.name || '').toLowerCase();
    const command = String(node.command || '').toLowerCase();
    return (
      node.type === 'container' ||
      name.includes('docker') ||
      command.includes('docker')
    );
  };

  for (const port of container.ports) {
    if (port.hostPort) {
      const matchingNode = nodes.find(n =>
        !n.isDockerContainer &&
        !isDockerBackendNode(n) &&
        n.ports.some(p => p.port === port.hostPort)
      );
      if (matchingNode) return matchingNode;
    }
  }
  return null;
}

function enhanceNodeWithDockerInfo(node, container) {
  const containerType = resolveContainerType(container);
  node.isDockerContainer = true;
  node.type = containerType;
  node.containerId = container.id;
  node.containerImage = container.image;
  node.containerState = container.state;
  node.containerStatus = container.status;
  node.containerHealth = container.health;
  node.containerNetworks = container.networks;
  node.containerMounts = container.mounts;
  node.containerPorts = container.ports;
  node.memoryUsage = container.memoryUsage;
  node.description = `Docker container: ${container.image}`;

  // Override command to the "docker: {image} | {runtime}" format so that
  // brand/icon detection (inferServiceBrand) can extract the real runtime
  // (e.g. "node index.js") instead of seeing the host-side proxy command.
  const runtimeCmd = container.fullCommand || container.command;
  if (runtimeCmd) {
    node.command = `docker: ${container.image} | ${runtimeCmd}`;
  }

  // If the matched native node has no project path (e.g. docker-proxy process),
  // derive one from the container so routes can be scanned and attached.
  if (!node.projectPath) {
    const containerProjectPath = inferProjectPathFromContainer(container);
    if (containerProjectPath) {
      node.projectPath = containerProjectPath;
      node.project = path.basename(containerProjectPath);
    }
  }
}

// ============================================
// Graph Structure Builder (synchronous, pure)
// ============================================

/**
 * Build the graph structure from pre-collected data.
 * This is the CPU-heavy path — no async, no child_process calls.
 * All I/O data (CWDs, Docker, routes) is passed in pre-collected.
 *
 * @param {Object} params
 * @param {Array} params.processes - Dev processes
 * @param {Array} params.ports - Listening ports
 * @param {Array} params.connections - Established connections
 * @param {Object} params.cwdMap - Map<pid, cwd_path> from batched lsof
 * @param {Object} params.dockerSnapshot - Docker containers, networks, connections
 * @param {Object} params.routesByProject - Map<projectPath, routes[]>
 * @param {Object} params.healthByPid - Map<pid, {healthStatus, lastSeen}>
 * @param {Function} params.containerHealthToGraphHealth - Docker health mapper
 * @returns {{ nodes: Array, edges: Array, dockerSnapshot: Object }}
 */
/**
 * Lightweight project-path discovery — extracts the set of project paths
 * from process CWD data and Docker container metadata without building
 * the full graph.  Used to decide which directories to scan for routes.
 */
function collectProjectPaths({ processes, ports, cwdMap = {}, dockerSnapshot = null }) {
  const projects = new Set();

  // Only port-owning PIDs become graph nodes, so only their CWDs matter
  const portPids = new Set(ports.map(p => p.pid));
  const processMap = new Map(processes.map(p => [p.pid, p]));

  for (const pid of portPids) {
    const cwd = cwdMap[pid] || null;
    let projectPath = cwd ? findProjectRoot(cwd) : null;
    if (!projectPath) {
      const proc = processMap.get(pid);
      if (proc?.command) {
        projectPath = inferProjectPathFromCommand(proc.command);
      }
    }
    if (projectPath) projects.add(projectPath);
  }

  // Also consider connection-originating PIDs that may have a CWD
  // but no listening port (they still create graph nodes)
  // — skip for now: those are rare and connections require a target port
  // which is already covered above.

  // Docker container project paths
  if (dockerSnapshot?.containers?.length) {
    for (const container of dockerSnapshot.containers) {
      const projectPath = inferProjectPathFromContainer(container);
      if (projectPath) projects.add(projectPath);
    }
  }

  return projects;
}

function buildGraphStructure({
  processes, ports, connections,
  cwdMap = {}, dockerSnapshot = null, routesByProject = {},
  healthByPid = {}, containerHealthToGraphHealth = () => 'yellow',
}) {
  const pidsWithConnections = new Set();
  for (const conn of connections) {
    pidsWithConnections.add(conn.pid);
  }

  const processMap = new Map();
  for (const proc of processes) {
    processMap.set(proc.pid, proc);
  }

  const nodes = [];
  const nodesByPid = new Map();
  const portToPid = new Map();
  const portProcessByPid = new Map();
  const portUserByPid = new Map();

  const ensureProcessNode = (pid, portProcess) => {
    if (nodesByPid.has(pid)) return nodesByPid.get(pid);

    const proc = processMap.get(pid);
    const fallbackProcess = portProcessByPid.get(pid) || portProcess;
    const rawName = proc ? proc.name : fallbackProcess;
    const command = proc ? proc.command : fallbackProcess;
    const name = getServiceDisplayName(rawName, command);

    const health = healthByPid[pid] || { healthStatus: 'yellow', lastSeen: Date.now() };

    // Resolve project path from CWD map
    const cwd = cwdMap[pid] || null;
    let projectPath = cwd ? findProjectRoot(cwd) : null;
    if (!projectPath && command) {
      projectPath = inferProjectPathFromCommand(command);
    }

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
      project: projectPath ? path.basename(projectPath) : null,
      projectPath,
      repoPath: projectPath,
      description: getServiceDescription(rawName, command),
      ports: [],
      routes: [],
      healthStatus: health.healthStatus,
      lastSeen: health.lastSeen,
    };

    nodes.push(node);
    nodesByPid.set(pid, node);
    return node;
  };

  // Build lookup maps
  for (const port of ports) {
    portToPid.set(port.port, port.pid);
    if (!portProcessByPid.has(port.pid)) {
      portProcessByPid.set(port.pid, port.process);
      portUserByPid.set(port.pid, port.user);
    }
  }

  // Create nodes from ports (deduplicated)
  const seenPorts = new Set();
  for (const port of ports) {
    if (seenPorts.has(port.port)) continue;
    seenPorts.add(port.port);
    const node = ensureProcessNode(port.pid, port.process);
    node.ports.push({
      port: port.port,
      host: port.host,
      description: getPortDescription(port.port),
    });
  }

  // Build edges from connections
  const edges = [];
  const edgeSet = new Set();
  const externalNodes = new Map();

  const getExternalNode = (host, port) => {
    const key = `${host}:${port}`;
    if (externalNodes.has(key)) return externalNodes.get(key);

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
      repoPath: null,
      ports: [{ port, host, description: null }],
      routes: [],
      healthStatus: 'yellow',
      lastSeen: Date.now(),
    };
    nodes.push(node);
    externalNodes.set(key, node);
    return node;
  };

  for (const conn of connections) {
    const sourceProc = processMap.get(conn.pid);
    if (!sourceProc) continue;

    // Skip connections with missing remote endpoint data
    if (!conn.remoteHost && !conn.remotePort) continue;

    const sourceNode = ensureProcessNode(conn.pid, conn.process);
    const targetPid = isLocalHost(conn.remoteHost) ? portToPid.get(conn.remotePort) : null;
    const targetNode = targetPid
      ? ensureProcessNode(targetPid, conn.process)
      : getExternalNode(conn.remoteHost || 'unknown', conn.remotePort || 0);

    if (sourceNode.id === targetNode.id) continue;

    let confidence = 0.6;
    if (targetPid) confidence = 0.9;
    else if (isLocalHost(conn.remoteHost)) confidence = 0.5;

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
        confidence,
      });
    }
  }

  // Track node count before Docker additions for optimized re-matching
  const preDockerNodeCount = nodes.length;

  // Attach routes from pre-scanned data, matched per service.
  // This prevents non-API services (redis/db/broker/etc.) from inheriting
  // all project routes after route scanning.
  for (const node of nodes) {
    if (!node.projectPath) {
      node.routes = [];
      continue;
    }
    const routes = routesByProject[node.projectPath] || [];
    node.routes = matchRoutesToService(routes, node);
  }

  // Add Docker container nodes
  if (dockerSnapshot && dockerSnapshot.isAvailable && dockerSnapshot.containers.length > 0) {
    addDockerContainerNodes(nodes, edges, dockerSnapshot, nodesByPid, portToPid, containerHealthToGraphHealth);
  }

  // Docker nodes are added after the initial route pass; run route matching
  // only for newly added/modified Docker nodes instead of the entire list.
  for (let i = preDockerNodeCount; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node.projectPath) {
      node.routes = [];
      continue;
    }
    const routes = routesByProject[node.projectPath] || [];
    node.routes = matchRoutesToService(routes, node);
  }
  // Also re-match nodes that were enhanced with Docker info (existing nodes
  // that got containerized metadata via enhanceNodeWithDockerInfo).
  for (let i = 0; i < preDockerNodeCount; i++) {
    const node = nodes[i];
    if (!node.isDockerContainer || !node.projectPath) continue;
    const routes = routesByProject[node.projectPath] || [];
    node.routes = matchRoutesToService(routes, node);
  }

  return { nodes, edges, dockerSnapshot: dockerSnapshot || null };
}

function addDockerContainerNodes(nodes, edges, dockerSnapshot, nodesByPid, portToPid, containerHealthToGraphHealth) {
  const { containers, containerConnections } = dockerSnapshot;
  const containerNodesById = new Map();

  for (const container of containers) {
    const nodeId = `docker-${container.id}`;
    const existingNode = findMatchingNativeNode(container, nodes);
    if (existingNode) {
      enhanceNodeWithDockerInfo(existingNode, container);
      containerNodesById.set(container.id, existingNode);
      continue;
    }

    // Deduplicate by hostPort — Docker emits both IPv4 (0.0.0.0) and IPv6 ([::])
    // bindings for the same port. Keep the first occurrence (IPv4 preferred).
    const seenHostPorts = new Set();
    const graphPorts = container.ports
      .filter(p => p.hostPort)
      .filter(p => {
        if (seenHostPorts.has(p.hostPort)) return false;
        seenHostPorts.add(p.hostPort);
        return true;
      })
      .map(p => ({
        port: p.hostPort,
        host: p.hostIp === '0.0.0.0' || p.hostIp === '::' ? 'localhost' : (p.hostIp || 'localhost'),
        description: `Container port ${p.containerPort}/${p.protocol}`,
      }));

    const containerProjectPath = inferProjectPathFromContainer(container);
    const containerRepoPath = containerProjectPath
      ? (findProjectRoot(containerProjectPath) || containerProjectPath)
      : null;
    const containerProject = containerProjectPath
      ? path.basename(containerProjectPath)
      : extractProjectFromContainerName(container.name);

    const node = {
      id: nodeId,
      pid: -1,
      name: container.name,
      command: (container.fullCommand || container.command)
        ? `docker: ${container.image} | ${container.fullCommand || container.command}`
        : `docker: ${container.image}`,
      type: resolveContainerType(container),
      cpu: container.cpu || 0,
      memory: container.memory || 0,
      user: 'docker',
      tty: null,
      project: containerProject,
      projectPath: containerProjectPath,
      repoPath: containerRepoPath,
      description: `Docker container running ${container.image}`,
      ports: graphPorts,
      routes: [],
      healthStatus: containerHealthToGraphHealth(container),
      lastSeen: Date.now(),
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
    for (const port of container.ports) {
      if (port.hostPort) portToPid.set(port.hostPort, nodeId);
    }
  }

  // Redirect edges that target Docker proxy/backend process nodes to the
  // actual container nodes.  When a native process connects to a Docker-mapped
  // host port (e.g. localhost:9200), the initial edge-building pass resolves
  // that port to the Docker proxy PID — not the container.  Now that container
  // nodes exist, retarget those edges so the graph shows the real connection.
  const hostPortToContainerNode = new Map();
  for (const [, node] of containerNodesById) {
    for (const port of node.ports) {
      hostPortToContainerNode.set(port.port, node);
    }
  }

  const retargetedEdgeIds = new Set();
  const nodesToRemove = new Set();
  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];
    const containerNode = hostPortToContainerNode.get(edge.targetPort);
    if (!containerNode || edge.target === containerNode.id) continue;

    const targetNode = nodes.find(n => n.id === edge.target);
    if (!targetNode) continue;

    // Only retarget if the current target looks like a Docker proxy/backend
    const tName = String(targetNode.name || '').toLowerCase();
    const tCmd = String(targetNode.command || '').toLowerCase();
    const isProxyNode =
      targetNode.type === 'container' ||
      tName.includes('docker') ||
      tCmd.includes('docker') ||
      tCmd.includes('com.docker');
    if (!isProxyNode) continue;

    const newEdgeId = `${edge.source}->${containerNode.id}:${edge.targetPort}`;
    if (retargetedEdgeIds.has(newEdgeId)) {
      // Duplicate after retargeting — mark for removal
      edges.splice(i, 1);
      i--;
      continue;
    }
    retargetedEdgeIds.add(newEdgeId);
    edge.target = containerNode.id;
    edge.id = newEdgeId;
    nodesToRemove.add(targetNode.id);
  }

  // Remove orphaned Docker proxy nodes that no longer have any edges
  if (nodesToRemove.size > 0) {
    const nodesWithEdges = new Set();
    for (const edge of edges) {
      nodesWithEdges.add(edge.source);
      nodesWithEdges.add(edge.target);
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      if (nodesToRemove.has(nodes[i].id) && !nodesWithEdges.has(nodes[i].id)) {
        nodes.splice(i, 1);
      }
    }
  }

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
      sourcePort: 0,
      targetPort: 0,
      protocol: `docker-network:${conn.networkName}`,
      confidence: 0.8,
    });
  }
}

// ============================================
// Metrics Overlay (fast path)
// ============================================

/**
 * Overlay fresh metrics onto an existing node set without rebuilding structure.
 * Returns a new array with updated cpu/memory/health fields.
 * Only creates new node objects when values actually changed.
 */
function overlayMetrics(cachedNodes, processes, healthByPid) {
  const processMap = new Map();
  for (const proc of processes) {
    processMap.set(proc.pid, proc);
  }

  return cachedNodes.map(node => {
    if (node.pid <= 0) return node; // External/Docker nodes don't get process metrics

    const proc = processMap.get(node.pid);
    const health = healthByPid[node.pid];
    if (!proc && !health) return node;

    const newCpu = proc?.cpu ?? node.cpu;
    const newMemory = proc?.memory ?? node.memory;
    const newHealth = health?.healthStatus ?? node.healthStatus;
    const newLastSeen = health?.lastSeen ?? node.lastSeen;

    // Skip object allocation if nothing changed
    if (newCpu === node.cpu && newMemory === node.memory &&
        newHealth === node.healthStatus && newLastSeen === node.lastSeen) {
      return node;
    }

    return {
      ...node,
      cpu: newCpu,
      memory: newMemory,
      healthStatus: newHealth,
      lastSeen: newLastSeen,
    };
  });
}

// ============================================
// Topology Change Detection
// ============================================

/**
 * Check whether the topology has changed between two raw data snapshots.
 * Compares PID sets, port sets, and connection endpoint sets.
 */
function hasTopologyChanged(prevRawData, currRawData) {
  if (!prevRawData) return true;

  // Compare process PID sets
  const prevPids = new Set(prevRawData.processes.map(p => p.pid));
  const currPids = new Set(currRawData.processes.map(p => p.pid));
  if (prevPids.size !== currPids.size) return true;
  for (const pid of currPids) {
    if (!prevPids.has(pid)) return true;
  }

  // Compare listening port sets
  const prevPorts = new Set(prevRawData.ports.map(p => `${p.port}-${p.pid}`));
  const currPorts = new Set(currRawData.ports.map(p => `${p.port}-${p.pid}`));
  if (prevPorts.size !== currPorts.size) return true;
  for (const key of currPorts) {
    if (!prevPorts.has(key)) return true;
  }

  // Compare connection endpoint sets
  const connKey = c => `${c.pid}-${c.localPort}-${c.remoteHost}-${c.remotePort}`;
  const prevConns = new Set(prevRawData.connections.map(connKey));
  const currConns = new Set(currRawData.connections.map(connKey));
  if (prevConns.size !== currConns.size) return true;
  for (const key of currConns) {
    if (!prevConns.has(key)) return true;
  }

  return false;
}

module.exports = {
  // Service info
  KNOWN_SERVICES,
  extractAppNameFromCommand,
  getServiceInfo,
  getServiceDescription,
  getServiceDisplayName,
  formatScriptLabel,
  // Classification
  categorizeProcess,
  categorizeContainerImage,
  resolveContainerType,
  // Project/path helpers
  isLocalHost,
  inferProjectFromCommand,
  inferProjectPathFromCommand,
  PROJECT_MARKERS,
  findProjectRoot,
  findNearestProjectMarkerRoot,
  extractProjectFromContainerName,
  inferProjectPathFromContainer,
  // Docker helpers
  findMatchingNativeNode,
  enhanceNodeWithDockerInfo,
  // Graph building
  collectProjectPaths,
  buildGraphStructure,
  overlayMetrics,
  hasTopologyChanged,
};
