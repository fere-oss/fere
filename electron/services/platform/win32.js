/**
 * Windows platform implementation.
 *
 * Provides the same exports as darwin.js using Windows equivalents:
 *   - Process list: `wmic process` (fast, gives command line) with `tasklist` fallback
 *   - Process kill: `taskkill`
 *   - Port monitoring: `netstat -ano` + PID→name enrichment via `tasklist`
 *   - CWD resolution: multi-strategy (command-line path extraction + ExecutablePath fallback)
 *   - Docker paths: Windows Docker Desktop locations
 *   - Shell ops: cmd.exe, wt.exe, where.exe
 */

const { exec, execFile, spawn, execFileSync } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================
// Process Monitoring
// ============================================

/**
 * Get process list via `wmic process`.
 *
 * wmic is deprecated but still ships with Windows 10/11 and is significantly
 * faster than PowerShell Get-CimInstance (~150ms vs ~600ms). We use it as the
 * primary path and fall back to PowerShell if it's unavailable.
 *
 * Returns the same shape as darwin: { pid, user, cpu, memory, vsz, rss, tty,
 * status, startTime, cpuTime, command }.
 *
 * NOTE: Instantaneous CPU% is not available from a single wmic/tasklist
 * snapshot on Windows (it requires sampling over a time interval). We return 0
 * for cpu and compute memory% from WorkingSetSize / total physical memory.
 */
async function getProcessList() {
  try {
    return await getProcessListViaWmic();
  } catch (error) {
    // wmic not available (removed in future Windows builds) — fall back
    try {
      return await getProcessListViaPowerShell();
    } catch (psError) {
      console.error('Error getting process list:', psError);
      return [];
    }
  }
}

/**
 * Primary: wmic process get … /format:csv
 *
 * Output looks like (first line blank, second is header):
 *   Node,CommandLine,Name,ProcessId,VirtualSize,WorkingSetSize
 *   DESKTOP-ABC,cmd.exe /c node app.js,node.exe,1234,123456789,65536
 */
async function getProcessListViaWmic() {
  const { stdout } = await execAsync(
    'wmic process get ProcessId,Name,CommandLine,WorkingSetSize,VirtualSize /format:csv',
    { maxBuffer: 10 * 1024 * 1024, timeout: 10000 }
  );
  return parseWmicCsv(stdout);
}

function parseWmicCsv(stdout) {
  const totalMemBytes = os.totalmem();
  const lines = stdout.trim().split('\r\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // First non-empty line is the header
  const header = lines[0].split(',').map(h => h.trim());
  const idxPid = header.indexOf('ProcessId');
  const idxName = header.indexOf('Name');
  const idxCmd = header.indexOf('CommandLine');
  const idxWs = header.indexOf('WorkingSetSize');
  const idxVs = header.indexOf('VirtualSize');

  if (idxPid === -1 || idxName === -1) return [];

  const processes = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseWmicCsvLine(lines[i], header.length);
    if (!cols || cols.length < header.length) continue;

    const pid = parseInt(cols[idxPid], 10);
    if (isNaN(pid) || pid === 0) continue; // skip System Idle Process

    const ws = parseInt(cols[idxWs], 10) || 0;
    const vs = parseInt(cols[idxVs], 10) || 0;
    const command = (cols[idxCmd] || cols[idxName] || '').trim();

    processes.push({
      pid,
      user: '', // wmic doesn't include owner without a slow sub-query
      cpu: 0,   // requires sampling; not available from single snapshot
      memory: totalMemBytes > 0 ? parseFloat(((ws / totalMemBytes) * 100).toFixed(1)) : 0,
      vsz: Math.round(vs / 1024),     // KB, matching ps aux convention
      rss: Math.round(ws / 1024),     // KB
      tty: '',
      status: 'running',
      startTime: '',
      cpuTime: '',
      command,
    });
  }

  return processes;
}

/**
 * Parse a single CSV line from wmic output.
 *
 * wmic CSV is tricky: CommandLine can contain commas (e.g. `node app.js,--port 3000`).
 * wmic does NOT quote fields that contain commas, so we can't use a simple split.
 *
 * Strategy: wmic CSV always starts with the Node (hostname) column.
 * We know the total column count from the header. The first column (Node) and the
 * last N-2 columns are simple values. Everything between the Node column and the
 * simple trailing columns belongs to CommandLine (which is the problematic field).
 */
function parseWmicCsvLine(line, expectedCols) {
  // wmic output has Node as the first column (the hostname)
  // We requested: ProcessId,Name,CommandLine,WorkingSetSize,VirtualSize
  // wmic outputs:  Node,CommandLine,Name,ProcessId,VirtualSize,WorkingSetSize
  // (it alphabetizes and prepends Node)
  //
  // Since CommandLine can have commas, split from the right for known-simple columns,
  // then the remainder is CommandLine.

  const parts = line.split(',');
  if (parts.length < expectedCols) return null;

  if (parts.length === expectedCols) {
    // No commas in CommandLine — straightforward
    return parts;
  }

  // CommandLine had commas. We know: Node is col 0, and the last (expectedCols - 2)
  // columns are simple. Reconstruct CommandLine from the middle.
  const simpleTrailingCount = expectedCols - 2; // all columns except Node and CommandLine
  const result = [];
  result.push(parts[0]); // Node
  // CommandLine = everything from index 1 to (parts.length - simpleTrailingCount - 1)
  const cmdEnd = parts.length - simpleTrailingCount;
  result.push(parts.slice(1, cmdEnd).join(','));
  // Remaining simple columns
  for (let j = cmdEnd; j < parts.length; j++) {
    result.push(parts[j]);
  }
  return result;
}

