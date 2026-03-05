const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const picomatch = require('picomatch');

const { scanRoutes, matchRoutesToService, findFiles } = require('./routeScanner');
const { executeQuery } = require('./databaseQuery');
const { validateHttpRequestUrl } = require('../security');

const execFileAsync = promisify(execFile);

// --- Constants ---

const MAX_ITERATIONS = 25;
const MODEL = 'claude-sonnet-4-6';
const CONFIG_PATH = path.join(os.homedir(), '.fere', 'config.json');

const DOCKER_BIN_CANDIDATES = [
  process.env.FERE_DOCKER_BIN,
  '/opt/homebrew/bin/docker',
  '/usr/local/bin/docker',
  '/Applications/Docker.app/Contents/Resources/bin/docker',
  'docker',
].filter(Boolean);
let resolvedDockerBin = null;

// --- API Key Management ---

function getApiKey() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return config.claudeApiKey || null;
  } catch {
    return null;
  }
}

function setApiKey(key) {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {}
  config.claudeApiKey = key;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
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
    name: 'fire_request',
    description: 'Send an HTTP request to a local service and get the response. Use this to reproduce bugs, test endpoints, and observe behavior.',
    input_schema: {
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
  {
    name: 'fire_concurrent_requests',
    description: 'Fire multiple identical requests concurrently to test for race conditions or intermittent failures. Returns all responses.',
    input_schema: {
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
  {
    name: 'get_container_logs',
    description: 'Get recent logs from a Docker container. Use the container name or ID. Returns the last N lines.',
    input_schema: {
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
  {
    name: 'read_source_file',
    description: "Read a source code file from a service's project directory. Use this to understand implementations, check error handlers, read configuration files, etc.",
    input_schema: {
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
  {
    name: 'find_source_files',
    description: "Search for files in a service's project directory by name pattern. Use this to locate files mentioned in error messages or to explore project structure.",
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Name of the service (from topology)' },
        pattern: { type: 'string', description: 'Glob pattern to match, e.g. "**/*.js", "**/checkout*", "src/routes/*.ts"' },
      },
      required: ['service_name', 'pattern'],
    },
  },
  {
    name: 'grep_source',
    description: "Search for a text pattern across source files in a service's project. Returns matching lines with file paths and line numbers.",
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Name of the service (from topology)' },
        pattern: { type: 'string', description: 'Text or regex pattern to search for' },
        file_glob: { type: 'string', description: 'Optional glob to limit search scope, e.g. "**/*.py"' },
      },
      required: ['service_name', 'pattern'],
    },
  },
  {
    name: 'get_service_routes',
    description: 'Get all discovered API routes for a service. Shows method, path, and framework.',
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Name of the service (from topology)' },
      },
      required: ['service_name'],
    },
  },
  {
    name: 'run_database_query',
    description: 'Execute a read-only SQL query against a running database container. Use this to check data state.',
    input_schema: {
      type: 'object',
      properties: {
        container_name: { type: 'string', description: 'Database container name' },
        query: { type: 'string', description: 'SQL query (SELECT only — no mutations)' },
      },
      required: ['container_name', 'query'],
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
      body: truncate(result.body, 4000),
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
          body: truncate(r.body, 1000),
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

      if (lines.length > 200) {
        lines = lines.slice(-200);
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

    if (lines.length > 200) {
      lines = lines.slice(0, 200);
      lines.push('... (truncated)');
    }

    const result = lines.join('\n');
    if (result.length > 8000) {
      return { file: file_path, content: result.slice(0, 8000) + '\n... (truncated)', totalLines };
    }

    return { file: file_path, content: result, totalLines };
  } catch (err) {
    return { error: `Cannot read file: ${err.message}` };
  }
}

async function executeFindFiles(input, graphSnapshot) {
  const { service_name, pattern } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  const allFiles = findFiles(node.projectPath);
  const isMatch = picomatch(pattern);
  const matched = allFiles.filter(f => {
    const rel = path.relative(node.projectPath, f);
    return isMatch(rel);
  });

  const limited = matched.slice(0, 50);
  return {
    files: limited.map(f => path.relative(node.projectPath, f)),
    total: matched.length,
    truncated: matched.length > 50,
  };
}

async function executeGrepSource(input, graphSnapshot) {
  const { service_name, pattern, file_glob } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  let files = findFiles(node.projectPath);

  if (file_glob) {
    const isMatch = picomatch(file_glob);
    files = files.filter(f => isMatch(path.relative(node.projectPath, f)));
  }

  const matches = [];
  const MAX_MATCHES = 30;
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

async function executeGetRoutes(input, graphSnapshot) {
  const { service_name } = input;

  const node = findServiceNode(graphSnapshot, service_name);
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  const allRoutes = await scanRoutes(node.projectPath);
  const matched = matchRoutesToService(allRoutes, node);

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
    const rows = (result.rows || []).slice(0, 50);
    return { columns: result.columns, rows, totalRows: result.rows?.length || 0 };
  } catch (err) {
    return { error: err.message };
  }
}

// --- Tool Dispatcher ---

async function executeDebugTool(toolName, input, graphSnapshot) {
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
      return await executeFindFiles(input, graphSnapshot);
    case 'grep_source':
      return await executeGrepSource(input, graphSnapshot);
    case 'get_service_routes':
      return await executeGetRoutes(input, graphSnapshot);
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
      return `- ${n.name} (id: ${n.id}, type: ${n.type}, ports: ${ports || 'none'}, health: ${health}${container})${routes ? `\n  Routes: ${routes}` : ''}`;
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

## Important
- Be systematic. Don't guess — gather evidence.
- Fire multiple requests if the bug is intermittent. Try at least 5 requests before concluding it's not reproducible.
- Always check logs from ALL services in the chain, not just the entry point.
- When reading source code, focus on error handlers, database queries, and inter-service calls.
- Keep your tool calls focused. Don't read entire codebases — target specific files mentioned in error logs.
- If a container is not running (health: red), note this as it may BE the bug.`;
}

// --- Claude API Call ---

async function callClaudeAPI(apiKey, systemPrompt, messages) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: 4096,
    system: systemPrompt,
    messages,
    tools: DEBUG_TOOLS,
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`Claude API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse Claude API response: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Claude API timeout (60s)')); });
    req.write(body);
    req.end();
  });
}

// --- Agent Loop ---

async function runDebugAgent(options, onProgress) {
  const { problem, graphSnapshot, apiKey } = options;

  const systemPrompt = buildSystemPrompt(graphSnapshot);
  const messages = [
    { role: 'user', content: problem },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // Check cancellation before each API call
    if (options._cancelled) {
      return { success: false, error: 'Cancelled' };
    }

    onProgress({ type: 'thinking', iteration: i + 1 });

    let response;
    try {
      response = await callClaudeAPI(apiKey, systemPrompt, messages);
    } catch (err) {
      onProgress({ type: 'error', error: err.message });
      return { success: false, error: err.message };
    }

    // Append assistant response to conversation
    messages.push({ role: 'assistant', content: response.content });

    // Check if there are tool calls
    const toolUses = response.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) {
      // Agent is done — extract final text
      const text = response.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
      onProgress({ type: 'complete', diagnosis: text });
      return { success: true, diagnosis: text, iterations: i + 1 };
    }

    // Execute all tool calls
    const toolResults = [];
    for (const toolUse of toolUses) {
      if (options._cancelled) {
        return { success: false, error: 'Cancelled' };
      }

      onProgress({
        type: 'tool_call',
        tool: toolUse.name,
        input: toolUse.input,
        iteration: i + 1,
      });

      const result = await executeDebugTool(toolUse.name, toolUse.input, graphSnapshot);

      onProgress({
        type: 'tool_result',
        tool: toolUse.name,
        summary: summarizeToolResult(toolUse.name, result),
        iteration: i + 1,
      });

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }

    // Append tool results to conversation
    messages.push({ role: 'user', content: toolResults });
  }

  onProgress({ type: 'complete', diagnosis: 'Investigation reached maximum iterations without a definitive diagnosis.' });
  return { success: false, error: 'Max iterations reached' };
}

module.exports = {
  runDebugAgent,
  getApiKey,
  setApiKey,
};
