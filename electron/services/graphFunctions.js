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
const {
  PLATFORM_KNOWN_SERVICES,
  extractAppNameFromCommand,
  HOME_DIR_PATH_PREFIXES,
} = require('./platform');
const {
  getComposeDefinedServices,
} = require('./dockerMonitor');

// ============================================
// Known Services Dictionary
// ============================================

// Cross-platform services (present on all OSes)
const COMMON_KNOWN_SERVICES = {
  'visual studio code': { description: 'Visual Studio Code - a code editor for development workflows.', category: 'developer', displayName: 'VS Code' },
  'code': { description: 'Visual Studio Code - a code editor for development workflows.', category: 'developer', displayName: 'VS Code' },
  'google chrome': { description: 'Google Chrome - web browser often used for local dev testing.', category: 'developer', displayName: 'Google Chrome' },
  'discord': { description: 'Discord - collaboration and chat client.', category: 'developer', displayName: 'Discord' },
  'electron': { description: 'Electron - runtime for desktop apps built with web tech.', category: 'developer', displayName: 'Electron' },
  'next-server': { description: 'Next.js dev server.', category: 'frontend', displayName: 'Next.js Dev Server' },
  'node': { description: 'Node.js runtime - JavaScript runtime built on Chrome\'s V8 engine for building server-side applications.', category: 'development', displayName: 'Node.js' },
  'python': { description: 'Python interpreter - a versatile programming language used for web development, scripting, and data science.', category: 'development', displayName: 'Python' },
  'python3': { description: 'Python 3 interpreter - the modern version of Python with improved syntax and features.', category: 'development', displayName: 'Python 3' },
  'ruby': { description: 'Ruby interpreter - a dynamic programming language focused on simplicity and productivity.', category: 'development', displayName: 'Ruby' },
  'java': { description: 'Java Virtual Machine - runs Java applications with cross-platform compatibility.', category: 'development', displayName: 'Java' },
  'postgres': { description: 'PostgreSQL - a powerful, open-source relational database system.', category: 'database', displayName: 'PostgreSQL' },
  'mysqld': { description: 'MySQL Server - a popular open-source relational database management system.', category: 'database', displayName: 'MySQL' },
  'mongod': { description: 'MongoDB Server - a NoSQL document database for modern applications.', category: 'database', displayName: 'MongoDB' },
  'redis-server': { description: 'Redis Server - an in-memory data structure store used as database, cache, and message broker.', category: 'cache', displayName: 'Redis' },
  'ssh': { description: 'OpenSSH client - secure remote shell access tool.', category: 'network', displayName: 'SSH Client' },
  'sshd': { description: 'OpenSSH server daemon - accepts secure remote shell connections.', category: 'network', displayName: 'SSH Daemon' },
  'sftp': { description: 'SFTP client - secure file transfer over SSH.', category: 'network', displayName: 'SFTP Client' },
  'scp': { description: 'SCP client - secure copy over SSH.', category: 'network', displayName: 'SCP' },
  'nginx': { description: 'Nginx - a high-performance web server, reverse proxy, and load balancer.', category: 'webserver', displayName: 'Nginx' },
  'httpd': { description: 'Apache HTTP Server - a widely-used open-source web server.', category: 'webserver', displayName: 'Apache' },
  'Docker': { description: 'Docker Desktop - container platform for building, sharing, and running containerized applications.', category: 'container', displayName: 'Docker' },
  'com.docker.backend': { description: 'Docker Backend - the background service that manages Docker containers and images.', category: 'container', displayName: 'Docker Backend' },
  'com.docker': { description: 'Docker Backend - the background service that manages Docker containers and images.', category: 'container', displayName: 'Docker Backend' },
};

// Merge cross-platform + platform-specific services
const KNOWN_SERVICES = { ...COMMON_KNOWN_SERVICES, ...PLATFORM_KNOWN_SERVICES };

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

// extractAppNameFromCommand is imported from platform — platform-specific .app/.exe extraction

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

  // Remote access and transfer tools
  if (name === 'sshd' || cmd.includes('sshd')) return 'service';
  if (name === 'ssh' || name === 'sftp' || name === 'scp') return 'client';
  if (/(^|\s)(ssh|sftp|scp)(\s|$)/.test(cmd)) return 'client';

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

