const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const picomatch = require('picomatch');

const { scanRoutes, matchRoutesToService, findFiles } = require('./routeScanner');
const { executeQuery } = require('./databaseQuery');
const { validateHttpRequestUrl } = require('../security');

const execFileAsync = promisify(execFile);

// --- Constants ---

const MAX_ITERATIONS = 20;
const MODEL = 'gpt-4.1';
const ENV_PATH = path.join(__dirname, '..', '..', '.env');

// --- Token budget limits ---
const MAX_TOKENS_TOOL_TURN = 1024; // Intermediate turns: enough for reasoning + 2-3 tool calls
const MAX_TOKENS_FINAL = 4096;     // Final diagnosis gets full budget
const TRUNCATE_BODY = 3000;        // HTTP response body chars
const TRUNCATE_BODY_CONCURRENT = 800;
const TRUNCATE_LOG_LINES = 150;
const TRUNCATE_SOURCE_LINES = 180;
const TRUNCATE_SOURCE_CHARS = 6000;
const MAX_GREP_MATCHES = 25;
const MAX_FILE_LIST = 40;
const MAX_DB_ROWS = 30;
const MAX_PROMPT_SERVICES = 18;
const MAX_PROMPT_CONNECTIONS = 24;
const MAX_PROMPT_EXTERNALS = 12;
// Context trimming: after this many messages, compress old tool results
const CONTEXT_TRIM_THRESHOLD = 16;
// Loop detection: if the last N tool calls are identical, nudge the model
const LOOP_DETECT_WINDOW = 3;
// Max chars for a single tool result stored in conversation history
const MAX_TOOL_RESULT_CHARS = 4000;
// Rate limiting: warn after this many iterations, minimum ms between API calls
const ITERATION_WARN_THRESHOLD = 12;
const MIN_API_CALL_INTERVAL_MS = 1000;

const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  'docker',
].filter(Boolean);
let resolvedDockerBin = null;

// --- API Key Management (.env) ---

function parseEnvFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      vars[key] = value;
    }
    return vars;
  } catch {
    return {};
  }
}

function getApiKey() {
  // 1. Check process.env first (e.g. set via shell)
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  // 2. Read from project root .env
  const vars = parseEnvFile(ENV_PATH);
  return vars.OPENAI_API_KEY || null;
}

function setApiKey(key) {
  const dir = path.dirname(ENV_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const vars = parseEnvFile(ENV_PATH);
  vars.OPENAI_API_KEY = key;

  const lines = Object.entries(vars).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, lines.join('\n') + '\n');
}

// --- Docker Binary Resolution ---

async function resolveDockerBinary() {
  if (resolvedDockerBin) return resolvedDockerBin;
  const candidates = DOCKER_BIN_CANDIDATES.filter(bin => {
    if (bin.includes('/') && !fs.existsSync(bin)) return false;
    return true;
  });
  try {
    resolvedDockerBin = await Promise.any(
      candidates.map(async (candidate) => {
        await execFileAsync(candidate, ['version', '--format', '{{.Client.Version}}'], {
          timeout: 3000,
          maxBuffer: 1024 * 1024,
        });
        return candidate;
      })
    );
    return resolvedDockerBin;
  } catch {
    resolvedDockerBin = null;
    return null;
  }
}

// --- Tool Definitions ---

const DEBUG_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'fire_request',
      description: 'Send an HTTP request to a local service.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
        },
        required: ['method', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fire_concurrent_requests',
      description: 'Fire N identical requests concurrently to test race conditions.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
          count: { type: 'number', minimum: 2, maximum: 20 },
        },
        required: ['method', 'url', 'count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_container_logs',
      description: 'Get recent logs from a Docker container.',
      parameters: {
        type: 'object',
        properties: {
          container_name: { type: 'string' },
          tail: { type: 'number', maximum: 500 },
          since: { type: 'string', description: 'ISO 8601 or relative e.g. "5m"' },
          grep: { type: 'string', description: 'Case-insensitive filter string' },
        },
        required: ['container_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source_file',
      description: "Read a source file from a service's project. Also use for config files (.yml, .json, .env, Dockerfile).",
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string' },
          file_path: { type: 'string', description: 'Relative path, e.g. "src/routes/checkout.js"' },
          line_start: { type: 'number' },
          line_end: { type: 'number' },
        },
        required: ['service_name', 'file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_source_files',
      description: "Find code files (.js/.ts/.py/.go/.rb/.java/.php) in a service's project by glob pattern.",
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string' },
          pattern: { type: 'string', description: 'Glob, e.g. "**/checkout*"' },
        },
        required: ['service_name', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_source',
      description: "Search code files in a service's project for a text/regex pattern. Returns file paths and line numbers.",
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string' },
          pattern: { type: 'string' },
          file_glob: { type: 'string' },
        },
        required: ['service_name', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_service_routes',
      description: 'Get discovered API routes (method, path, framework) for a service.',
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string' },
        },
        required: ['service_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_database_query',
      description: 'Run a read-only SQL query (SELECT/SHOW/DESCRIBE/EXPLAIN) against a database container.',
      parameters: {
        type: 'object',
        properties: {
          container_name: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['container_name', 'query'],
      },
    },
  },
];

// --- Helper: Truncate ---

function truncate(str, maxLen) {
  if (typeof str !== 'string') return str;
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + '\n... (truncated)';
}

function sanitizeToolProgressResult(result) {
  if (result == null) return result;
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
    return result;
  }
  try {
    return JSON.parse(JSON.stringify(result));
  } catch {
    return { error: 'Tool result could not be serialized for display' };
  }
}

