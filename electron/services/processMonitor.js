const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const CACHE_TTL_MS = 1000;
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
  if (name === 'node' || name === 'python' || name === 'python3') {
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
  const nameLower = process.name.toLowerCase();

  return DEV_PATTERNS.some(pattern =>
    cmdLower.includes(pattern) || nameLower.includes(pattern)
  );
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
    const { stdout } = await execAsync(`ps -p ${pid} -o user,pid,%cpu,%mem,vsz,rss,tty,stat,start,time,command`);
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
  try {
    await execAsync(`kill -${signal} ${pid}`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
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
};