/**
 * Fallback: PowerShell Get-CimInstance (slower but future-proof).
 */
async function getProcessListViaPowerShell() {
  const psCmd = [
    'Get-CimInstance Win32_Process',
    '| Select-Object ProcessId,Name,CommandLine,WorkingSetSize,VirtualSize',
    '| ConvertTo-Json -Compress',
  ].join(' ');

  const { stdout } = await execAsync(
    `powershell -NoProfile -NoLogo -Command "${psCmd}"`,
    { maxBuffer: 10 * 1024 * 1024, timeout: 15000 }
  );

  const totalMemBytes = os.totalmem();
  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }

  // PowerShell returns a single object (not array) when there's exactly one result
  if (!Array.isArray(raw)) raw = [raw];

  return raw
    .filter(p => p.ProcessId > 0)
    .map(p => {
      const ws = p.WorkingSetSize || 0;
      const vs = p.VirtualSize || 0;
      const command = (p.CommandLine || p.Name || '').trim();
      return {
        pid: p.ProcessId,
        user: '',
        cpu: 0,
        memory: totalMemBytes > 0 ? parseFloat(((ws / totalMemBytes) * 100).toFixed(1)) : 0,
        vsz: Math.round(vs / 1024),
        rss: Math.round(ws / 1024),
        tty: '',
        status: 'running',
        startTime: '',
        cpuTime: '',
        command,
      };
    });
}

/**
 * Parse process list output.
 * On Windows we accept both wmic CSV and PowerShell JSON.
 * Provided for API compatibility with darwin — callers shouldn't need this directly.
 */
function parseProcessList(rawOutput) {
  // Try JSON first (PowerShell output)
  try {
    const data = JSON.parse(rawOutput);
    const arr = Array.isArray(data) ? data : [data];
    const totalMemBytes = os.totalmem();
    return arr
      .filter(p => p.ProcessId > 0)
      .map(p => ({
        pid: p.ProcessId,
        user: '',
        cpu: 0,
        memory: totalMemBytes > 0 ? parseFloat((((p.WorkingSetSize || 0) / totalMemBytes) * 100).toFixed(1)) : 0,
        vsz: Math.round((p.VirtualSize || 0) / 1024),
        rss: Math.round((p.WorkingSetSize || 0) / 1024),
        tty: '',
        status: 'running',
        startTime: '',
        cpuTime: '',
        command: (p.CommandLine || p.Name || '').trim(),
      }));
  } catch {
    // Fall back to wmic CSV parsing
    return parseWmicCsv(rawOutput);
  }
}

/**
 * Get info for a single process by PID.
 */
async function getProcessInfoByPid(pid) {
  try {
    const { stdout } = await execAsync(
      `wmic process where ProcessId=${parseInt(pid, 10)} get ProcessId,Name,CommandLine,WorkingSetSize,VirtualSize /format:csv`,
      { timeout: 5000 }
    );
    const processes = parseWmicCsv(stdout);
    return processes[0] || null;
  } catch {
    // Fallback to tasklist for basic info
    try {
      const { stdout } = await execAsync(
        `tasklist /fi "PID eq ${parseInt(pid, 10)}" /fo csv /v`,
        { timeout: 5000 }
      );
      return parseTasklistForPid(stdout, pid);
    } catch {
      return null;
    }
  }
}

/**
 * Parse tasklist CSV output for a single PID.
 * tasklist /v /fo csv header:
 *   "Image Name","PID","Session Name","Session#","Mem Usage","Status","User Name","CPU Time","Window Title"
 */
function parseTasklistForPid(stdout, targetPid) {
  const lines = stdout.trim().split('\r\n').filter(l => l.trim());
  if (lines.length < 2) return null;

  const totalMemBytes = os.totalmem();

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols || cols.length < 9) continue;

    const pid = parseInt(cols[1], 10);
    if (pid !== parseInt(targetPid, 10)) continue;

    // Mem Usage is like "12,345 K" — extract number
    const memStr = cols[4].replace(/[^0-9]/g, '');
    const memKb = parseInt(memStr, 10) || 0;

    return {
      pid,
      user: cols[6] || '',
      cpu: 0,
      memory: totalMemBytes > 0 ? parseFloat(((memKb * 1024 / totalMemBytes) * 100).toFixed(1)) : 0,
      vsz: 0,
      rss: memKb,
      tty: '',
      status: cols[5] || 'running',
      startTime: '',
      cpuTime: cols[7] || '',
      command: cols[0] || '',
    };
  }

  return null;
}

/**
 * Parse a standard quoted CSV line (handles quoted fields with commas).
 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

/**
 * Kill a process by PID.
 *
 * Windows has no POSIX signals. `taskkill` without /F sends WM_CLOSE (only
 * works for GUI apps with a message loop). For dev processes (node, python,
 * etc.) we almost always need /F (force).
 *
 * Strategy: try graceful first (WM_CLOSE), wait briefly, then force kill.
 */
