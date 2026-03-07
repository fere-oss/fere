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
const MAX_TOKENS_TOOL_TURN = 2048; // Intermediate turns: enough for reasoning + 2-3 tool calls
const MAX_TOKENS_FINAL = 4096;     // Final diagnosis gets full budget
const TRUNCATE_BODY = 3000;        // HTTP response body chars
const TRUNCATE_BODY_CONCURRENT = 800;
const TRUNCATE_LOG_LINES = 150;
const TRUNCATE_SOURCE_LINES = 180;
const TRUNCATE_SOURCE_CHARS = 6000;
const MAX_GREP_MATCHES = 25;
const MAX_FILE_LIST = 40;
const MAX_DB_ROWS = 30;
// Context trimming: after this many messages, compress old tool results
const CONTEXT_TRIM_THRESHOLD = 24;
// Loop detection: if the last N tool calls are identical, nudge the model
const LOOP_DETECT_WINDOW = 3;

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
      description: 'Send an HTTP request to a local service and get the response. Use this to reproduce bugs, test endpoints, and observe behavior.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
          url: { type: 'string', description: 'Full URL, e.g. http://localhost:3001/api/checkout' },
          headers: { type: 'object', description: 'Request headers as key-value pairs', additionalProperties: { type: 'string' } },
          body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
        },
        required: ['method', 'url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fire_concurrent_requests',
      description: 'Fire multiple identical requests concurrently to test for race conditions or intermittent failures. Returns all responses.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
          url: { type: 'string' },
          headers: { type: 'object', additionalProperties: { type: 'string' } },
          body: { type: 'string' },
          count: { type: 'number', description: 'Number of concurrent requests (2-20)', minimum: 2, maximum: 20 },
        },
        required: ['method', 'url', 'count'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_container_logs',
      description: 'Get recent logs from a Docker container. Use the container name or ID. Returns the last N lines.',
      parameters: {
        type: 'object',
        properties: {
          container_name: { type: 'string', description: 'Container name (from the topology)' },
          tail: { type: 'number', description: 'Number of recent lines to fetch (default 100, max 500)', maximum: 500 },
          since: { type: 'string', description: 'Only return logs after this timestamp (ISO 8601 or relative like "5m")' },
          grep: { type: 'string', description: 'Filter log lines to only those containing this string (case-insensitive)' },
        },
        required: ['container_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_source_file',
      description: "Read a source code file from a service's project directory. Use this to understand implementations, check error handlers, read configuration files, etc.",
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string', description: 'Name of the service (from topology) whose project to read from' },
          file_path: { type: 'string', description: 'Relative file path within the project, e.g. "src/routes/checkout.js"' },
          line_start: { type: 'number', description: 'Start reading from this line (1-indexed)' },
          line_end: { type: 'number', description: 'Stop reading at this line (inclusive)' },
        },
        required: ['service_name', 'file_path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_source_files',
      description: "Search for source code files in a service's project directory by name pattern. Only indexes code files (.js, .ts, .py, .go, .rb, .java, .php) — config files like .yml, .json, .env, Dockerfile are not included. Use read_source_file to read config files directly if you know the path.",
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string', description: 'Name of the service (from topology)' },
          pattern: { type: 'string', description: 'Glob pattern to match, e.g. "**/*.js", "**/checkout*", "src/routes/*.ts"' },
        },
        required: ['service_name', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'grep_source',
      description: "Search for a text pattern across source code files in a service's project. Returns matching lines with file paths and line numbers. Only searches code files (.js, .ts, .py, .go, .rb, .java, .php) — does not search config/YAML/JSON/.env files.",
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string', description: 'Name of the service (from topology)' },
          pattern: { type: 'string', description: 'Text or regex pattern to search for' },
          file_glob: { type: 'string', description: 'Optional glob to limit search scope, e.g. "**/*.py"' },
        },
        required: ['service_name', 'pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_service_routes',
      description: 'Get all discovered API routes for a service. Shows method, path, and framework.',
      parameters: {
        type: 'object',
        properties: {
          service_name: { type: 'string', description: 'Name of the service (from topology)' },
        },
        required: ['service_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_database_query',
      description: 'Execute a read-only SQL query against a running database container. Use this to check data state.',
      parameters: {
        type: 'object',
        properties: {
          container_name: { type: 'string', description: 'Database container name' },
          query: { type: 'string', description: 'SQL query (SELECT only — no mutations)' },
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

// --- Helper: Find service node ---

function findServiceNode(graphSnapshot, serviceName) {
  return graphSnapshot.nodes.find(
    n => n.name === serviceName || n.name.includes(serviceName)
  );
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

  const fullPath = path.resolve(node.projectPath, file_path);
  if (!fullPath.startsWith(path.resolve(node.projectPath))) {
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

  // Only allow read-only queries
  const trimmed = query.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW') && !trimmed.startsWith('DESCRIBE') && !trimmed.startsWith('EXPLAIN')) {
    return { error: 'Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed' };
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

// --- System Prompt ---

function buildSystemPrompt(graphSnapshot) {
  const { nodes, edges } = graphSnapshot;

  const services = nodes
    .filter(n => n.type !== 'external')
    .map(n => {
      const ports = (n.ports || []).map(p => p.port).join(', ');
      const routes = (n.routes || []).map(r => `${r.method} ${r.path}`).join(', ');
      const health = n.healthStatus || 'unknown';
      const container = n.isDockerContainer ? ` [Docker: ${n.containerState || 'unknown'}]` : '';
      const project = n.projectPath ? ` [project: ${n.projectPath}]` : '';
      return `- ${n.name} (ports: ${ports || 'none'}, health: ${health}${container}${project})${routes ? `\n  Routes: ${routes}` : ''}`;
    })
    .join('\n');

  const connections = edges
    .map(e => {
      const src = nodes.find(n => n.id === e.source);
      const tgt = nodes.find(n => n.id === e.target);
      return `- ${src?.name || e.source} → ${tgt?.name || e.target} (port ${e.targetPort})`;
    })
    .join('\n');

  const externals = nodes
    .filter(n => n.type === 'external')
    .map(n => `- ${n.name}`)
    .join('\n');

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
- Fire multiple requests if the bug is intermittent. Try at least 5 requests before concluding it's not reproducible.
- Always check logs from ALL services in the chain, not just the entry point.
- When reading source code, focus on error handlers, database queries, and inter-service calls.
- Keep your tool calls focused. Don't read entire codebases — target specific files mentioned in error logs.
- If a container is not running (health: red), note this as it may BE the bug.`;
}

// --- OpenAI API Call ---

async function callOpenAI(apiKey, systemPrompt, messages, maxTokens = MAX_TOKENS_FINAL) {
  // Prepend system message to the conversation
  const fullMessages = [
    { role: 'system', content: systemPrompt },
    ...messages,
  ];

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    messages: fullMessages,
    tools: DEBUG_TOOLS,
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

// --- Context Trimming ---
// Replace verbose old tool results with structured summaries to keep context small
// while preserving the key findings the model needs for its final diagnosis.

function trimConversationContext(messages, toolResultSummaries) {
  if (messages.length < CONTEXT_TRIM_THRESHOLD) return;

  // Keep first user message + last 12 messages intact; compress the middle
  const keepTailCount = 12;
  const compressEnd = messages.length - keepTailCount;

  for (let i = 1; i < compressEnd; i++) {
    const msg = messages[i];
    if (msg.role === 'tool' && typeof msg.content === 'string' && msg.content.length > 300) {
      // Use the structured summary we captured during execution, falling back to a prefix
      const summary = toolResultSummaries.get(msg.tool_call_id);
      if (summary) {
        messages[i] = { ...msg, content: `[Summary: ${summary}]` };
      } else {
        // Fallback: keep enough to preserve key error messages / status codes
        messages[i] = { ...msg, content: msg.content.slice(0, 400) + '\n... (trimmed)' };
      }
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

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (options._cancelled) {
      return makeResult({ success: false, error: 'Cancelled' });
    }

    onProgress({ type: 'thinking', iteration: i + 1 });

    // Trim old tool results to keep context lean
    trimConversationContext(messages, toolResultSummaries);

    // Use small token budget for intermediate turns, full budget near the end
    const isNearEnd = i >= MAX_ITERATIONS - 2;
    const maxTokens = isNearEnd ? MAX_TOKENS_FINAL : MAX_TOKENS_TOOL_TURN;

    let response;
    try {
      response = await callOpenAI(apiKey, systemPrompt, messages, maxTokens);
    } catch (err) {
      onProgress({ type: 'error', error: err.message });
      return makeResult({ success: false, error: err.message });
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

    // Execute all tool calls
    for (const toolCall of toolCalls) {
      if (options._cancelled) {
        return makeResult({ success: false, error: 'Cancelled' });
      }

      const fnName = toolCall.function.name;
      let fnArgs;
      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch (parseErr) {
        const errorResult = `Failed to parse tool arguments: ${parseErr.message}. Raw: ${toolCall.function.arguments.slice(0, 200)}`;
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: errorResult,
        });
        toolResultSummaries.set(toolCall.id, `Error: malformed arguments for ${fnName}`);
        onProgress({
          type: 'tool_result',
          tool: fnName,
          summary: `Error: malformed arguments`,
          iteration: i + 1,
        });
        continue;
      }

      onProgress({
        type: 'tool_call',
        tool: fnName,
        input: fnArgs,
        iteration: i + 1,
      });

      const result = await executeDebugTool(fnName, fnArgs, graphSnapshot, sessionCache);
      const summary = summarizeToolResult(fnName, result);

      onProgress({
        type: 'tool_result',
        tool: fnName,
        summary,
        iteration: i + 1,
      });

      const resultContent = typeof result === 'string' ? result : JSON.stringify(result);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: resultContent,
      });
      toolResultSummaries.set(toolCall.id, summary);
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