// --- Helper: Find service node ---

function findServiceNode(graphSnapshot, serviceName) {
  const query = String(serviceName || '').trim().toLowerCase();
  if (!query) return null;

  const nodes = graphSnapshot.nodes.filter(n => n.type !== 'external');

  const exact = nodes.find(n => n.name?.trim().toLowerCase() === query);
  if (exact) return exact;

  const prefix = nodes.find(n => n.name?.trim().toLowerCase().startsWith(query));
  if (prefix) return prefix;

  return nodes.find(n => n.name?.trim().toLowerCase().includes(query)) || null;
}

// --- Helper: Make HTTP request ---

function makeHttpRequest({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const validation = validateHttpRequestUrl(url, true); // allow private (local services)
    if (!validation.valid) {
      reject(new Error(validation.reason));
      return;
    }

    const parsedUrl = validation.url;
    const isHttps = parsedUrl.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const startTime = Date.now();
    const normalizedMethod = (method || 'GET').toUpperCase();
    const requestHeaders = { ...(headers || {}) };
    const shouldSendBody =
      typeof body === 'string' &&
      body.length > 0 &&
      !['GET', 'HEAD'].includes(normalizedMethod);

    if (shouldSendBody && !Object.keys(requestHeaders).some(k => k.toLowerCase() === 'content-length')) {
      requestHeaders['Content-Length'] = Buffer.byteLength(body, 'utf8').toString();
    }

    const requestOptions = {
      method: normalizedMethod,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: requestHeaders,
      timeout: 30000,
    };

    const req = httpModule.request(requestOptions, (res) => {
      const chunks = [];
      let totalSize = 0;
      const MAX_SIZE = 10 * 1024 * 1024;

      res.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize > MAX_SIZE) {
          req.destroy();
          reject(new Error('Response too large (exceeded 10MB limit)'));
          return;
        }
        chunks.push(chunk);
      });

      res.on('end', () => {
        const duration = Date.now() - startTime;
        const responseBody = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage,
          headers: res.headers,
          body: responseBody,
          duration,
          size: totalSize,
        });
      });
    });

    req.on('error', (error) => reject(error));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out (30s)')); });

    if (shouldSendBody) req.write(body);
    req.end();
  });
}

// --- Tool Executors ---

async function executeFireRequest(input) {
  const { method, url, headers, body } = input;
  const start = Date.now();
  try {
    const result = await makeHttpRequest({ method, url, headers, body });
    return {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: truncate(result.body, TRUNCATE_BODY),
      duration: result.duration,
      size: result.size,
    };
  } catch (err) {
    return { error: err.message, duration: Date.now() - start };
  }
}

async function executeConcurrentRequests(input) {
  const { method, url, headers, body, count } = input;
  const capped = Math.min(count, 20);

  const promises = Array.from({ length: capped }, () =>
    makeHttpRequest({ method, url, headers, body })
  );

  const results = await Promise.allSettled(promises);

  const summary = {
    total: capped,
    succeeded: 0,
    failed: 0,
    statuses: {},
    errors: [],
    responses: [],
  };

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const r = result.value;
      summary.succeeded++;
      const key = String(r.status);
      summary.statuses[key] = (summary.statuses[key] || 0) + 1;
      if (summary.responses.length < 3) {
        summary.responses.push({
          status: r.status,
          body: truncate(r.body, TRUNCATE_BODY_CONCURRENT),
          duration: r.duration,
        });
      }
    } else {
      summary.failed++;
      summary.errors.push(result.reason?.message || 'Unknown error');
    }
  }

  return summary;
}

async function executeGetLogs(input, graphSnapshot) {
  const { container_name, tail = 100, since, grep } = input;

  const node = graphSnapshot.nodes.find(n =>
    n.name === container_name ||
    n.containerId?.startsWith(container_name) ||
    n.name.includes(container_name)
  );

  const containerId = node?.containerId || container_name;

  const dockerBin = await resolveDockerBinary();
  if (!dockerBin) {
    return { error: 'Docker not available' };
  }

  const args = ['logs', '--timestamps'];
  if (tail) args.push('--tail', String(Math.min(tail, 500)));
  if (since) args.push('--since', since);
  args.push(containerId);

  return new Promise((resolve) => {
    execFile(dockerBin, args, { maxBuffer: 2 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: `Failed to get logs: ${err.message}` });
        return;
      }
      let lines = (stdout + stderr).split('\n').filter(Boolean);

      if (grep) {
        const lower = grep.toLowerCase();
        lines = lines.filter(line => line.toLowerCase().includes(lower));
      }

      if (lines.length > TRUNCATE_LOG_LINES) {
        lines = lines.slice(-TRUNCATE_LOG_LINES);
      }

      resolve({
        container: container_name,
        lineCount: lines.length,
        logs: lines.join('\n'),
      });
    });
  });
}