async function killProcess(pid, signal = 'TERM') {
  const pidStr = String(parseInt(pid, 10));

  try {
    if (signal === 'KILL') {
      // Immediate force kill
      await execAsync(`taskkill /PID ${pidStr} /F /T`);
      return { success: true };
    }

    // Try graceful first (WM_CLOSE)
    try {
      await execAsync(`taskkill /PID ${pidStr}`);
    } catch {
      // Graceful failed (no message loop) — that's expected for CLI processes
    }

    // Wait briefly, then check if still alive
    await new Promise(resolve => setTimeout(resolve, 300));

    try {
      // Check if process still exists
      await execAsync(`tasklist /fi "PID eq ${pidStr}" /fo csv /nh`);
      // Parse output — if it contains the PID, process is still alive
      // tasklist returns "INFO: No tasks are running which match the specified criteria."
      // when the process is gone
    } catch {
      // tasklist failed, process likely gone
      return { success: true };
    }

    // Still alive — force kill with /F /T (force + kill child processes)
    await execAsync(`taskkill /PID ${pidStr} /F /T`);
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Lightweight PID enumeration.
 * Uses `tasklist /fo csv /nh` which is faster than wmic for just PIDs.
 */
async function enumeratePids() {
  try {
    const { stdout } = await execAsync('tasklist /fo csv /nh', { timeout: 10000 });
    const pids = new Set();
    const lines = stdout.trim().split('\r\n');
    for (const line of lines) {
      if (line.startsWith('"INFO:')) continue;
      const cols = parseCsvLine(line);
      if (cols && cols.length >= 2) {
        const pid = parseInt(cols[1], 10);
        if (!isNaN(pid) && pid > 0) pids.add(pid);
      }
    }
    return pids;
  } catch (error) {
    console.error('Error enumerating PIDs:', error);
    return new Set();
  }
}

// ============================================
// Port & Connection Monitoring
// ============================================

/*
 * Windows `netstat -ano` output format:
 *
 *   Active Connections
 *
 *     Proto  Local Address          Foreign Address        State           PID
 *     TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234
 *     TCP    127.0.0.1:3000         0.0.0.0:0              LISTENING       5678
 *     TCP    [::]:445               [::]:0                 LISTENING       4
 *     TCP    192.168.1.5:49876      52.114.128.40:443      ESTABLISHED     9012
 *     TCP    [::1]:3000             [::1]:49877            ESTABLISHED     5678
 *
 * Unlike lsof, netstat gives PID but not process name. We build a PID→name
 * lookup from `tasklist` to enrich the results.
 */

/**
 * Regex for a netstat -ano TCP line.
 * Groups: 1=proto, 2=local address, 3=foreign address, 4=state, 5=pid
 */
const NETSTAT_LINE_RE = /^\s*(TCP|UDP)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\s*$/i;

/**
 * Parse a host:port string from netstat output.
 * Handles both IPv4 ("0.0.0.0:135") and IPv6 ("[::]:445", "[::1]:3000").
 */
function parseNetstatAddr(addr) {
  if (!addr) return null;

  // IPv6: [::]:port or [::1]:port
  const ipv6Match = addr.match(/^\[([^\]]*)\]:(\d+)$/);
  if (ipv6Match) {
    return { host: ipv6Match[1] || '::', port: parseInt(ipv6Match[2], 10) };
  }

  // IPv4: host:port — split on last colon
  const lastColon = addr.lastIndexOf(':');
  if (lastColon === -1) return null;

  const host = addr.slice(0, lastColon) || '*';
  const port = parseInt(addr.slice(lastColon + 1), 10);
  if (isNaN(port)) return null;

  return { host, port };
}

/**
 * Build a PID → process name map from `tasklist /fo csv /nh`.
 * This is fast (~50ms) and doesn't require admin.
 */
async function buildPidNameMap() {
  const pidMap = new Map();
  try {
    const { stdout } = await execAsync('tasklist /fo csv /nh', {
      timeout: 5000,
      maxBuffer: 5 * 1024 * 1024,
    });
    for (const line of stdout.trim().split('\r\n')) {
      if (line.startsWith('"INFO:')) continue;
      const cols = parseCsvLine(line);
      if (cols && cols.length >= 2) {
        const name = cols[0];
        const pid = parseInt(cols[1], 10);
        if (!isNaN(pid) && name) {
          pidMap.set(pid, name);
        }
      }
    }
  } catch {
    // Non-fatal — process names will just be empty
  }
  return pidMap;
}

/**
 * Run `netstat -ano` and parse all TCP lines.
 * Returns { listening: [...], established: [...] }.
 */
async function parseNetstatOutput(rawOutput) {
  const lines = rawOutput.trim().split(/\r?\n/);
  const listening = [];
  const established = [];

  for (const line of lines) {
    const match = line.match(NETSTAT_LINE_RE);
    if (!match) continue;

    const [, proto, localAddr, foreignAddr, state, pidStr] = match;
    // We only handle TCP (UDP has no state column in the same format)
    if (proto.toUpperCase() !== 'TCP') continue;

    const pid = parseInt(pidStr, 10);
    const local = parseNetstatAddr(localAddr);
    if (!local) continue;

    const stateUpper = state.toUpperCase();

    if (stateUpper === 'LISTENING') {
      listening.push({ local, pid });
    } else if (stateUpper === 'ESTABLISHED') {
      const remote = parseNetstatAddr(foreignAddr);
      if (!remote) continue;
      established.push({ local, remote, pid });
    }
  }

  return { listening, established };
}

/**
 * Fetch listening TCP ports.
 * Returns array of { port, host, pid, process, user, protocol, fd }.
 */
async function fetchListeningPorts() {
  try {
    const [{ stdout }, pidMap] = await Promise.all([
      execAsync('netstat -ano -p tcp', { timeout: 10000, maxBuffer: 5 * 1024 * 1024 }),
      buildPidNameMap(),
    ]);

    const { listening } = await parseNetstatOutput(stdout);

    // Deduplicate by port+pid (same process can listen on multiple addresses for same port)
    const uniquePorts = new Map();
    for (const entry of listening) {
      const key = `${entry.local.port}-${entry.pid}`;
      if (uniquePorts.has(key)) continue;

      uniquePorts.set(key, {
        port: entry.local.port,
        host: entry.local.host,
        pid: entry.pid,
        process: pidMap.get(entry.pid) || '',
        user: '',      // netstat doesn't provide user; would need Get-Process
        protocol: 'tcp',
        fd: '',        // no FD concept in netstat
      });
    }

    return Array.from(uniquePorts.values());
  } catch (error) {
    console.error('Error getting listening ports:', error);
    return [];
  }
}

/**
 * Parse raw netstat output for listening ports.
 * For API compatibility with darwin — used by portMonitor.js re-export.
 */
function parseListeningPorts(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) return [];

  const lines = rawOutput.trim().split(/\r?\n/);
  const ports = [];

  for (const line of lines) {
    const match = line.match(NETSTAT_LINE_RE);
    if (!match) continue;

    const [, proto, localAddr, , state, pidStr] = match;
    if (proto.toUpperCase() !== 'TCP') continue;
    if (state.toUpperCase() !== 'LISTENING') continue;

    const local = parseNetstatAddr(localAddr);
    if (!local) continue;

    const pid = parseInt(pidStr, 10);

    ports.push({
      port: local.port,
      host: local.host,
      pid,
      process: '',
      user: '',
      protocol: 'tcp',
      fd: '',
    });
  }

  // Deduplicate by port+pid
  const unique = new Map();
  for (const p of ports) {
    const key = `${p.port}-${p.pid}`;
    if (!unique.has(key)) unique.set(key, p);
  }
  return Array.from(unique.values());
}

