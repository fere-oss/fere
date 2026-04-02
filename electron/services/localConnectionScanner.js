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

module.exports = { scanLocalConnections, clearLocalConnectionCache };