async function executeReadSource(input, graphSnapshot) {
  const { service_name, file_path, line_start, line_end } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  const projectRoot = path.resolve(node.projectPath);
  const fullPath = path.resolve(projectRoot, file_path);
  const relativePath = path.relative(projectRoot, fullPath);
  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath)
  ) {
    return { error: 'Path traversal not allowed' };
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    let lines = content.split('\n');
    const totalLines = lines.length;

    if (line_start || line_end) {
      const start = Math.max(0, (line_start || 1) - 1);
      const end = line_end || lines.length;
      lines = lines.slice(start, end);
    }

    if (lines.length > TRUNCATE_SOURCE_LINES) {
      lines = lines.slice(0, TRUNCATE_SOURCE_LINES);
      lines.push('... (truncated)');
    }

    const result = lines.join('\n');
    if (result.length > TRUNCATE_SOURCE_CHARS) {
      return { file: file_path, content: result.slice(0, TRUNCATE_SOURCE_CHARS) + '\n... (truncated)', totalLines };
    }

    return { file: file_path, content: result, totalLines };
  } catch (err) {
    return { error: `Cannot read file: ${err.message}` };
  }
}

async function executeFindFiles(input, graphSnapshot, sessionCache) {
  const { service_name, pattern } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  // Cache file tree per project path within the session
  if (!sessionCache.files[node.projectPath]) {
    sessionCache.files[node.projectPath] = findFiles(node.projectPath);
  }
  const allFiles = sessionCache.files[node.projectPath];
  const isMatch = picomatch(pattern);
  const matched = allFiles.filter(f => {
    const rel = path.relative(node.projectPath, f);
    return isMatch(rel);
  });

  const limited = matched.slice(0, MAX_FILE_LIST);
  return {
    files: limited.map(f => path.relative(node.projectPath, f)),
    total: matched.length,
    truncated: matched.length > MAX_FILE_LIST,
  };
}

async function executeGrepSource(input, graphSnapshot, sessionCache) {
  const { service_name, pattern, file_glob } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  // Reuse cached file tree
  if (!sessionCache.files[node.projectPath]) {
    sessionCache.files[node.projectPath] = findFiles(node.projectPath);
  }
  let files = [...sessionCache.files[node.projectPath]];

  if (file_glob) {
    const isMatch = picomatch(file_glob);
    files = files.filter(f => isMatch(path.relative(node.projectPath, f)));
  }

  const matches = [];
  const MAX_MATCHES = MAX_GREP_MATCHES;
  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch {
    return { error: `Invalid regex pattern: ${pattern}` };
  }

  for (const file of files) {
    if (matches.length >= MAX_MATCHES) break;
    try {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (matches.length >= MAX_MATCHES) break;
        if (regex.test(lines[i])) {
          matches.push({
            file: path.relative(node.projectPath, file),
            line: i + 1,
            content: lines[i].trim().slice(0, 200),
          });
        }
      }
    } catch { /* skip unreadable files */ }
  }

  return { pattern, matches, totalMatches: matches.length };
}

async function executeGetRoutes(input, graphSnapshot, sessionCache) {
  const { service_name } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  // Cache route scans per project path within the session
  const cacheKey = `${node.projectPath}:${node.id}`;
  if (sessionCache.routes[cacheKey]) {
    const matched = sessionCache.routes[cacheKey];
    return {
      service: service_name,
      routes: matched.map(r => ({ method: r.method, path: r.path, framework: r.framework })),
      count: matched.length,
    };
  }

  const allRoutes = await scanRoutes(node.projectPath);
  const matched = matchRoutesToService(allRoutes, node);
  sessionCache.routes[cacheKey] = matched;

  return {
    service: service_name,
    routes: matched.map(r => ({ method: r.method, path: r.path, framework: r.framework })),
    count: matched.length,
  };
}

async function executeDbQuery(input, graphSnapshot) {
  const { container_name, query } = input;

  // Only allow a single read-only statement
  const trimmed = query.trim();
  const upper = trimmed.toUpperCase();
  if (!upper.startsWith('SELECT') && !upper.startsWith('SHOW') && !upper.startsWith('DESCRIBE') && !upper.startsWith('EXPLAIN')) {
    return { error: 'Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed' };
  }
  // Reject multiple statements — strip string literals then check for semicolons not at the end
  const noStrings = trimmed.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  const withoutTrailing = noStrings.replace(/;\s*$/, '');
  if (withoutTrailing.includes(';')) {
    return { error: 'Multiple statements are not allowed' };
  }

  const node = graphSnapshot.nodes.find(n =>
    n.name === container_name || n.name.includes(container_name)
  );

  if (!node?.containerId) {
    return { error: `Database container "${container_name}" not found` };
  }

  try {
    const containerImage = node.containerImage || node.command || node.name;
    const result = await executeQuery(node.containerId, containerImage, query);
    if (result.error) {
      return { error: result.error };
    }
    const rows = (result.rows || []).slice(0, MAX_DB_ROWS);
    return { columns: result.columns, rows, totalRows: result.rows?.length || 0 };
  } catch (err) {
    return { error: err.message };
  }
}