/**
 * Fetch established TCP connections.
 * Returns array of { pid, process, user, localHost, localPort, remoteHost, remotePort, protocol }.
 */
async function fetchEstablishedConnections() {
  try {
    const [{ stdout }, pidMap] = await Promise.all([
      execAsync('netstat -ano -p tcp', { timeout: 10000, maxBuffer: 5 * 1024 * 1024 }),
      buildPidNameMap(),
    ]);

    const { established } = await parseNetstatOutput(stdout);

    return established.map(entry => ({
      pid: entry.pid,
      process: pidMap.get(entry.pid) || '',
      user: '',
      localHost: entry.local.host,
      localPort: entry.local.port,
      remoteHost: entry.remote.host,
      remotePort: entry.remote.port,
      protocol: 'tcp',
    }));
  } catch (error) {
    console.error('Error getting connections:', error);
    return [];
  }
}

/**
 * Parse raw netstat output for established connections.
 * For API compatibility with darwin.
 */
function parseEstablishedConnections(rawOutput) {
  if (!rawOutput || !rawOutput.trim()) return [];

  const lines = rawOutput.trim().split(/\r?\n/);
  const connections = [];

  for (const line of lines) {
    const match = line.match(NETSTAT_LINE_RE);
    if (!match) continue;

    const [, proto, localAddr, foreignAddr, state, pidStr] = match;
    if (proto.toUpperCase() !== 'TCP') continue;
    if (state.toUpperCase() !== 'ESTABLISHED') continue;

    const local = parseNetstatAddr(localAddr);
    const remote = parseNetstatAddr(foreignAddr);
    if (!local || !remote) continue;

    connections.push({
      pid: parseInt(pidStr, 10),
      process: '',
      user: '',
      localHost: local.host,
      localPort: local.port,
      remoteHost: remote.host,
      remotePort: remote.port,
      protocol: 'tcp',
    });
  }

  return connections;
}

/**
 * Fetch process info on a specific port.
 */
async function fetchProcessOnPort(port) {
  try {
    const results = await fetchListeningPorts();
    return results.find(p => p.port === port) || null;
  } catch {
    return null;
  }
}

/**
 * Lightweight listening port number enumeration.
 * Faster path: parse netstat ourselves without the PID→name enrichment.
 */