function looksLikeRemoteAccessProcess(processName = '', command = '') {
  const name = String(processName || '').toLowerCase().trim();
  const cmd = String(command || '').toLowerCase();
  if (name === 'ssh' || name === 'sftp' || name === 'scp' || name === 'sshd' || name === 'autossh') return true;
  if (name === 'ssh-agent') return false;
  if (/(^|\s)(ssh|sftp|scp|sshd|autossh)(\s|$)/.test(cmd)) return true;
  return /\brsync\b/.test(cmd) && (/\b-e\s+ssh\b/.test(cmd) || /\bssh:\/\//.test(cmd));
}

function looksLikeRemoteAccessConnection(conn = {}) {
  const processName = String(conn.process || '').toLowerCase();
  const remotePort = Number(conn.remotePort || 0);
  if (looksLikeRemoteAccessProcess(processName, processName)) return true;
  return remotePort === 22 || remotePort === 21 || remotePort === 989 || remotePort === 990;
}

function isSshdProcess(processName = '', command = '') {
  const text = `${processName || ''} ${command || ''}`.toLowerCase();
  return /(^|\s)sshd(\s|$)/.test(text);
}

const PERF_SSH_LOGGING = process.env.FERE_PERF_SSH === '1';
const REMOTE_CMD_PARSE_CACHE_MAX = 512;
const REMOTE_CMD_PARSE_CACHE = new Map();
const REMOTE_PARSE_STATS = { hits: 0, misses: 0 };

function getCachedRemoteCommandParse(command) {
  const cached = REMOTE_CMD_PARSE_CACHE.get(command);
  if (!cached) return null;
  REMOTE_CMD_PARSE_CACHE.delete(command);
  REMOTE_CMD_PARSE_CACHE.set(command, cached);
  REMOTE_PARSE_STATS.hits += 1;
  return cached;
}

function setCachedRemoteCommandParse(command, parsed) {
  if (!command || !parsed) return;
  if (REMOTE_CMD_PARSE_CACHE.has(command)) {
    REMOTE_CMD_PARSE_CACHE.delete(command);
  }
  REMOTE_CMD_PARSE_CACHE.set(command, parsed);
  if (REMOTE_CMD_PARSE_CACHE.size > REMOTE_CMD_PARSE_CACHE_MAX) {
    const oldestKey = REMOTE_CMD_PARSE_CACHE.keys().next().value;
    if (oldestKey) REMOTE_CMD_PARSE_CACHE.delete(oldestKey);
  }
}

function parseRemoteAccessCommand(command = '') {
  const cmd = String(command || '');
  if (!cmd) return { tool: null, user: null, host: null, port: null, tunnels: [] };
  const cached = getCachedRemoteCommandParse(cmd);
  if (cached) {
    return {
      ...cached,
      tunnels: (cached.tunnels || []).map((tunnel) => ({ ...tunnel })),
    };
  }
  REMOTE_PARSE_STATS.misses += 1;

  const parseTunnelSpec = (mode, spec) => {
    const raw = String(spec || '').trim();
    if (!raw) return null;
    const parts = raw.split(':');
    if (mode === 'D') {
      const listenPort = parseInt(parts[parts.length - 1], 10);
      const listenHost = parts.length > 1 ? parts.slice(0, -1).join(':') : null;
      return {
        mode,
        listenHost: listenHost || null,
        listenPort: Number.isNaN(listenPort) ? null : listenPort,
        targetHost: null,
        targetPort: null,
      };
    }

    if (parts.length < 3) return null;
    const listenPort = parseInt(parts[parts.length - 3], 10);
    const targetHost = parts[parts.length - 2] || null;
    const targetPort = parseInt(parts[parts.length - 1], 10);
    const listenHost = parts.length > 3 ? parts.slice(0, -3).join(':') : null;
    return {
      mode,
      listenHost: listenHost || null,
      listenPort: Number.isNaN(listenPort) ? null : listenPort,
      targetHost,
      targetPort: Number.isNaN(targetPort) ? null : targetPort,
    };
  };

  const tunnels = [];
  const tunnelMatches = cmd.matchAll(/(?:^|\s)-([LRD])\s+([^\s]+)/g);
  for (const match of tunnelMatches) {
    const parsed = parseTunnelSpec(match[1], match[2]);
    if (parsed) tunnels.push(parsed);
  }
  const compactTunnelMatches = cmd.matchAll(/(?:^|\s)-([LRD])([^\s]+)/g);
  for (const match of compactTunnelMatches) {
    const parsed = parseTunnelSpec(match[1], match[2]);
    if (parsed) tunnels.push(parsed);
  }

  const toolMatch = cmd.match(/(?:^|\s)(autossh|ssh|sftp|scp)(?=\s|$)/i);
  const tool = toolMatch ? toolMatch[1].toLowerCase() : null;

  const portMatch = cmd.match(/(?:^|\s)-p\s+(\d+)(?=\s|$)/i)
    || cmd.match(/(?:^|\s)-P\s+(\d+)(?=\s|$)/i);
  const port = portMatch ? parseInt(portMatch[1], 10) : null;

  const hostWithUser = cmd.match(/(?:^|\s)(?:ssh|autossh|sftp)\s+(?:-[A-Za-z0-9-]+(?:\s+\S+)?\s+)*(?:([^@\s]+)@)?([A-Za-z0-9._-]+)/i);
  if (hostWithUser) {
    const parsed = {
      tool,
      user: hostWithUser[1] || null,
      host: hostWithUser[2] || null,
      port,
      tunnels,
    };
    setCachedRemoteCommandParse(cmd, parsed);
    return {
      ...parsed,
      tunnels: (parsed.tunnels || []).map((tunnel) => ({ ...tunnel })),
    };
  }

  // scp can include host:path in either src or dest
  const scpHost = cmd.match(/(?:^|\s)(?:([^@\s]+)@)?([A-Za-z0-9._-]+):\S+/i);
  if (scpHost) {
    const parsed = {
      tool,
      user: scpHost[1] || null,
      host: scpHost[2] || null,
      port,
      tunnels,
    };
    setCachedRemoteCommandParse(cmd, parsed);
    return {
      ...parsed,
      tunnels: (parsed.tunnels || []).map((tunnel) => ({ ...tunnel })),
    };
  }

  const parsed = { tool, user: null, host: null, port, tunnels };
  setCachedRemoteCommandParse(cmd, parsed);
  return {
    ...parsed,
    tunnels: (parsed.tunnels || []).map((tunnel) => ({ ...tunnel })),
  };
}

function buildRemoteAccessMetadata({ proc = null, command = '', conn = null }) {
  const parsed = parseRemoteAccessCommand(command);
  const resolved = resolveSshAlias(parsed.host);
  const normalizedTool = parsed.tool === 'autossh'
    ? 'autossh'
    : parsed.tool === 'sftp'
      ? 'sftp'
      : parsed.tool === 'scp'
        ? 'scp'
        : 'ssh';
  const host = conn?.remoteHost || resolved.host || parsed.host || null;
  const port = Number(conn?.remotePort || parsed.port || resolved.port || 22);
  return {
    tool: normalizedTool,
    alias: resolved.alias || null,
    user: parsed.user || resolved.user || null,
    host,
    port: Number.isNaN(port) ? null : port,
    source: conn ? 'connection' : 'command',
    startTime: proc?.startTime || null,
    tunnels: parsed.tunnels ? parsed.tunnels.map((tunnel) => ({ ...tunnel })) : [],
  };
}

function extractRemoteHostFromCommand(command = '') {
  const parsed = parseRemoteAccessCommand(command);
  const resolved = resolveSshAlias(parsed.host);
  return resolved.host || parsed.host;
}

function inferConnectionProtocol(conn, sourceNode) {
  const remotePort = Number(conn?.remotePort || 0);
  const sourceText = `${sourceNode?.name || ''} ${sourceNode?.command || ''}`.toLowerCase();
  const sourceLooksLikeSftp = /\bsftp\b/.test(sourceText);
  const sourceLooksLikeScp = /\bscp\b/.test(sourceText);
  const sourceLooksLikeSsh = /\bssh\b/.test(sourceText) || sourceLooksLikeSftp || sourceLooksLikeScp;

  if (remotePort === 22 || sourceLooksLikeSsh) {
    if (sourceLooksLikeSftp) return 'sftp';
    if (sourceLooksLikeScp) return 'scp';
    return 'ssh';
  }
  if (remotePort === 21) return 'ftp';
  if (remotePort === 989 || remotePort === 990) return 'ftps';

  return conn?.protocol || 'tcp';
}

function getExternalConnectionDescription(protocol, port) {
  if (protocol === 'ssh') return 'Remote SSH endpoint';
  if (protocol === 'sftp') return 'Remote SFTP endpoint';
  if (protocol === 'scp') return 'Remote SCP endpoint';
  if (port === 22) return 'Remote SSH endpoint';
  return null;
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

/**
 * Returns a specific, human-readable description for a Docker container
 * based on its image name, instead of the generic "Docker container running X".
 */
function getContainerDescription(image, type) {
  const img = (image || '').toLowerCase();

  // Databases
  if (img.includes('postgres') || img.includes('pg')) return 'PostgreSQL — relational database for structured data and complex queries.';
  if (img.includes('mysql')) return 'MySQL — relational database for web applications and transactional workloads.';
  if (img.includes('mariadb')) return 'MariaDB — MySQL-compatible relational database with additional storage engines.';
  if (img.includes('mongo')) return 'MongoDB — document database that stores data as flexible JSON-like documents.';
  if (img.includes('sqlite')) return 'SQLite — lightweight embedded database for local or single-user storage.';
  if (img.includes('elasticsearch')) return 'Elasticsearch — distributed search and analytics engine for full-text search.';
  if (img.includes('opensearch')) return 'OpenSearch — search and analytics engine, fork of Elasticsearch.';
  if (img.includes('meilisearch')) return 'Meilisearch — fast, typo-tolerant search engine for user-facing search.';
  if (img.includes('typesense')) return 'Typesense — open-source search engine optimized for instant search.';
  if (img.includes('solr')) return 'Apache Solr — enterprise search platform built on Apache Lucene.';

  // Caches
  if (img.includes('redis')) return 'Redis — in-memory key-value store used for caching, sessions, and pub/sub.';
  if (img.includes('memcached')) return 'Memcached — high-performance in-memory cache for reducing database load.';

  // Message brokers
  if (img.includes('rabbitmq')) return 'RabbitMQ — message broker that routes messages between services via queues.';
  if (img.includes('kafka')) return 'Kafka — distributed event streaming platform for high-throughput data pipelines.';
  if (img.includes('nats')) return 'NATS — lightweight messaging system for microservice communication.';
  if (img.includes('zookeeper')) return 'ZooKeeper — coordination service for distributed systems and Kafka clusters.';
  if (img.includes('activemq')) return 'ActiveMQ — enterprise message broker supporting multiple protocols.';
  if (img.includes('pulsar')) return 'Apache Pulsar — distributed pub-sub messaging with built-in storage.';
  if (img.includes('mosquitto')) return 'Mosquitto — lightweight MQTT broker for IoT and device messaging.';

  // Web servers / proxies
  if (img.includes('nginx')) return 'Nginx — reverse proxy and load balancer that routes traffic to backend services.';
  if (img.includes('apache') || img.includes('httpd')) return 'Apache — web server that serves static files and proxies to application servers.';
  if (img.includes('traefik')) return 'Traefik — auto-discovering reverse proxy that routes traffic based on container labels.';
  if (img.includes('haproxy')) return 'HAProxy — high-availability load balancer for TCP and HTTP traffic.';
  if (img.includes('envoy')) return 'Envoy — service mesh proxy for observability, security, and traffic management.';
  if (img.includes('caddy')) return 'Caddy — web server with automatic HTTPS and reverse proxy capabilities.';

  // Frontends
  if (img.includes('react') || img.includes('vue') || img.includes('angular')) return 'Frontend dev server — serves the browser-side UI with hot reload.';

  // Language runtimes / frameworks
  if (img.includes('fastapi')) return 'FastAPI — async Python web framework for building REST APIs.';
  if (img.includes('django')) return 'Django — Python web framework with ORM, admin, and built-in auth.';
  if (img.includes('flask')) return 'Flask — lightweight Python web framework for APIs and microservices.';
  if (img.includes('express')) return 'Express — minimal Node.js web framework for building APIs and web apps.';
  if (img.includes('nestjs')) return 'NestJS — TypeScript Node.js framework with dependency injection and modules.';
  if (img.includes('spring')) return 'Spring — Java framework for enterprise APIs and microservices.';
  if (img.includes('rails')) return 'Ruby on Rails — full-stack web framework with convention-over-configuration.';
  if (img.includes('laravel')) return 'Laravel — PHP web framework with expressive syntax and built-in tooling.';
  if (img.includes('python')) return 'Python application — runs a Python process inside the container.';
  if (img.includes('node')) return 'Node.js application — runs a JavaScript/TypeScript process inside the container.';
  if (img.includes('ruby')) return 'Ruby application — runs a Ruby process inside the container.';
  if (img.includes('golang') || img.includes('go:')) return 'Go application — runs a compiled Go binary inside the container.';
  if (img.includes('openjdk') || img.includes('java')) return 'Java application — runs a JVM process inside the container.';
  if (img.includes('php')) return 'PHP application — runs PHP scripts inside the container.';

  // Workers
  if (img.includes('celery')) return 'Celery — distributed task queue for running background jobs in Python.';
  if (img.includes('sidekiq')) return 'Sidekiq — background job processor for Ruby applications using Redis.';
  if (img.includes('resque')) return 'Resque — Redis-backed job queue for Ruby background processing.';
  if (img.includes('worker')) return 'Worker process — handles background tasks and async job processing.';

  // Object storage
  if (img.includes('minio')) return 'MinIO — S3-compatible object storage for local development and testing.';
  if (img.includes('localstack')) return 'LocalStack — local AWS cloud emulator for offline development and testing.';

  // Infrastructure
  if (img.includes('vault')) return 'HashiCorp Vault — secrets management and encryption as a service.';
  if (img.includes('consul')) return 'HashiCorp Consul — service discovery and configuration management.';
  if (img.includes('etcd')) return 'etcd — distributed key-value store for shared configuration and service discovery.';
  if (img.includes('keycloak')) return 'Keycloak — identity and access management for authentication and SSO.';
  if (img.includes('authelia')) return 'Authelia — authentication and authorization server with 2FA support.';

  // Observability
  if (img.includes('prometheus')) return 'Prometheus — metrics collection and alerting for monitoring infrastructure.';
  if (img.includes('grafana')) return 'Grafana — dashboarding and visualization for metrics and logs.';
  if (img.includes('jaeger')) return 'Jaeger — distributed tracing for monitoring microservice request flows.';

  // Mail
  if (img.includes('mailhog') || img.includes('mailpit') || img.includes('mailtrap')) return 'Mail catcher — captures outgoing emails for local development testing.';

  const TYPE_DESCRIPTIONS = {
    'backend': 'Backend service that handles API requests and business logic.',
    'frontend': 'Frontend service that serves the user interface.',
    'database': 'Database service for persistent data storage.',
    'cache': 'In-memory cache for fast data access.',
    'broker': 'Message broker that routes messages between services.',
    'webserver': 'Web server that handles HTTP traffic and routing.',
    'worker': 'Background worker that processes async tasks.',
    'nodejs': 'Node.js service handling server-side JavaScript.',
    'python': 'Python service handling backend logic.',
    'realtime': 'Real-time service for live data streaming.',
  };
  return TYPE_DESCRIPTIONS[type] || null;
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

const SSH_CONFIG_CACHE = {
  mtimeMs: -1,
  aliases: new Map(),
};

function parseSshConfigText(content = '') {
  const aliases = new Map();
  const lines = String(content || '').split('\n');
  let currentHosts = [];

  const ensureAlias = (alias) => {
    const key = alias.toLowerCase();
    if (!aliases.has(key)) {
      aliases.set(key, { host: alias, hostname: null, user: null, port: null });
    }
    return aliases.get(key);
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [keywordRaw, ...rest] = line.split(/\s+/);
    const keyword = (keywordRaw || '').toLowerCase();
    if (!keyword || rest.length === 0) continue;
    const value = rest.join(' ').trim();

    if (keyword === 'host') {
      currentHosts = value
        .split(/\s+/)
        .filter(Boolean)
        .filter((alias) => !/[*?!]/.test(alias));
      for (const alias of currentHosts) ensureAlias(alias);
      continue;
    }

    if (currentHosts.length === 0) continue;
    if (keyword === 'hostname') {
      for (const alias of currentHosts) ensureAlias(alias).hostname = value;
      continue;
    }
    if (keyword === 'user') {
      for (const alias of currentHosts) ensureAlias(alias).user = value;
      continue;
    }
    if (keyword === 'port') {
      const parsedPort = parseInt(value, 10);
      for (const alias of currentHosts) {
        ensureAlias(alias).port = Number.isNaN(parsedPort) ? null : parsedPort;
      }
    }
  }

  return aliases;
}

function loadSshAliasMap() {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  let stat;
  try {
    stat = fs.statSync(configPath);
  } catch (error) {
    SSH_CONFIG_CACHE.mtimeMs = -1;
    SSH_CONFIG_CACHE.aliases = new Map();
    return SSH_CONFIG_CACHE.aliases;
  }

  if (SSH_CONFIG_CACHE.mtimeMs === stat.mtimeMs) {
    return SSH_CONFIG_CACHE.aliases;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    SSH_CONFIG_CACHE.aliases = parseSshConfigText(content);
    SSH_CONFIG_CACHE.mtimeMs = stat.mtimeMs;
  } catch (error) {
    SSH_CONFIG_CACHE.aliases = new Map();
    SSH_CONFIG_CACHE.mtimeMs = stat.mtimeMs;
  }
  return SSH_CONFIG_CACHE.aliases;
}

function resolveSshAliasWithMap(host = null, aliasMap = new Map()) {
  if (!host) return { alias: null, host: null, user: null, port: null };
  const key = String(host).toLowerCase();
  const entry = aliasMap.get(key);
  if (!entry) return { alias: null, host, user: null, port: null };
  return {
    alias: entry.host || host,
    host: entry.hostname || host,
    user: entry.user || null,
    port: entry.port || null,
  };
}

function resolveSshAlias(host = null) {
  return resolveSshAliasWithMap(host, loadSshAliasMap());
}

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
    if (HOME_DIR_PATH_PREFIXES.some(prefix => token.startsWith(prefix))) {
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
  node.description = getContainerDescription(container.image, containerType);

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
  projectPaths = [],
}) {
  const sshPerfStart = PERF_SSH_LOGGING ? Date.now() : 0;
  let remoteAccessEnrichCount = 0;
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
    if (looksLikeRemoteAccessProcess(rawName, command)) {
      node.remoteAccess = buildRemoteAccessMetadata({ proc, command });
    }

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
  const realRemoteConnectionsByPid = new Map();

  const getExternalNode = (host, port, protocol = null) => {
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
      description: getExternalConnectionDescription(protocol, port),
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
    if (!sourceProc && !looksLikeRemoteAccessConnection(conn)) continue;

    // Skip connections with missing remote endpoint data
    if (!conn.remoteHost && !conn.remotePort) continue;

    const sourceNode = ensureProcessNode(conn.pid, conn.process);
    if (looksLikeRemoteAccessConnection(conn)) {
      sourceNode.remoteAccess = buildRemoteAccessMetadata({
        proc: processMap.get(conn.pid) || null,
        command: sourceNode.command || conn.process || '',
        conn,
      });
      remoteAccessEnrichCount++;
    }
    const targetPid = isLocalHost(conn.remoteHost) ? portToPid.get(conn.remotePort) : null;
    const inferredProtocol = inferConnectionProtocol(conn, sourceNode);
    const targetNode = targetPid
      ? ensureProcessNode(targetPid, conn.process)
      : getExternalNode(conn.remoteHost || 'unknown', conn.remotePort || 0, inferredProtocol);

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
        protocol: inferredProtocol,
        confidence,
      });
      const currentCount = realRemoteConnectionsByPid.get(conn.pid) || 0;
      realRemoteConnectionsByPid.set(conn.pid, currentCount + 1);
    }
  }

  // Aggregate inbound SSHD sessions from external clients.
  const inboundSshByPid = new Map();
  for (const conn of connections) {
    const sourceProc = processMap.get(conn.pid);
    if (!sourceProc) continue;
    if (!isSshdProcess(sourceProc.name, sourceProc.command)) continue;
    if (isLocalHost(conn.remoteHost)) continue;
    if (Number(conn.localPort || 0) !== 22) continue;

    const pid = conn.pid;
    if (!inboundSshByPid.has(pid)) {
      inboundSshByPid.set(pid, { total: 0, clients: new Set() });
    }
    const entry = inboundSshByPid.get(pid);
    entry.total += 1;
    if (conn.remoteHost) entry.clients.add(conn.remoteHost);
  }

  for (const [pid, stats] of inboundSshByPid.entries()) {
    const proc = processMap.get(pid);
    const node =
      nodesByPid.get(pid) ||
      ensureProcessNode(pid, proc?.name || 'sshd');
    const baseRemoteAccess =
      node.remoteAccess ||
      buildRemoteAccessMetadata({
        proc: proc || null,
        command: node.command || proc?.command || 'sshd',
      });
    node.remoteAccess = {
      ...baseRemoteAccess,
      inboundSessions: stats.total,
      inboundClients: Array.from(stats.clients).sort().slice(0, 6),
      source: 'connection',
    };
    remoteAccessEnrichCount++;
  }

  // Keep SSH/SFTP/SCP process nodes visible even when they are outbound-only
  // and lsof has not yet emitted a stable ESTABLISHED row.
  for (const proc of processes) {
    if (!proc || nodesByPid.has(proc.pid)) continue;
    if (!looksLikeRemoteAccessProcess(proc.name, proc.command)) continue;
    const node = ensureProcessNode(proc.pid, proc.name || 'ssh');

    // Add a synthetic remote edge when lsof has not yet surfaced the
    // established socket but the command clearly includes a remote host.
    const hasOutgoingEdge = edges.some((edge) => edge.source === node.id);
    if (hasOutgoingEdge) continue;
    const remoteHost = extractRemoteHostFromCommand(proc.command);
    if (!remoteHost) continue;
    const protocol = /\bsftp\b/i.test(proc.command)
      ? 'sftp'
      : /\bscp\b/i.test(proc.command)
        ? 'scp'
        : 'ssh';
    const targetPort = 22;
    const targetNode = getExternalNode(remoteHost, targetPort, protocol);
    const edgeKey = `${node.id}->${targetNode.id}:${targetPort}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);
    edges.push({
      id: edgeKey,
      source: node.id,
      target: targetNode.id,
      sourcePort: 0,
      targetPort,
      protocol,
      confidence: 0.45,
    });
    node.remoteAccess = buildRemoteAccessMetadata({
      proc,
      command: node.command || proc.command || '',
      conn: { remoteHost, remotePort: targetPort },
    });
    node.remoteAccess.source = 'command';
    remoteAccessEnrichCount++;
  }

  // Compute remote-access health flags
  const duplicateKeyCounts = new Map();
  for (const node of nodes) {
    if (!node.remoteAccess) continue;
    const host = node.remoteAccess.host;
    if (!host) continue;
    const key = `${node.remoteAccess.tool}|${node.remoteAccess.user || ''}|${host}|${node.remoteAccess.port || ''}`;
    duplicateKeyCounts.set(key, (duplicateKeyCounts.get(key) || 0) + 1);
  }
  for (const node of nodes) {
    if (!node.remoteAccess) continue;
    const host = node.remoteAccess.host;
    const key = `${node.remoteAccess.tool}|${node.remoteAccess.user || ''}|${host || ''}|${node.remoteAccess.port || ''}`;
    const duplicateSessions = host ? Math.max(0, (duplicateKeyCounts.get(key) || 0) - 1) : 0;
    const realConnections = realRemoteConnectionsByPid.get(node.pid) || 0;
    const missingConnection = node.remoteAccess.source === 'command' && realConnections === 0;
    const staleLikely = missingConnection && node.healthStatus !== 'green';
    const notes = [];
    if (missingConnection) notes.push('no active socket');
    if (staleLikely) notes.push('session may be stale');
    if (duplicateSessions > 0) notes.push(`${duplicateSessions + 1} similar sessions`);
    node.remoteAccess.healthFlags = {
      missingConnection,
      staleLikely,
      duplicateSessions,
      notes,
    };
  }

  if (PERF_SSH_LOGGING && remoteAccessEnrichCount > 0) {
    const elapsed = Date.now() - sshPerfStart;
    console.log(
      `[PERF][SSH] ${elapsed.toFixed(2)}ms enrich=${remoteAccessEnrichCount} cache=${REMOTE_CMD_PARSE_CACHE.size} hits=${REMOTE_PARSE_STATS.hits} misses=${REMOTE_PARSE_STATS.misses}`,
    );
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

  // Add ghost nodes for compose services that are defined but not running
  if (dockerSnapshot) {
    addComposeGhostNodes(nodes, edges, dockerSnapshot, projectPaths, containerHealthToGraphHealth);
  }

  // Enrich descriptions with connection context so labels describe
  // what each service does *in this project*, not just what it is generically.
  enrichDescriptionsWithConnections(nodes, edges);

  return { nodes, edges, dockerSnapshot: dockerSnapshot || null };
}

// Types where "used by X, Y" makes sense (infrastructure that serves other services)
const INFRA_TYPES = new Set(['database', 'cache', 'broker']);
// Types where "connects to X, Y" makes sense (application services that call infra)
const APP_TYPES = new Set(['backend', 'frontend', 'nodejs', 'python', 'worker', 'realtime']);

/**
 * Post-processing pass: enrich node descriptions with connection context.
 * Turns "Relational database for structured data" into
 * "Relational database — used by cart, payment" by looking at actual edges.
 */
function enrichDescriptionsWithConnections(nodes, edges) {
  if (edges.length === 0) return;

  const nodeById = new Map();
  for (const node of nodes) nodeById.set(node.id, node);

  // Build adjacency: for each node, collect the names of connected peers
  // inbound = services that connect TO this node; outbound = services this node connects TO
  const inbound = new Map();  // targetId -> Set of source node names
  const outbound = new Map(); // sourceId -> Set of target node names

  for (const edge of edges) {
    const src = nodeById.get(edge.source);
    const tgt = nodeById.get(edge.target);
    if (!src || !tgt) continue;

    // Use a clean display name — strip common prefixes
    const srcName = cleanDisplayName(src.name);
    const tgtName = cleanDisplayName(tgt.name);

    if (!inbound.has(edge.target)) inbound.set(edge.target, new Set());
    inbound.get(edge.target).add(srcName);

    if (!outbound.has(edge.source)) outbound.set(edge.source, new Set());
    outbound.get(edge.source).add(tgtName);
  }

  for (const node of nodes) {
    if (!node.description) continue;

    let suffix = null;

    if (INFRA_TYPES.has(node.type)) {
      // Infrastructure: show who uses it
      const clients = inbound.get(node.id);
      if (clients && clients.size > 0) {
        suffix = `used by ${[...clients].join(', ')}`;
      }
    } else if (APP_TYPES.has(node.type)) {
      // Application services: show what infra they connect to
      const deps = outbound.get(node.id);
      if (deps && deps.size > 0) {
        suffix = `connects to ${[...deps].join(', ')}`;
      }
    }

    if (suffix) {
      // Append connection context after a separator
      // Strip trailing period from base description for cleaner joining
      const base = node.description.replace(/\.\s*$/, '');
      node.description = `${base} · ${suffix}.`;
    }
  }
}

/**
 * Clean a container/service name for display in connection context.
 * Strips common prefixes like project names (e.g., "robotshop-rs-cart" → "rs-cart").
 */
function cleanDisplayName(name) {
  // Remove leading project prefixes that repeat the docker-compose project name
  // e.g. "robotshop_rs-cart_1" → "rs-cart"
  let clean = name
    .replace(/_\d+$/, '')      // strip trailing _1, _2 etc.
    .replace(/-\d+$/, '');     // strip trailing -1, -2 etc.

  // If the name has underscore segments (compose format), take the last meaningful part
  const underscoreParts = clean.split('_');
  if (underscoreParts.length > 1) {
    clean = underscoreParts.slice(1).join('_') || underscoreParts[0];
  }

  return clean;
}

/**
 * Infer node type from a compose service definition.
 * Uses the image name or service name to categorize.
 */
function inferTypeFromComposeService(service) {
  const imageName = (service.image || service.name || '').toLowerCase();
  return categorizeContainerImage(imageName);
}

/**
 * Add ghost nodes for compose services that are defined in docker-compose.yml
 * but not currently running as containers.
 */
function addComposeGhostNodes(nodes, edges, dockerSnapshot, projectPaths, containerHealthToGraphHealth) {
  const containers = dockerSnapshot.containers || [];
  const composeData = getComposeDefinedServices(containers, projectPaths);
  if (!composeData.composeFiles.length) return;

  // Build a set of running compose services: "projectName/serviceName"
  const runningComposeServices = new Set();
  for (const container of containers) {
    const project = container.labels?.['com.docker.compose.project'];
    const service = container.labels?.['com.docker.compose.service'];
    if (project && service) {
      runningComposeServices.add(`${project}/${service}`);
    }
  }

  // Build a map of existing node IDs for edge creation
  const nodeById = new Map();
  for (const node of nodes) nodeById.set(node.id, node);
  // Also index by compose service name for depends_on edges
  const nodeByComposeName = new Map();
  for (const node of nodes) {
    const composeService = node.containerImage ? null : null;
    // Match by name (compose service names often match container names)
    nodeByComposeName.set(node.name, node);
  }

  for (const composeFile of composeData.composeFiles) {
    const { filePath, projectName, projectPath, services } = composeFile;

    // Index compose services by name for ghost-to-ghost edges
    const ghostNodeIds = new Map(); // serviceName -> nodeId

    for (const service of services) {
      const composeKey = `${projectName}/${service.name}`;
      if (runningComposeServices.has(composeKey)) continue; // already running

      const nodeId = `compose-ghost-${projectName}-${service.name}`;
      const nodeType = inferTypeFromComposeService(service);

      const ghostNode = {
        id: nodeId,
        pid: -1,
        name: service.name,
        command: service.image ? `docker: ${service.image}` : `build: ${service.buildContext || service.name}`,
        type: nodeType,
        cpu: 0,
        memory: 0,
        user: 'docker',
        tty: null,
        project: projectName,
        projectPath: projectPath,
        repoPath: projectPath,
        description: getContainerDescription(service.image || service.name, nodeType) || 'Defined in docker-compose.yml but not running.',
        ports: service.ports.map(p => ({
          port: p.host,
          host: '0.0.0.0',
          description: `→ container:${p.container}`,
        })),
        routes: [],
        healthStatus: 'red',
        lastSeen: Date.now(),
        isDockerContainer: true,
        isGhost: true,
        isComposeGhost: true,
        composeProject: projectName,
        composeFile: filePath,
        containerId: null,
        containerImage: service.image || `${projectName}-${service.name}`,
        containerState: 'not started',
        containerStatus: 'Not running',
        containerHealth: null,
        containerNetworks: [],
        containerMounts: [],
        containerPorts: [],
        startCommand: `docker compose -f "${filePath}" up -d ${service.name}`,
        startProjectPath: projectPath,
      };

      nodes.push(ghostNode);
      nodeById.set(nodeId, ghostNode);
      ghostNodeIds.set(service.name, nodeId);
      nodeByComposeName.set(service.name, ghostNode);
    }

    // Create edges from depends_on
    for (const service of services) {
      const sourceId = ghostNodeIds.get(service.name)
        || findNodeIdByComposeName(nodes, projectName, service.name);
      if (!sourceId) continue;

      for (const dep of service.dependsOn) {
        const targetId = ghostNodeIds.get(dep)
          || findNodeIdByComposeName(nodes, projectName, dep);
        if (!targetId) continue;

        const edgeId = `compose-dep-${projectName}-${service.name}->${dep}`;
        edges.push({
          id: edgeId,
          source: sourceId,
          target: targetId,
          sourcePort: 0,
          targetPort: 0,
          protocol: 'compose-dependency',
          confidence: 0.7,
        });
      }
    }
  }
}

/**
 * Find a node ID matching a compose service name within a project.
 */
function findNodeIdByComposeName(nodes, projectName, serviceName) {
  for (const node of nodes) {
    if (!node.isDockerContainer) continue;
    // Match by compose labels (running containers)
    if (node.composeProject === projectName && node.name === serviceName) return node.id;
    // Match by name containing the service name
    if (node.name && node.name.includes(serviceName) && node.project === projectName) return node.id;
  }
  return null;
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

    const containerType = resolveContainerType(container);
    const node = {
      id: nodeId,
      pid: -1,
      name: container.name,
      command: (container.fullCommand || container.command)
        ? `docker: ${container.image} | ${container.fullCommand || container.command}`
        : `docker: ${container.image}`,
      type: containerType,
      cpu: container.cpu || 0,
      memory: container.memory || 0,
      user: 'docker',
      tty: null,
      project: containerProject,
      projectPath: containerProjectPath,
      repoPath: containerRepoPath,
      description: getContainerDescription(container.image, containerType),
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
  looksLikeRemoteAccessProcess,
  looksLikeRemoteAccessConnection,
  categorizeContainerImage,
  resolveContainerType,
  // Project/path helpers
  isLocalHost,
  inferProjectFromCommand,
  inferProjectPathFromCommand,
  PROJECT_MARKERS,
  findProjectRoot,
  findNearestProjectMarkerRoot,
  parseSshConfigText,
  resolveSshAliasWithMap,
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