// --- Tool Dispatcher ---

async function executeDebugTool(toolName, input, graphSnapshot, sessionCache) {
  switch (toolName) {
    case 'fire_request':
      return await executeFireRequest(input);
    case 'fire_concurrent_requests':
      return await executeConcurrentRequests(input);
    case 'get_container_logs':
      return await executeGetLogs(input, graphSnapshot);
    case 'read_source_file':
      return await executeReadSource(input, graphSnapshot);
    case 'find_source_files':
      return await executeFindFiles(input, graphSnapshot, sessionCache);
    case 'grep_source':
      return await executeGrepSource(input, graphSnapshot, sessionCache);
    case 'get_service_routes':
      return await executeGetRoutes(input, graphSnapshot, sessionCache);
    case 'run_database_query':
      return await executeDbQuery(input, graphSnapshot);
    default:
      return { error: `Unknown tool: ${toolName}` };
  }
}

// --- Tool Result Summarizer ---

function summarizeToolResult(toolName, result) {
  if (result.error) return `Error: ${result.error}`;

  switch (toolName) {
    case 'fire_request':
      return `${result.status} ${result.statusText} (${result.duration}ms, ${result.size} bytes)`;
    case 'fire_concurrent_requests':
      return `${result.succeeded}/${result.total} succeeded — statuses: ${JSON.stringify(result.statuses)}`;
    case 'get_container_logs':
      return `${result.lineCount} log lines from ${result.container}`;
    case 'read_source_file':
      return `Read ${result.file} (${result.totalLines} lines)`;
    case 'find_source_files':
      return `Found ${result.total} files`;
    case 'grep_source':
      return `${result.totalMatches} matches for "${result.pattern}"`;
    case 'get_service_routes':
      return `${result.count} routes for ${result.service}`;
    case 'run_database_query':
      return `${result.totalRows || 0} rows returned`;
    default:
      return 'Done';
  }
}

function buildToolContextContent(toolName, result) {
  const summary = summarizeToolResult(toolName, result);
  if (result?.error) {
    return `[Summary: ${summary}]`;
  }

  switch (toolName) {
    case 'fire_request': {
      const bodyPreview = typeof result.body === 'string'
        ? truncate(result.body, 500)
        : '';
      return [
        `[Summary: ${summary}]`,
        result.headers ? `Headers: ${JSON.stringify(result.headers)}` : null,
        bodyPreview ? `Body excerpt:\n${bodyPreview}` : null,
      ].filter(Boolean).join('\n');
    }
    case 'fire_concurrent_requests':
      return [
        `[Summary: ${summary}]`,
        result.statuses ? `Statuses: ${JSON.stringify(result.statuses)}` : null,
        Array.isArray(result.errors) && result.errors.length
          ? `Errors: ${JSON.stringify(result.errors.slice(0, 5))}`
          : null,
        Array.isArray(result.responses) && result.responses.length
          ? `Response excerpts: ${JSON.stringify(result.responses.slice(0, 2))}`
          : null,
      ].filter(Boolean).join('\n');
    case 'get_container_logs': {
      const logExcerpt = typeof result.logs === 'string'
        ? truncate(result.logs, 900)
        : '';
      return [
        `[Summary: ${summary}]`,
        logExcerpt ? `Log excerpt:\n${logExcerpt}` : null,
      ].filter(Boolean).join('\n');
    }
    case 'read_source_file': {
      const contentExcerpt = typeof result.content === 'string'
        ? truncate(result.content, 1200)
        : '';
      return [
        `[Summary: ${summary}]`,
        contentExcerpt ? `Source excerpt:\n${contentExcerpt}` : null,
      ].filter(Boolean).join('\n');
    }
    case 'find_source_files':
      return [
        `[Summary: ${summary}]`,
        Array.isArray(result.files) && result.files.length
          ? `Files: ${JSON.stringify(result.files.slice(0, 20))}`
          : null,
      ].filter(Boolean).join('\n');
    case 'grep_source':
      return [
        `[Summary: ${summary}]`,
        Array.isArray(result.matches) && result.matches.length
          ? `Matches: ${JSON.stringify(result.matches.slice(0, 8))}`
          : null,
      ].filter(Boolean).join('\n');
    case 'get_service_routes':
      return [
        `[Summary: ${summary}]`,
        Array.isArray(result.routes) && result.routes.length
          ? `Routes: ${JSON.stringify(result.routes.slice(0, 20))}`
          : null,
      ].filter(Boolean).join('\n');
    case 'run_database_query':
      return [
        `[Summary: ${summary}]`,
        Array.isArray(result.columns) && result.columns.length
          ? `Columns: ${JSON.stringify(result.columns)}`
          : null,
        Array.isArray(result.rows) && result.rows.length
          ? `Rows sample: ${JSON.stringify(result.rows.slice(0, 5))}`
          : null,
      ].filter(Boolean).join('\n');
    default:
      return `[Summary: ${summary}]`;
  }
}

