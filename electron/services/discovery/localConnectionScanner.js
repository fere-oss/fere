/**
 * localConnectionScanner.js
 *
 * Scans source files for localhost:PORT references to infer which ports a
 * service calls. Used to build static topology edges between local services
 * when live TCP connections aren't observable (e.g. between HTTP requests).
 */

const fs = require('fs');
const path = require('path');

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.rb', '.php', '.java', '.kt',
  '.swift', '.rs', '.vue', '.svelte',
]);

const ENV_FILES = [
  '.env', '.env.local', '.env.development',
  '.env.production', '.env.test',
];

const SKIP_DIRS = new Set([
  'node_modules', '.git', '__pycache__', 'venv', '.venv',
  'dist', 'build', '.next', '.cache', 'coverage',
  '.nvm', '.npm', '.yarn', '.pnpm-store',
  'test', 'tests', '__tests__', '__mocks__', 'docs',
]);

const MAX_FILES = 600;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB
const CACHE_TTL_MS = 30_000; // 30s — short enough to pick up new .env edits
const cache = new Map();

// Matches any localhost:PORT or 127.0.0.1:PORT reference
const LOCAL_PORT_RE = /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})\b/g;

function findFiles(dir, files = []) {
  if (files.length >= MAX_FILES) return files;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          findFiles(path.join(dir, entry.name), files);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTENSIONS.has(ext)) {
          files.push(path.join(dir, entry.name));
        }
      }
    }
  } catch {
    // Unreadable directory — skip
  }
  return files;
}

function extractPortsFromFile(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_BYTES) return [];
    // Skip test/mock/type-def files — they have localhost refs that aren't real calls
    const base = path.basename(filePath).toLowerCase();
    if (
      base.includes('.test.') || base.includes('.spec.') ||
      base.includes('.mock.') || base.endsWith('.d.ts')
    ) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const ports = new Set();
    LOCAL_PORT_RE.lastIndex = 0;
    let m;
    while ((m = LOCAL_PORT_RE.exec(content)) !== null) {
      const port = parseInt(m[1], 10);
      // Only record ports in the ephemeral/user-app range
      if (port >= 1024 && port <= 65535) ports.add(port);
    }
    return Array.from(ports);
  } catch {
    return [];
  }
}

/**
 * Scan a project directory for localhost:PORT references in source code and
 * .env files. Returns an array of port numbers that this project calls.
 * Results are cached for CACHE_TTL_MS.
 */
async function scanLocalConnections(projectPath) {
  if (!projectPath || !fs.existsSync(projectPath)) return [];

  const cached = cache.get(projectPath);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.ports;
  }

  const allPorts = new Set();

  // Code files
  const files = findFiles(projectPath);
  for (const file of files) {
    for (const port of extractPortsFromFile(file)) {
      allPorts.add(port);
    }
  }

  // .env files (often hold API base URLs like NEXT_PUBLIC_API_URL=http://localhost:8000)
  for (const envName of ENV_FILES) {
    const envPath = path.join(projectPath, envName);
    if (fs.existsSync(envPath)) {
      for (const port of extractPortsFromFile(envPath)) {
        allPorts.add(port);
      }
    }
  }

  const ports = Array.from(allPorts);
  cache.set(projectPath, { timestamp: Date.now(), ports });
  return ports;
}

function clearLocalConnectionCache(projectPath) {
  if (projectPath) {
    cache.delete(projectPath);
  } else {
    cache.clear();
  }
}

// ============================================
// Docker service hostname scanning (synchronous)
// ============================================

const dockerScanCache = new Map();
const DOCKER_SCAN_CACHE_TTL_MS = 30_000;

/**
 * Build a regex that matches service hostname references in source/config files.
 * Patterns detected (each captures the service name in group 1..4):
 *   1. ://serviceName            — URL scheme (mongodb://mongodb, redis://redis)
 *   2. serviceName:PORT          — host:port (catalogue:8080, mysql:3306)
 *   3. ['"]serviceName['"]       — exact quoted string ('redis', "catalogue")
 *   4. =serviceName\b            — bare value assignment (ENV X=redis, REDIS_HOST=redis)
 */
function buildServiceNameRegex(serviceNames) {
  if (serviceNames.size === 0) return null;
  const escaped = Array.from(serviceNames)
    .sort((a, b) => b.length - a.length)
    .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const alt = escaped.join('|');
  // G1: ://service               mongodb://mongodb, redis://redis
  // G2: service:PORT             catalogue:8080, mysql:3306
  // G3: @service                 amqp://guest:guest@rabbitmq/
  // G4: _HOST/_URL/_URI=service  REDIS_HOST=redis, MONGO_URL=mongodb (only host-typed vars)
  // G5: fallback/default         || 'redis', or 'redis', getenv('X', 'redis')
  // G6: host=service             mysql:host=mysql (PDO DSN), spring.rabbitmq.host=rabbitmq
  return new RegExp(
    `(?::\\/\\/(${alt})|(${alt}):\\d{2,5}|@(${alt})(?:[/:\\s]|$)|(?:_HOST|_HOSTNAME|_URL|_URI|_ADDR)=(${alt})\\b|(?:\\|\\||\\bor\\b|,)\\s*['"]?(${alt})['"]|\\bhost=(${alt})\\b)`,
    'g'
  );
}

/**
 * Synchronously scan sourceDir for references to Docker compose service hostnames.
 * Detects patterns like ://catalogue, redis:6379, mongodb://mongodb:27017.
 * Returns a Set<string> of service names referenced in the source code.
 * Results are cached for DOCKER_SCAN_CACHE_TTL_MS.
 */
function scanDockerServiceConnections(sourceDir, serviceNames) {
  if (!sourceDir || serviceNames.size === 0) return new Set();
  if (!fs.existsSync(sourceDir)) return new Set();

  const cacheKey = `${sourceDir}:${Array.from(serviceNames).sort().join(',')}`;
  const cached = dockerScanCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DOCKER_SCAN_CACHE_TTL_MS) {
    return cached.refs;
  }

  const regex = buildServiceNameRegex(serviceNames);
  if (!regex) return new Set();

  const allRefs = new Set();

  const extractRefs = (content) => {
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(content)) !== null) {
      const name = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (name && serviceNames.has(name)) allRefs.add(name);
    }
  };

  const files = findFiles(sourceDir);
  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_BYTES) continue;
      const base = path.basename(file).toLowerCase();
      if (
        base.includes('.test.') || base.includes('.spec.') ||
        base.includes('.mock.') || base.endsWith('.d.ts')
      ) continue;

      extractRefs(fs.readFileSync(file, 'utf8'));
    } catch { /* unreadable file — skip */ }
  }

  // Also scan Dockerfile and common config files not covered by CODE_EXTENSIONS
  const extraFiles = ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'];
  for (const name of extraFiles) {
    const filePath = path.join(sourceDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      extractRefs(fs.readFileSync(filePath, 'utf8'));
    } catch { /* skip */ }
  }

  // .env files often hold base URLs like REDIS_URL=redis://redis:6379
  for (const envName of ENV_FILES) {
    const envPath = path.join(sourceDir, envName);
    if (!fs.existsSync(envPath)) continue;
    try {
      extractRefs(fs.readFileSync(envPath, 'utf8'));
    } catch { /* skip */ }
  }

  dockerScanCache.set(cacheKey, { timestamp: Date.now(), refs: allRefs });
  return allRefs;
}

module.exports = { scanLocalConnections, clearLocalConnectionCache, scanDockerServiceConnections };