async function fetchListeningPortNumbers() {
  try {
    const { stdout } = await execAsync('netstat -ano -p tcp', {
      timeout: 10000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const ports = new Set();
    for (const line of stdout.trim().split(/\r?\n/)) {
      const match = line.match(NETSTAT_LINE_RE);
      if (!match) continue;

      const [, proto, localAddr, , state] = match;
      if (proto.toUpperCase() !== 'TCP') continue;
      if (state.toUpperCase() !== 'LISTENING') continue;

      const local = parseNetstatAddr(localAddr);
      if (local) ports.add(local.port);
    }
    return ports;
  } catch (error) {
    return new Set();
  }
}

// ============================================
// CWD Resolution
// ============================================

/*
 * Windows has no `lsof -d cwd` equivalent. The actual CWD lives in the PEB
 * (Process Environment Block) and requires either native code or Sysinternals
 * handle.exe to read — neither is practical for a desktop app.
 *
 * Instead we use a multi-strategy approach to infer the working directory:
 *
 *   Strategy 1 — Command-line path extraction (best signal)
 *     Dev tools like `node`, `python`, `ruby`, `go` typically have a script
 *     or source file as an argument. An absolute path like
 *     `C:\Users\dev\myapp\server.js` tells us the project lives in
 *     `C:\Users\dev\myapp`. Even a relative path can help when combined
 *     with the executable location.
 *
 *   Strategy 2 — ExecutablePath directory
 *     For compiled binaries or processes where the command line has no useful
 *     paths, the exe's parent directory is a reasonable fallback.
 *     e.g. `C:\Users\dev\myapp\node_modules\.bin\next.cmd` → project nearby.
 *
 *   Strategy 3 — Walk up from either path looking for project markers
 *     This is done downstream by findProjectRoot() in graphFunctions.js.
 *     Our job here is to give it the best starting point.
 *
 * The result feeds into connectionGraph.js where findProjectRoot(cwd) walks
 * upward to find .git / package.json / etc. So even an approximate path
 * that's inside the project tree is sufficient.
 */

/**
 * Use path.win32 for all Windows path operations — path.dirname/extname use
 * POSIX rules on macOS/Linux and would return '.' for 'C:\foo\bar'.
 */
const win32Path = path.win32;

/**
 * Regex to match absolute Windows paths in a command line.
 * Two capture groups: one for quoted paths (may contain spaces), one for unquoted.
 */
const WIN_QUOTED_PATH_RE = /"([A-Za-z]:[/\\][^"]+)"/g;
const WIN_UNQUOTED_PATH_RE = /(?:^|\s|=)([A-Za-z]:[/\\][^\s"';<>|*?]+)/g;

/**
 * Runtimes whose first file argument is the script/entry point.
 * The value indicates the typical argument position pattern.
 */
const SCRIPT_RUNTIMES = new Set([
  'node', 'node.exe',
  'python', 'python.exe', 'python3', 'python3.exe',
  'ruby', 'ruby.exe',
  'php', 'php.exe',
  'go', 'go.exe',
  'deno', 'deno.exe',
  'bun', 'bun.exe',
  'java', 'java.exe', 'javaw.exe',
  'ts-node', 'ts-node.exe',
  'npx', 'npx.exe', 'npx.cmd',
  'uvicorn', 'gunicorn', 'flask', 'django-admin',
]);

/**
 * Extract the best candidate working directory from a command line string.
 *
 * Returns an absolute directory path, or null if nothing useful found.
 */
function extractCwdFromCommandLine(commandLine) {
  if (!commandLine) return null;

  // Collect all absolute paths from the command line.
  // Check quoted paths first (handles spaces), then unquoted.
  const paths = [];
  let match;

  WIN_QUOTED_PATH_RE.lastIndex = 0;
  while ((match = WIN_QUOTED_PATH_RE.exec(commandLine)) !== null) {
    paths.push(normalizeToBs(match[1]));
  }

  WIN_UNQUOTED_PATH_RE.lastIndex = 0;
  while ((match = WIN_UNQUOTED_PATH_RE.exec(commandLine)) !== null) {
    const p = normalizeToBs(match[1]);
    // Skip if already found via quoted regex
    if (!paths.includes(p)) paths.push(p);
  }

  if (paths.length === 0) return null;

  // First path is usually the executable, rest are arguments
  const exePath = paths[0];
  const argPaths = paths.slice(1);

  // Prefer argument paths that look like source files (not the exe itself)
  for (const p of argPaths) {
    const lower = p.toLowerCase();
    if (lower.startsWith('c:\\windows\\')) continue;
    if (lower.startsWith('c:\\program files')) continue;
    if (lower.includes('\\node_modules\\.bin\\')) continue;

    // If it has a file extension, use its parent directory
    const ext = win32Path.extname(p).toLowerCase();
    if (ext) {
      return win32Path.dirname(p);
    }
    // Otherwise treat it as a directory path
    return p;
  }

  // No useful argument paths — fall back to the exe's directory,
  // but skip well-known system/runtime directories
  if (exePath) {
    return exeDirOrNull(exePath);
  }

  return null;
}

/**
 * Normalize forward slashes to backslashes and strip trailing backslash.
 */
function normalizeToBs(p) {
  let out = p.replace(/\//g, '\\');
  if (out.length > 3 && out.endsWith('\\')) out = out.slice(0, -1);
  return out;
}

/**
 * Return the exe's parent directory, or null if it's a system/runtime path.
 */
function exeDirOrNull(exePath) {
  const lower = exePath.toLowerCase();
  if (lower.startsWith('c:\\windows\\')) return null;
  if (lower.includes('\\program files\\')) return null;
  if (lower.includes('\\program files (x86)\\')) return null;
  if (lower.includes('\\appdata\\local\\programs\\python')) return null;
  // Unquoted "C:\Program" from split at space in "Program Files"
  if (/^[a-z]:\\program$/i.test(lower)) return null;

  // node_modules/.bin scripts live inside the project — go up past node_modules
  const nmIdx = lower.indexOf('\\node_modules\\');
  if (nmIdx !== -1) {
    return exePath.slice(0, nmIdx);
  }
  return win32Path.dirname(exePath);
}

/**
 * Batch CWD lookup for multiple PIDs.
 *
 * Fetches CommandLine + ExecutablePath via wmic and applies the multi-strategy
 * extraction above. Falls back to PowerShell if wmic is unavailable.
 *
 * @param {number[]} pids
 * @returns {Promise<Map<number, string|null>>}
 */
async function batchResolveCwds(pids) {
  if (pids.length === 0) return new Map();

  const result = new Map();

  try {
    const data = await fetchProcessPathData(pids);

    for (const { pid, commandLine, executablePath } of data) {
      // Strategy 1: extract from command line
      let cwd = extractCwdFromCommandLine(commandLine);

      // Strategy 2: fall back to executable path directory
      if (!cwd && executablePath) {
        cwd = exeDirOrNull(executablePath);
      }

      result.set(pid, cwd || null);
    }
  } catch (error) {
    // Non-fatal — return what we have
  }

  // Fill in nulls for PIDs without results
  for (const pid of pids) {
    if (!result.has(pid)) {
      result.set(pid, null);
    }
  }
  return result;
}

/**
 * Fetch CommandLine + ExecutablePath for a set of PIDs.
 * Primary: wmic (fast). Fallback: PowerShell.
 * @returns {Promise<Array<{pid: number, commandLine: string, executablePath: string}>>}
 */
async function fetchProcessPathData(pids) {
  try {
    return await fetchProcessPathDataViaWmic(pids);
  } catch {
    return await fetchProcessPathDataViaPowerShell(pids);
  }
}

async function fetchProcessPathDataViaWmic(pids) {
  // wmic has a WHERE clause length limit (~8000 chars). For very large PID
  // lists, batch into chunks.
  const CHUNK_SIZE = 200;
  const allResults = [];

  for (let i = 0; i < pids.length; i += CHUNK_SIZE) {
    const chunk = pids.slice(i, i + CHUNK_SIZE);
    const pidFilter = chunk.map(p => `ProcessId=${p}`).join(' OR ');
    const { stdout } = await execAsync(
      `wmic process where "${pidFilter}" get ProcessId,CommandLine,ExecutablePath /format:csv`,
      { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
    );

    const lines = stdout.trim().split('\r\n').filter(l => l.trim());
    if (lines.length < 2) continue;

    const header = lines[0].split(',').map(h => h.trim());
    const idxPid = header.indexOf('ProcessId');
    const idxCmd = header.indexOf('CommandLine');
    const idxExe = header.indexOf('ExecutablePath');

    for (let j = 1; j < lines.length; j++) {
      // CommandLine can contain commas — use the same right-split strategy
      const cols = parseWmicCsvLine(lines[j], header.length);
      if (!cols || cols.length < header.length) continue;

      const pid = parseInt(cols[idxPid], 10);
      if (isNaN(pid)) continue;

      allResults.push({
        pid,
        commandLine: (cols[idxCmd] || '').trim(),
        executablePath: (cols[idxExe] || '').trim(),
      });
    }
  }

  return allResults;
}

async function fetchProcessPathDataViaPowerShell(pids) {
  const pidList = pids.join(',');
  const psCmd = [
    `Get-CimInstance Win32_Process -Filter "ProcessId IN (${pidList})"`,
    '| Select-Object ProcessId,CommandLine,ExecutablePath',
    '| ConvertTo-Json -Compress',
  ].join(' ');

  const { stdout } = await execAsync(
    `powershell -NoProfile -NoLogo -Command "${psCmd}"`,
    { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }
  );

  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(raw)) raw = [raw];

  return raw.map(p => ({
    pid: p.ProcessId,
    commandLine: (p.CommandLine || '').trim(),
    executablePath: (p.ExecutablePath || '').trim(),
  }));
}

/**
 * Single-PID CWD lookup.
 */
async function resolveCwd(pid) {
  const map = await batchResolveCwds([pid]);
  return map.get(pid) || null;
}

// ============================================
// Docker Binary Paths
// ============================================

const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
  'C:\\Program Files\\Docker\\Docker\\Docker.exe',
  path.join(os.homedir(), 'AppData', 'Local', 'Docker', 'resources', 'bin', 'docker.exe'),
  'docker',
].filter(Boolean);

// ============================================
// Known System Services (Windows-specific)
// ============================================

const PLATFORM_KNOWN_SERVICES = {
  'svchost.exe': { description: 'Windows Service Host - hosts multiple Windows services in shared processes.', category: 'system', displayName: 'Service Host' },
  'svchost': { description: 'Windows Service Host - hosts multiple Windows services in shared processes.', category: 'system', displayName: 'Service Host' },
  'explorer.exe': { description: 'Windows Explorer - provides the desktop, taskbar, and file browsing experience.', category: 'system', displayName: 'Explorer' },
  'explorer': { description: 'Windows Explorer - provides the desktop, taskbar, and file browsing experience.', category: 'system', displayName: 'Explorer' },
  'dwm.exe': { description: 'Desktop Window Manager - composites windows and handles visual effects.', category: 'system', displayName: 'Desktop Window Manager' },
  'dwm': { description: 'Desktop Window Manager - composites windows and handles visual effects.', category: 'system', displayName: 'Desktop Window Manager' },
  'csrss.exe': { description: 'Client/Server Runtime - manages console windows and thread creation.', category: 'system', displayName: 'Client Server Runtime' },
  'csrss': { description: 'Client/Server Runtime - manages console windows and thread creation.', category: 'system', displayName: 'Client Server Runtime' },
  'lsass.exe': { description: 'Local Security Authority - handles authentication and security policy enforcement.', category: 'system', displayName: 'Local Security Authority' },
  'lsass': { description: 'Local Security Authority - handles authentication and security policy enforcement.', category: 'system', displayName: 'Local Security Authority' },
  'services.exe': { description: 'Service Control Manager - starts and manages Windows services.', category: 'system', displayName: 'Service Control Manager' },
  'services': { description: 'Service Control Manager - starts and manages Windows services.', category: 'system', displayName: 'Service Control Manager' },
  'wininit.exe': { description: 'Windows Initialization - starts critical system services during boot.', category: 'system', displayName: 'Windows Init' },
  'winlogon.exe': { description: 'Windows Logon - handles user login, logout, and secure attention sequence.', category: 'system', displayName: 'Windows Logon' },
  'taskhostw.exe': { description: 'Task Host Window - runs scheduled tasks and background work items.', category: 'system', displayName: 'Task Host' },
  'taskhostw': { description: 'Task Host Window - runs scheduled tasks and background work items.', category: 'system', displayName: 'Task Host' },
  'RuntimeBroker.exe': { description: 'Runtime Broker - manages permissions for UWP/Store apps.', category: 'system', displayName: 'Runtime Broker' },
  'RuntimeBrok': { description: 'Runtime Broker - manages permissions for UWP/Store apps.', category: 'system', displayName: 'Runtime Broker' },
  'SearchHost.exe': { description: 'Windows Search - provides Start menu search and file indexing.', category: 'system', displayName: 'Windows Search' },
  'SearchHost': { description: 'Windows Search - provides Start menu search and file indexing.', category: 'system', displayName: 'Windows Search' },
  'SearchIndexer.exe': { description: 'Windows Search Indexer - indexes files for fast searching.', category: 'system', displayName: 'Search Indexer' },
  'ShellExperienceHost.exe': { description: 'Shell Experience Host - renders Start menu, Action Center, and taskbar.', category: 'system', displayName: 'Shell Experience' },
  'StartMenuExperienceHost.exe': { description: 'Start Menu - renders the Windows Start menu.', category: 'system', displayName: 'Start Menu' },
  'TextInputHost.exe': { description: 'Text Input Host - handles touch keyboard and handwriting input.', category: 'system', displayName: 'Text Input' },
  'spoolsv.exe': { description: 'Print Spooler - manages print jobs and printer communication.', category: 'system', displayName: 'Print Spooler' },
  'WmiPrvSE.exe': { description: 'WMI Provider Host - handles Windows Management Instrumentation queries.', category: 'system', displayName: 'WMI Provider' },
  'wlanext.exe': { description: 'Windows WLAN Extension - manages Wi-Fi connections and configuration.', category: 'network', displayName: 'WLAN Extension' },
  'conhost.exe': { description: 'Console Window Host - hosts command prompt and PowerShell windows.', category: 'system', displayName: 'Console Host' },
  'conhost': { description: 'Console Window Host - hosts command prompt and PowerShell windows.', category: 'system', displayName: 'Console Host' },
  'SecurityHealthService.exe': { description: 'Windows Security Health - monitors antivirus, firewall, and security status.', category: 'system', displayName: 'Security Health' },
  'MsMpEng.exe': { description: 'Microsoft Defender Antimalware - real-time antivirus scanning engine.', category: 'system', displayName: 'Defender Antimalware' },
  'wsl.exe': { description: 'Windows Subsystem for Linux - runs Linux distributions on Windows.', category: 'development', displayName: 'WSL' },
  'wsl': { description: 'Windows Subsystem for Linux - runs Linux distributions on Windows.', category: 'development', displayName: 'WSL' },
  'wslhost.exe': { description: 'WSL Host - manages WSL2 virtual machine and Linux interop.', category: 'development', displayName: 'WSL Host' },
  'WindowsTerminal.exe': { description: 'Windows Terminal - modern terminal emulator for PowerShell, CMD, and WSL.', category: 'development', displayName: 'Windows Terminal' },
  'WindowsTerm': { description: 'Windows Terminal - modern terminal emulator for PowerShell, CMD, and WSL.', category: 'development', displayName: 'Windows Terminal' },
  'powershell.exe': { description: 'PowerShell - task automation and configuration management shell.', category: 'development', displayName: 'PowerShell' },
  'pwsh.exe': { description: 'PowerShell Core - cross-platform PowerShell.', category: 'development', displayName: 'PowerShell Core' },
  'cmd.exe': { description: 'Command Prompt - Windows command-line interpreter.', category: 'development', displayName: 'Command Prompt' },
};

// ============================================
// App Name Extraction
// ============================================

/**
 * Extract app name from Windows executable paths in a command string.
 * e.g. "C:\Program Files\Slack\slack.exe" → "Slack"
 */
function extractAppNameFromCommand(command = '') {
  if (!command) return null;

  // Match Program Files paths
  const pfMatch = command.match(/[A-Za-z]:\\Program Files(?:\s*\(x86\))?\\([^\\]+)\\/i)
    || command.match(/[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Programs\\([^\\]+)\\/i)
    || command.match(/[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\([^\\]+)\\/i);
  if (pfMatch && pfMatch[1]) {
    return pfMatch[1];
  }

  return null;
}

// ============================================
// Path Conventions
// ============================================

/**
 * Prefixes that indicate a user home directory path on Windows.
 * Used by inferProjectPathFromCommand in graphFunctions.js.
 */
const HOME_DIR_PATH_PREFIXES = ['C:\\Users\\', 'C:/Users/'];

/**
 * System-installed paths to exclude from project scanning.
 */
const SYSTEM_PROJECT_ROOTS = [
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\Windows',
  'C:\\ProgramData',
].map(p => path.resolve(p).toLowerCase());

// ============================================
// Shell Operations
// ============================================

/**
 * Open a terminal (Windows Terminal, PowerShell, or cmd) at the given directory.
 */
function openTerminalAtPath(dirPath) {
  return new Promise((resolve) => {
    // Try Windows Terminal first (wt.exe), fall back to cmd.exe
    let child;
    try {
      child = spawn('wt.exe', ['-d', dirPath], {
        detached: true,
        stdio: 'ignore',
      });
    } catch {
      child = spawn('cmd.exe', ['/c', 'start', 'cmd', '/K', `cd /d "${dirPath}"`], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      });
    }

    child.on('error', (err) => {
      // wt.exe not found — fall back to cmd.exe
      const fallback = spawn('cmd.exe', ['/c', 'start', 'cmd', '/K', `cd /d "${dirPath}"`], {
        detached: true,
        stdio: 'ignore',
        shell: true,
      });
      fallback.on('error', (fallbackErr) => {
        console.error('Error opening terminal:', fallbackErr);
        resolve({ success: false, error: fallbackErr.message });
      });
      fallback.unref();
      setTimeout(() => resolve({ success: true }), 100);
    });

    child.unref();
    setTimeout(() => resolve({ success: true }), 100);
  });
}

/**
 * Open a file in the default system application.
 */
function openFileInDefaultApp(filePath) {
  const child = spawn('cmd.exe', ['/c', 'start', '""', filePath], {
    detached: true,
    stdio: 'ignore',
    shell: true,
  });
  child.unref();
  return { success: true, editor: 'default' };
}

/**
 * Check if VS Code CLI (`code`) is available on Windows.
 */
function hasCodeEditor() {
  try {
    execFileSync('where', ['code'], { timeout: 2000, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Path validation for the editor handler.
 * On Windows, allows anything under the user's home directory or temp.
 */
function isPathAllowedForEditor(resolvedPath) {
  const home = os.homedir();
  const temp = os.tmpdir();
  const normalized = path.resolve(resolvedPath).toLowerCase();
  return normalized.startsWith(home.toLowerCase()) || normalized.startsWith(temp.toLowerCase());
}

// ============================================
// Window Options
// ============================================

/**
 * Platform-specific BrowserWindow options for Windows.
 * Windows uses the default title bar (no hidden inset / traffic lights).
 */
function getWindowOptions() {
  return {};
}

/**
 * Set the app icon (no-op on Windows — icon is set via BrowserWindow options).
 */
function setupDockIcon(_app, _nativeImage, _iconPath) {
  // Windows has no dock. App icon is set in BrowserWindow constructor.
}

/**
 * Whether the app should quit when all windows are closed.
 * Windows convention: quit the app.
 */
function shouldQuitOnAllWindowsClosed() {
  return true;
}

module.exports = {
  // Process monitoring
  getProcessList,
  parseProcessList,
  getProcessInfoByPid,
  killProcess,
  enumeratePids,

  // Port & connection monitoring
  fetchListeningPorts,
  parseListeningPorts,
  fetchEstablishedConnections,
  parseEstablishedConnections,
  fetchProcessOnPort,
  fetchListeningPortNumbers,

  // CWD resolution
  batchResolveCwds,
  resolveCwd,
  extractCwdFromCommandLine, // exported for testing

  // Docker binary paths
  DOCKER_BIN_CANDIDATES,

  // Known system services
  PLATFORM_KNOWN_SERVICES,

  // App name extraction
  extractAppNameFromCommand,

  // Path conventions
  HOME_DIR_PATH_PREFIXES,
  SYSTEM_PROJECT_ROOTS,

  // Shell operations
  openTerminalAtPath,
  openFileInDefaultApp,
  hasCodeEditor,
  isPathAllowedForEditor,

  // Window options
  getWindowOptions,
  setupDockIcon,
  shouldQuitOnAllWindowsClosed,
};