function summarizePromptList(items, maxItems, formatter) {
  const visible = items.slice(0, maxItems).map(formatter);
  const omitted = items.length - visible.length;
  if (omitted > 0) {
    visible.push(`- ... ${omitted} more omitted for brevity`);
  }
  return visible.join('\n');
}

// --- System Prompt ---

function buildSystemPrompt(graphSnapshot) {
  const { nodes, edges } = graphSnapshot;
  const nodeById = new Map(nodes.map(node => [node.id, node]));

  const serviceNodes = nodes
    .filter(n => n.type !== 'external')
    .sort((a, b) => {
      const aPorts = Array.isArray(a.ports) ? a.ports.length : 0;
      const bPorts = Array.isArray(b.ports) ? b.ports.length : 0;
      return bPorts - aPorts || a.name.localeCompare(b.name);
    });

  const services = summarizePromptList(
    serviceNodes,
    MAX_PROMPT_SERVICES,
    (n) => {
      const ports = (n.ports || []).map(p => p.port).join(', ');
      const health = n.healthStatus || 'unknown';
      const container = n.isDockerContainer ? ` [Docker: ${n.containerState || 'unknown'}]` : '';
      const project = n.projectPath ? ` [project: ${n.projectPath}]` : '';
      return `- ${n.name} (ports: ${ports || 'none'}, health: ${health}${container}${project})`;
    },
  );

  const sortedEdges = [...edges].sort((a, b) => {
    const aScore = (a.confidence || 0) + (a.targetPort ? 1 : 0);
    const bScore = (b.confidence || 0) + (b.targetPort ? 1 : 0);
    return bScore - aScore;
  });
  const connections = summarizePromptList(
    sortedEdges,
    MAX_PROMPT_CONNECTIONS,
    (e) => {
      const src = nodeById.get(e.source);
      const tgt = nodeById.get(e.target);
      return `- ${src?.name || e.source} → ${tgt?.name || e.target} (port ${e.targetPort})`;
    },
  );

  const externals = summarizePromptList(
    nodes.filter(n => n.type === 'external'),
    MAX_PROMPT_EXTERNALS,
    (n) => `- ${n.name}`,
  );

  return `You are an expert debugging agent embedded in Fere, a development environment monitoring tool.
You have access to the user's live local development environment including running services, container logs, source code, and the ability to fire HTTP requests.

## Current System Topology

### Services
${services || 'No services detected'}

### Connections (edges)
${connections || 'No connections detected'}

### External APIs
${externals || 'None detected'}

## Using Tools
When calling tools that accept a \`service_name\` parameter, use the service name shown in the topology above (the first name on each line, e.g. "express-api", "postgres-db"). The name is matched flexibly — partial matches work.

\`find_source_files\` and \`grep_source\` only index code files (.js, .ts, .py, .go, .rb, .java, .php). To read config files (.yml, .json, .env, Dockerfile), use \`read_source_file\` directly with the known file path.

## Your Goal
The user will describe a bug or issue. Your job is to systematically investigate and diagnose the root cause by:
1. Understanding which services are involved from the topology
2. Firing HTTP requests to reproduce the issue
3. Reading container logs from involved services to find errors
4. Reading relevant source code files to understand the implementation
5. Correlating evidence across services to identify the root cause

## Investigation Strategy
- Start by identifying which services handle the affected endpoint (check routes and topology)
- Fire a few requests to reproduce the issue and observe behavior
- Check container logs from ALL services in the request path for errors/warnings
- If you find error messages, read the source code at the referenced file/line to understand why
- Look for patterns: race conditions (intermittent), configuration issues (consistent), data issues (specific inputs)
- Cross-reference timestamps in logs across services to trace request flow

## Output Format
When you've identified the root cause, provide your diagnosis as a structured report:

**Diagnosis**: One-line summary of the bug
**Root Cause**: Detailed explanation of what's happening and why
**Evidence**: List the specific logs, responses, and code that prove your diagnosis
**Affected Services**: Which services are involved
**Suggested Fix**: What code changes would resolve the issue
**Confidence**: High / Medium / Low with explanation

When referencing services, file paths, or code identifiers in your diagnosis, always use backtick formatting:
- Service names: \`express-api\`, \`postgres-db\`
- File paths with service context: \`service-name/path/to/file.js:42\` (include line number when relevant)
- Code identifiers: \`functionName\`, \`variableName\`

## Important
- Be systematic. Don't guess — gather evidence.
- **Call multiple tools in a single response whenever possible.** For example, fetch logs from service A and service B in the same turn rather than one at a time. This is strongly preferred.
- Fire multiple requests if the bug is intermittent. Try at least 5 requests before concluding it's not reproducible.
- Always check logs from ALL services in the chain, not just the entry point.
- When reading source code, focus on error handlers, database queries, and inter-service calls.
- Keep your tool calls focused. Don't read entire codebases — target specific files mentioned in error logs.
- If a container is not running (health: red), note this as it may BE the bug.`;
}

