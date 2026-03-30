const platform = require('./platform');

const CACHE_TTL_MS = 5000;
const processCache = { timestamp: 0, data: [], promise: null };

// Dev-related process patterns to filter for
const DEV_PATTERNS = [
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'bun',
  'python', 'python3', 'pip', 'uvicorn', 'gunicorn', 'flask', 'django',
  'ruby', 'rails', 'bundle',
  'go', 'air',
  'java', 'gradle', 'maven', 'mvn',
  'rust', 'cargo',
  'php', 'composer', 'artisan',
  'redis-server', 'redis-cli',
  'postgres', 'psql', 'pg_',
  'mysql', 'mysqld',
  'mongo', 'mongod',
  'docker', 'docker-compose', 'podman',
  'ssh', 'sshd', 'sftp', 'scp', 'autossh', 'rsync',
  'nginx', 'apache', 'httpd',
  'webpack', 'vite', 'esbuild', 'rollup', 'parcel',
  'electron',
  'next', 'nuxt', 'gatsby',
  'uvicorn', 'fastapi',
  'deno',
];

// Pre-compiled regex from DEV_PATTERNS for O(1) amortized matching
const DEV_PATTERNS_RE = new RegExp(
  DEV_PATTERNS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
);

// IDE/editor background processes to exclude (language servers, extensions, etc.)
const IDE_EXCLUDE_PATTERNS = [
  // VS Code extensions & helpers
  'vscode-', '.vscode', 'extensionhost',
  'code helper', 'code - insiders helper',
  // Language servers
  'typescript-language-server', 'tsserver',
  'pylsp', 'pyright', 'jedi-language-server',
  'gopls', 'rust-analyzer', 'clangd', 'sourcekit-lsp',
  'jdtls', 'eclipse.jdt', 'redhat.java',
  'haskell-language-server', 'lua-language-server',
  'omnisharp', 'solargraph', 'sorbet', 'ruby-lsp',
  'tailwindcss-language-server', 'css-languageserver',
  'html-languageserver', 'json-languageserver',
  'yaml-language-server', 'bash-language-server',
  // JetBrains
  'jetbrains', 'intellij', 'pycharm', 'webstorm',
  'goland', 'rider', 'clion', 'phpstorm', 'rubymine',
  'datagrip', 'fsnotifier',
  // Generic language server pattern
  'language-server', 'languageserver', 'lsp-server',
];

const IDE_EXCLUDE_RE = new RegExp(
  IDE_EXCLUDE_PATTERNS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i'
);

// Wrapper process names that should show their script argument
const WRAPPER_NAMES = new Set(['node', 'python', 'python3', 'ruby']);

/**
 * Extract a clean process name from the full command
 */
function extractProcessName(command) {
  // Remove path prefixes
  const parts = command.split(' ')[0].split('/');
  let name = parts[parts.length - 1];

  // Handle common wrappers
  if (WRAPPER_NAMES.has(name)) {
    const args = command.split(' ');
    if (args.length > 1) {
      const script = args[1].split('/').pop();
      if (script && !script.startsWith('-')) {
        name = `${name}: ${script}`;
      }
    }
  }

  return name;
}

/**
 * Filter processes to only show dev-related ones
 */
function isDevProcess(process) {
  const cmdLower = process.command.toLowerCase();
  if (!DEV_PATTERNS_RE.test(cmdLower)) return false;
  return !IDE_EXCLUDE_RE.test(cmdLower);
}

function filterDevProcesses(processes) {
  return processes.filter(isDevProcess);
}

/**
 * Get all running processes
 */
async function getAllProcesses() {
  const now = Date.now();
  if (processCache.data.length && now - processCache.timestamp < CACHE_TTL_MS) {
    return processCache.data;
  }
  if (processCache.promise) {
    return processCache.promise;
  }

  processCache.promise = (async () => {
    try {
      const rawProcesses = await platform.getProcessList();
      // Decorate with extractProcessName (business logic stays here)
      const data = rawProcesses.map(proc => ({
        ...proc,
        name: extractProcessName(proc.command),
      }));
      processCache.data = data;
      processCache.timestamp = Date.now();
      processCache.promise = null;
      return data;
    } catch (error) {
      console.error('Error getting processes:', error);
      processCache.promise = null;
      return [];
    }
  })();

  return processCache.promise;
}

function getProcessCacheInfo() {
  return {
    timestamp: processCache.timestamp || 0,
  };
}

function clearProcessCache() {
  processCache.timestamp = 0;
  processCache.data = [];
  processCache.promise = null;
}

/**
 * Get only dev-related processes
 */
async function getDevProcesses() {
  const allProcesses = await getAllProcesses();
  return filterDevProcesses(allProcesses);
}

/**
 * Get process by PID
 */
async function getProcessByPid(pid) {
  const proc = await platform.getProcessInfoByPid(pid);
  if (!proc) return null;
  return { ...proc, name: extractProcessName(proc.command) };
}

/**
 * Kill a process by PID
 */
async function killProcess(pid, signal = 'TERM') {
  return platform.killProcess(pid, signal);
}

/**
 * Lightweight PID enumeration (much cheaper than full ps aux)
 */
async function getProcessPids() {
  return platform.enumeratePids();
}

// Re-export parseProcesses for backward compatibility (used in tests)
function parseProcesses(psOutput) {
  const rawProcesses = platform.parseProcessList(psOutput);
  return rawProcesses.map(proc => ({
    ...proc,
    name: extractProcessName(proc.command),
  }));
}

module.exports = {
  getAllProcesses,
  getDevProcesses,
  getProcessByPid,
  killProcess,
  parseProcesses,
  filterDevProcesses,
  isDevProcess,
  getProcessCacheInfo,
  clearProcessCache,
  getProcessPids,
};
