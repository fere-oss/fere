const { exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
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

// Wrapper process names that should show their script argument
const WRAPPER_NAMES = new Set(['node', 'python', 'python3', 'ruby']);

/**
 * Parse ps aux output into structured process data
 */
function parseProcesses(psOutput) {
  const lines = psOutput.trim().split('\n');
  const processes = [];

  // Skip header line
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // ps aux format: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;

    const [user, pid, cpu, mem, vsz, rss, tty, stat, start, time, ...cmdParts] = parts;
    const command = cmdParts.join(' ');

    processes.push({
      pid: parseInt(pid, 10),
      user,
      cpu: parseFloat(cpu),
      memory: parseFloat(mem),
      vsz: parseInt(vsz, 10),
      rss: parseInt(rss, 10),
      tty,
      status: stat,
      startTime: start,
      cpuTime: time,
      command,
      name: extractProcessName(command),
    });
  }

  return processes;
}

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
  return DEV_PATTERNS_RE.test(cmdLower);
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
      const { stdout } = await execAsync('ps aux');
      const data = parseProcesses(stdout);
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
  try {
    const { stdout } = await execFileAsync('ps', [
      '-p', String(pid),
      '-o', 'user,pid,%cpu,%mem,vsz,rss,tty,stat,start,time,command',
    ]);
    const processes = parseProcesses(stdout);
    return processes[0] || null;
  } catch (error) {
    return null;
  }
}

/**
 * Kill a process by PID
 */
async function killProcess(pid, signal = 'TERM') {
  // Whitelist allowed signals to prevent injection via the signal parameter.
  const ALLOWED_SIGNALS = new Set(['TERM', 'KILL', 'INT', 'HUP', 'QUIT']);
  const safeSignal = ALLOWED_SIGNALS.has(signal) ? signal : 'TERM';
  const pidStr = String(pid);

  try {
    await execFileAsync('kill', [`-${safeSignal}`, pidStr]);
    // Give the process a brief moment to exit
    await new Promise(resolve => setTimeout(resolve, 300));
    try {
      await execFileAsync('kill', ['-0', pidStr]);
      // Still alive, escalate to SIGKILL
      await execFileAsync('kill', ['-KILL', pidStr]);
    } catch (error) {
      // kill -0 failed, process is gone
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Lightweight PID enumeration (much cheaper than ps aux)
 */
async function getProcessPids() {
  try {
    const { stdout } = await execAsync('ps -eo pid');
    const pids = new Set();
    const lines = stdout.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const pid = parseInt(lines[i].trim(), 10);
      if (!isNaN(pid)) pids.add(pid);
    }
    return pids;
  } catch (error) {
    console.error('Error enumerating PIDs:', error);
    return new Set();
  }
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