// --- OpenAI API Call ---

async function callOpenAI(apiKey, systemPrompt, messages, maxTokens = MAX_TOKENS_FINAL, tools = DEBUG_TOOLS) {
  // Prepend system message to the conversation
  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    messages: fullMessages,
    ...(tools ? { tools } : {}),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          // Surface context-length errors distinctly so the caller can trim and retry
          if (res.statusCode === 400) {
            try {
              const parsed = JSON.parse(data);
              const errMsg = parsed?.error?.message || '';
              if (errMsg.includes('context_length') || errMsg.includes('maximum context') || errMsg.includes('too many tokens') || errMsg.includes('max_tokens')) {
                const err = new Error(`Context too large: ${errMsg}`);
                err.isContextOverflow = true;
                reject(err);
                return;
              }
            } catch { /* fall through to generic error */ }
          }
          reject(new Error(`OpenAI API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse OpenAI API response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenAI API timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

// --- OpenAI Streaming API Call ---
// Streams text tokens via onToken as they arrive. Buffers tool call chunks and
// assembles them into the same response shape as callOpenAI so the caller is uniform.

function callOpenAIStream(apiKey, systemPrompt, messages, maxTokens, onToken, tools = DEBUG_TOOLS) {
  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    messages: fullMessages,
    ...(tools ? { tools } : {}),
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errData = '';
        res.on('data', chunk => { errData += chunk; });
        res.on('end', () => {
          if (res.statusCode === 400) {
            try {
              const parsed = JSON.parse(errData);
              const errMsg = parsed?.error?.message || '';
              if (errMsg.includes('context_length') || errMsg.includes('maximum context') || errMsg.includes('too many tokens') || errMsg.includes('max_tokens')) {
                const err = new Error(`Context too large: ${errMsg}`);
                err.isContextOverflow = true;
                reject(err);
                return;
              }
            } catch { /* fall through */ }
          }
          reject(new Error(`OpenAI API error ${res.statusCode}: ${errData}`));
        });
        return;
      }

      let sseBuffer = '';
      let finishReason = null;
      let messageContent = '';
      const toolCallsMap = {}; // index → { id, function: { name, arguments } }

      res.on('data', chunk => {
        sseBuffer += chunk.toString();
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop(); // keep the incomplete trailing line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') continue;

          let parsed;
          try { parsed = JSON.parse(data); } catch { continue; }

          const choice = parsed.choices?.[0];
          if (!choice) continue;

          if (choice.finish_reason) finishReason = choice.finish_reason;

          const delta = choice.delta;
          if (!delta) continue;

          // Text tokens — stream immediately
          if (typeof delta.content === 'string' && delta.content) {
            messageContent += delta.content;
            onToken(delta.content);
          }

          // Tool call chunks — accumulate across events
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCallsMap[idx]) {
                toolCallsMap[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
              }
              if (tc.id) toolCallsMap[idx].id = tc.id;
              if (tc.function?.name) toolCallsMap[idx].function.name += tc.function.name;
              if (tc.function?.arguments) toolCallsMap[idx].function.arguments += tc.function.arguments;
            }
          }
        }
      });

      res.on('end', () => {
        const toolCalls = Object.keys(toolCallsMap).length > 0
          ? Object.values(toolCallsMap)
          : undefined;

        resolve({
          choices: [{
            message: {
              role: 'assistant',
              content: messageContent || null,
              tool_calls: toolCalls,
            },
            finish_reason: finishReason,
          }],
        });
      });

      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('OpenAI API timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

// --- Context Trimming ---
// Replace verbose old tool results with structured summaries to keep context small
// while preserving the key findings the model needs for its final diagnosis.

function trimConversationContext(messages, toolResultSummaries) {
  if (messages.length < CONTEXT_TRIM_THRESHOLD) return;

  // Keep first user message + last 8 messages intact; compress the middle
  const keepTailCount = 8;
  const compressEnd = messages.length - keepTailCount;

  for (let i = 1; i < compressEnd; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 300) {
      const summary = toolResultSummaries.get(msg.tool_call_id);
      if (summary) {
        messages[i] = { ...msg, content: `[Summary: ${summary}]` };
      } else {
        messages[i] = { ...msg, content: msg.content.slice(0, 400) + '\n... (trimmed)' };
      }
    }
  }

  // Also cap large tool results in the tail to prevent gradual buildup
  for (let i = Math.max(1, compressEnd); i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 3000) {
      const summary = toolResultSummaries.get(msg.tool_call_id);
      messages[i] = { ...msg, content: summary ? `[Summary: ${summary}]\n${msg.content.slice(0, 1500)}\n... (trimmed)` : msg.content.slice(0, 1500) + '\n... (trimmed)' };
    }
  }
}

// Aggressive trim: compress ALL tool results except the last few, used on context overflow
function aggressiveTrimContext(messages, toolResultSummaries) {
  const keepTailCount = 6;
  const compressEnd = messages.length - keepTailCount;

  for (let i = 1; i < compressEnd; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 100) {
      const summary = toolResultSummaries.get(msg.tool_call_id);
      messages[i] = { ...msg, content: summary ? `[Summary: ${summary}]` : '[trimmed]' };
    }
  }
  // Also compress tool results in the tail that are very large
  for (let i = Math.max(1, compressEnd); i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 2000) {
      const summary = toolResultSummaries.get(msg.tool_call_id);
      messages[i] = { ...msg, content: summary ? `[Summary: ${summary}]` : msg.content.slice(0, 500) + '\n... (trimmed)' };
    }
  }
}

// --- Agent Loop ---

async function runDebugAgent(options, onProgress) {
  const { problem, followUp, graphSnapshot, apiKey, resumeState } = options;

  // Resume from previous conversation or start fresh
  let sessionCache, toolResultSummaries, systemPrompt, messages;
  const recentToolCalls = [];

  if (resumeState) {
    sessionCache = resumeState.sessionCache;
    toolResultSummaries = resumeState.toolResultSummaries;
    // Rebuild system prompt from fresh snapshot so topology changes are reflected
    systemPrompt = buildSystemPrompt(graphSnapshot);
    messages = resumeState.messages;
    messages.push({ role: 'user', content: followUp });
  } else {
    sessionCache = { routes: {}, files: {} };
    toolResultSummaries = new Map();
    systemPrompt = buildSystemPrompt(graphSnapshot);
    messages = [{ role: 'user', content: problem }];
  }

  const makeResult = (base) => ({
    ...base,
    state: { messages, sessionCache, toolResultSummaries, systemPrompt },
  });

  let lastApiCallTime = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (options._cancelled) {
      return makeResult({ success: false, error: 'Cancelled' });
    }

    // Rate limiting: warn after threshold
    if (i === ITERATION_WARN_THRESHOLD) {
      onProgress({
        type: 'tool_result',
        tool: 'system',
        summary: `Investigation is taking long (${i} iterations). Will wrap up soon.`,
        iteration: i + 1,
      });
      // Nudge the model to conclude
      messages.push({
        role: 'user',
        content: `You have used ${i} of ${MAX_ITERATIONS} iterations. Please provide your diagnosis based on the evidence gathered so far. If you need one more critical piece of evidence, get it now and then conclude.`,
      });
    }

    onProgress({ type: 'thinking', iteration: i + 1 });

    // Trim old tool results to keep context lean
    trimConversationContext(messages, toolResultSummaries);

    // Throttle: ensure minimum interval between API calls
    const now = Date.now();
    const elapsed = now - lastApiCallTime;
    if (elapsed < MIN_API_CALL_INTERVAL_MS && lastApiCallTime > 0) {
      await new Promise(r => setTimeout(r, MIN_API_CALL_INTERVAL_MS - elapsed));
    }

    // Use small token budget for intermediate turns, full budget near the end.
    // On final turns, omit tool definitions entirely to save input tokens — the
    // model is writing its diagnosis and won't be calling tools.
    const isNearEnd = i >= MAX_ITERATIONS - 2;
    const maxTokens = isNearEnd ? MAX_TOKENS_FINAL : MAX_TOKENS_TOOL_TURN;
    const tools = isNearEnd ? undefined : DEBUG_TOOLS;

    // Stream tokens to the renderer as they arrive
    const onToken = (text) => {
      if (!options._cancelled) onProgress({ type: 'diagnosis_delta', text });
    };

    let response;
    try {
      lastApiCallTime = Date.now();
      response = await callOpenAIStream(apiKey, systemPrompt, messages, maxTokens, onToken, tools);
    } catch (err) {
      // Context overflow: aggressively trim and retry once (non-streaming; complete will replace streamed partial text)
      if (err.isContextOverflow) {
        aggressiveTrimContext(messages, toolResultSummaries);
        try {
          lastApiCallTime = Date.now();
          response = await callOpenAI(apiKey, systemPrompt, messages, maxTokens, tools);
        } catch (retryErr) {
          onProgress({ type: 'error', error: retryErr.message });
          return makeResult({ success: false, error: retryErr.message });
        }
      } else {
        onProgress({ type: 'error', error: err.message });
        return makeResult({ success: false, error: err.message });
      }
    }

    const choice = response.choices?.[0];
    if (!choice) {
      onProgress({ type: 'error', error: 'No response from OpenAI' });
      return makeResult({ success: false, error: 'No response from OpenAI' });
    }

    // Handle finish_reason: "length" — response was truncated by token limit
    if (choice.finish_reason === 'length') {
      if (maxTokens < MAX_TOKENS_FINAL) {
        try {
          response = await callOpenAI(apiKey, systemPrompt, messages, MAX_TOKENS_FINAL);
          const retryChoice = response.choices?.[0];
          if (retryChoice && retryChoice.finish_reason !== 'length') {
            const retryMessage = retryChoice.message;
            messages.push(retryMessage);
            const retryToolCalls = retryMessage.tool_calls;
            if (!retryToolCalls || retryToolCalls.length === 0) {
              const text = retryMessage.content || '';
              onProgress({ type: 'complete', diagnosis: text });
              return makeResult({ success: true, diagnosis: text, iterations: i + 1 });
            }
          }
        } catch { /* fall through to use original truncated response */ }
      }
    }

    const message = response.choices?.[0]?.message || choice.message;

    if (!messages.includes(message)) {
      messages.push(message);
    }

    const toolCalls = message.tool_calls;
    if (!toolCalls || toolCalls.length === 0) {
      const text = message.content || '';
      onProgress({ type: 'complete', diagnosis: text });
      return makeResult({ success: true, diagnosis: text, iterations: i + 1 });
    }

    // Loop detection
    const callSignature = toolCalls
      .map(tc => `${tc.function.name}:${tc.function.arguments}`)
      .sort()
      .join('|');
    recentToolCalls.push(callSignature);
    if (recentToolCalls.length > LOOP_DETECT_WINDOW) {
      recentToolCalls.shift();
    }
    if (
      recentToolCalls.length === LOOP_DETECT_WINDOW &&
      recentToolCalls.every(sig => sig === callSignature)
    ) {
      messages.push({
        role: 'user',
        content: 'You have called the same tools with identical arguments multiple times. Please try a different approach, gather different evidence, or provide your diagnosis based on what you have so far.',
      });
      recentToolCalls.length = 0;
      continue;
    }

    if (options._cancelled) {
      return makeResult({ success: false, error: 'Cancelled' });
    }

    // Parse all tool call arguments upfront; emit tool_call events before executing
    const parsedCalls = toolCalls.map(toolCall => {
      const fnName = toolCall.function.name;
      let fnArgs;
      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch (parseErr) {
        return { toolCall, fnName, fnArgs: null, parseErr };
      }
      onProgress({ type: 'tool_call', tool: fnName, input: fnArgs, iteration: i + 1 });
      return { toolCall, fnName, fnArgs, parseErr: null };
    });

    // Execute all tool calls concurrently
    const settled = await Promise.allSettled(
      parsedCalls.map(({ fnName, fnArgs }) =>
        fnArgs !== null
          ? executeDebugTool(fnName, fnArgs, graphSnapshot, sessionCache)
          : Promise.resolve({ error: 'Malformed arguments' })
      )
    );

    // Push results in the same order the model issued the calls
    for (let j = 0; j < parsedCalls.length; j++) {
      const { toolCall, fnName, fnArgs, parseErr } = parsedCalls[j];
      const outcome = settled[j];

      let result;
      if (parseErr) {
        result = `Failed to parse tool arguments: ${parseErr.message}. Raw: ${toolCall.function.arguments.slice(0, 200)}`;
        toolResultSummaries.set(toolCall.id, `Error: malformed arguments for ${fnName}`);
        onProgress({
          type: 'tool_result',
          tool: fnName,
          summary: 'Error: malformed arguments',
          result: { error: result },
          iteration: i + 1,
        });
      } else if (outcome.status === 'rejected') {
        result = { error: outcome.reason?.message || 'Tool execution failed' };
        const summary = `Error: ${result.error}`;
        toolResultSummaries.set(toolCall.id, summary);
        onProgress({
          type: 'tool_result',
          tool: fnName,
          input: fnArgs,
          summary,
          result: sanitizeToolProgressResult(result),
          iteration: i + 1,
        });
      } else {
        result = outcome.value;
        const summary = summarizeToolResult(fnName, result);
        toolResultSummaries.set(toolCall.id, summary);
        onProgress({
          type: 'tool_result',
          tool: fnName,
          input: fnArgs,
          summary,
          result: sanitizeToolProgressResult(result),
          iteration: i + 1,
        });
      }

      const rawContent = buildToolContextContent(fnName, result);
      const resultContent = rawContent.length > MAX_TOOL_RESULT_CHARS
        ? rawContent.slice(0, MAX_TOOL_RESULT_CHARS) + '\n... (truncated for context)'
        : rawContent;
      messages.push({ role: 'tool', tool_call_id: toolCall.id, content: resultContent });
    }
  }

  onProgress({ type: 'complete', diagnosis: 'Investigation reached maximum iterations without a definitive diagnosis.' });
  return makeResult({ success: false, error: 'Max iterations reached' });
}

module.exports = {
  runDebugAgent,
  getApiKey,
  setApiKey,
};
