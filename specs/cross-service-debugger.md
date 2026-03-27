# Autonomous Cross-Service Debugger — Implementation Spec

> Status: historical / superseded. This spec captures the earlier autonomous AI-debugger direction. The current shipped direction is the findings-first Sentinel workflow documented in `docs/fere-agent-plan.md` and `docs/AI_AGENT_CAPABILITIES.md`.

## Overview

An AI debugging agent embedded in Fere that autonomously investigates cross-service bugs. The user describes a problem in natural language (e.g., "my checkout endpoint returns 500 sometimes"). The agent then orchestrates Fere's existing infrastructure — firing HTTP requests, reading container logs, reading source code, analyzing the service topology — in a loop until it identifies the root cause. It shows its investigation in real-time and presents a final diagnosis with evidence.

**Why this is unique**: No tool has simultaneous access to running processes + container logs + source code + network topology + the ability to fire test requests. Fere has all of these. An AI agent that orchestrates all of them together to hunt down a bug is genuinely new.

---

## Architecture

### High-Level Flow

```
User describes bug → Agent plans investigation → Agent executes tools in loop → Agent reports diagnosis

  ┌──────────────┐     ┌────────────────┐     ┌──────────────────┐     ┌──────────────┐
  │  Debugger UI  │────▶│  Main Process   │────▶│  Claude API      │────▶│  Tool Results │
  │  (renderer)   │◀────│  Agent Loop     │◀────│  (tool-use mode) │◀────│  (logs, code) │
  └──────────────┘     └────────────────┘     └──────────────────┘     └──────────────┘
        IPC streaming          orchestrates                                 existing Fere
        progress events        existing services                            infrastructure
```

### Components

1. **Renderer**: `DebugPanel` component — slide-out panel for input + live investigation stream + final report
2. **Main Process**: `debugAgent.js` — orchestrates the tool-use agent loop, calling Claude API with tools
3. **IPC**: Streaming channel for progress updates + request/response for start/stop
4. **No new dependencies required** — uses Claude API via `https` module (same pattern as existing HTTP request execution)

---

## 1. Backend: Debug Agent Service

### File: `electron/services/debugAgent.js`

This is the core agent. It runs a Claude tool-use loop in the main process.

### API Key Management

The user provides a Claude API key. Stored in `~/.fere/config.json` (same pattern as other Fere config). Never sent to renderer.

```javascript
// Storage
const configPath = path.join(os.homedir(), '.fere', 'config.json');

function getApiKey() {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.claudeApiKey || null;
  } catch { return null; }
}

function setApiKey(key) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  config.claudeApiKey = key;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}
```

### Agent Loop

The agent is a standard Claude tool-use loop. Each iteration:
1. Send conversation history + tool definitions to Claude API
2. If Claude returns `tool_use` blocks, execute the tools and append results
3. If Claude returns a text response with no tool calls, the investigation is complete
4. Stream progress events to the renderer after each step

```javascript
const MAX_ITERATIONS = 25;  // Safety limit
const MODEL = 'claude-sonnet-4-6';  // Fast + capable enough for debugging

async function runDebugAgent(options, onProgress) {
  const { problem, graphSnapshot, apiKey } = options;
  // graphSnapshot = { nodes: GraphNode[], edges: GraphEdge[] }

  const systemPrompt = buildSystemPrompt(graphSnapshot);
  const messages = [
    { role: 'user', content: problem }
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    onProgress({ type: 'thinking', iteration: i + 1 });

    const response = await callClaudeAPI(apiKey, systemPrompt, messages);

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
```

### System Prompt

The system prompt gives the agent full context about the running system and its available tools.

```javascript
function buildSystemPrompt(graphSnapshot) {
  const { nodes, edges } = graphSnapshot;

  // Build topology summary
  const services = nodes
    .filter(n => n.type !== 'external')
    .map(n => {
      const ports = n.ports.map(p => p.port).join(', ');
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
```

### Tool Definitions

The agent gets these tools, which map to existing Fere infrastructure:

```javascript
const DEBUG_TOOLS = [
  {
    name: 'fire_request',
    description: 'Send an HTTP request to a local service and get the response. Use this to reproduce bugs, test endpoints, and observe behavior.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
        url: { type: 'string', description: 'Full URL, e.g. http://localhost:3001/api/checkout' },
        headers: {
          type: 'object',
          description: 'Request headers as key-value pairs',
          additionalProperties: { type: 'string' },
        },
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
        container_name: { type: 'string', description: 'Container name (from the topology, e.g. "express-api", "postgres")' },
        tail: { type: 'number', description: 'Number of recent lines to fetch (default 100, max 500)', maximum: 500 },
        since: { type: 'string', description: 'Only return logs after this timestamp (ISO 8601 or relative like "5m")' },
        grep: { type: 'string', description: 'Filter log lines to only those containing this string (case-insensitive)' },
      },
      required: ['container_name'],
    },
  },
  {
    name: 'read_source_file',
    description: 'Read a source code file from a service\'s project directory. Use this to understand implementations, check error handlers, read configuration files, etc.',
    input_schema: {
      type: 'object',
      properties: {
        service_name: { type: 'string', description: 'Name of the service (from topology) whose project to read from' },
        file_path: { type: 'string', description: 'Relative file path within the project, e.g. "src/routes/checkout.js" or "app/main.py"' },
        line_start: { type: 'number', description: 'Start reading from this line (1-indexed)' },
        line_end: { type: 'number', description: 'Stop reading at this line (inclusive)' },
      },
      required: ['service_name', 'file_path'],
    },
  },
  {
    name: 'find_source_files',
    description: 'Search for files in a service\'s project directory by name pattern. Use this to locate files mentioned in error messages or to explore project structure.',
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
    description: 'Search for a text pattern across source files in a service\'s project. Returns matching lines with file paths and line numbers.',
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
```

### Tool Execution

Each tool maps to existing Fere infrastructure:

```javascript
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
```

#### Tool: `fire_request`

Uses existing HTTP request infrastructure from `electron/main.js`.

```javascript
const http = require('http');
const https = require('https');

async function executeFireRequest(input) {
  const { method, url, headers, body } = input;
  const start = Date.now();
  try {
    // Reuse the same HTTP execution logic from execute-http-request handler
    const result = await makeHttpRequest({ method, url, headers, body });
    return {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
      body: truncate(result.body, 4000),  // Limit for context window
      duration: result.duration,
      size: result.size,
    };
  } catch (err) {
    return { error: err.message, duration: Date.now() - start };
  }
}
```

#### Tool: `fire_concurrent_requests`

Fires N requests in parallel using `Promise.allSettled`.

```javascript
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
    statuses: {},  // { "200": 3, "500": 2 }
    errors: [],
    responses: [],
  };

  for (const result of results) {
    if (result.status === 'fulfilled') {
      const r = result.value;
      summary.succeeded++;
      const key = String(r.status);
      summary.statuses[key] = (summary.statuses[key] || 0) + 1;
      // Only include first 3 full responses to save context
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
```

#### Tool: `get_container_logs`

Uses Docker CLI directly (same approach as `containerLogs.js`).

```javascript
const { execFile } = require('child_process');

async function executeGetLogs(input, graphSnapshot) {
  const { container_name, tail = 100, since, grep } = input;

  // Resolve container name to container ID from graph
  const node = graphSnapshot.nodes.find(n =>
    n.name === container_name ||
    n.containerId?.startsWith(container_name) ||
    n.name.includes(container_name)
  );

  const containerId = node?.containerId || container_name;

  const args = ['logs', '--timestamps'];
  if (tail) args.push('--tail', String(Math.min(tail, 500)));
  if (since) args.push('--since', since);
  args.push(containerId);

  return new Promise((resolve) => {
    execFile(dockerBinary, args, { maxBuffer: 2 * 1024 * 1024, timeout: 10000 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: `Failed to get logs: ${err.message}` });
        return;
      }
      let lines = (stdout + stderr).split('\n').filter(Boolean);

      // Apply grep filter if specified
      if (grep) {
        const lower = grep.toLowerCase();
        lines = lines.filter(line => line.toLowerCase().includes(lower));
      }

      // Limit output for context window
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
```

#### Tool: `read_source_file`

Reads files from a service's `projectPath`.

```javascript
const fs = require('fs');
const path = require('path');

async function executeReadSource(input, graphSnapshot) {
  const { service_name, file_path, line_start, line_end } = input;

  const node = graphSnapshot.nodes.find(n => n.name === service_name || n.name.includes(service_name));
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  // Security: resolve and validate path is within project
  const fullPath = path.resolve(node.projectPath, file_path);
  if (!fullPath.startsWith(path.resolve(node.projectPath))) {
    return { error: 'Path traversal not allowed' };
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8');
    let lines = content.split('\n');

    // Apply line range if specified
    if (line_start || line_end) {
      const start = Math.max(0, (line_start || 1) - 1);
      const end = line_end || lines.length;
      lines = lines.slice(start, end);
    }

    // Limit size for context window (max 200 lines, 8KB)
    if (lines.length > 200) {
      lines = lines.slice(0, 200);
      lines.push('... (truncated)');
    }

    const result = lines.join('\n');
    if (result.length > 8000) {
      return { file: file_path, content: result.slice(0, 8000) + '\n... (truncated)' };
    }

    return { file: file_path, content: result, totalLines: content.split('\n').length };
  } catch (err) {
    return { error: `Cannot read file: ${err.message}` };
  }
}
```

#### Tool: `find_source_files`

Uses glob to find files in a service's project.

```javascript
const { findFiles } = require('./routeScanner');  // Already exported

async function executeFindFiles(input, graphSnapshot) {
  const { service_name, pattern } = input;

  const node = graphSnapshot.nodes.find(n => n.name === service_name || n.name.includes(service_name));
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  // Use findFiles from routeScanner (already handles skip dirs)
  const files = await findFiles(node.projectPath, pattern);

  // Limit to 50 results
  const limited = files.slice(0, 50);
  return {
    files: limited.map(f => path.relative(node.projectPath, f)),
    total: files.length,
    truncated: files.length > 50,
  };
}
```

#### Tool: `grep_source`

Searches for patterns across source files.

```javascript
async function executeGrepSource(input, graphSnapshot) {
  const { service_name, pattern, file_glob } = input;

  const node = graphSnapshot.nodes.find(n => n.name === service_name || n.name.includes(service_name));
  if (!node?.projectPath) {
    return { error: `Service "${service_name}" not found or has no project path` };
  }

  const glob = file_glob || '**/*.{js,ts,jsx,tsx,py,go,java,rb}';
  const files = await findFiles(node.projectPath, glob);

  const matches = [];
  const regex = new RegExp(pattern, 'i');
  const MAX_MATCHES = 30;

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
```

#### Tool: `get_service_routes`

Uses existing `scanRoutes` from `routeScanner.js`.

```javascript
const { scanRoutes, matchRoutesToService } = require('./routeScanner');

async function executeGetRoutes(input, graphSnapshot) {
  const { service_name } = input;

  const node = graphSnapshot.nodes.find(n => n.name === service_name || n.name.includes(service_name));
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
```

#### Tool: `run_database_query`

Uses existing `executeDatabaseQuery` from `databaseQuery.js`.

```javascript
const { executeDatabaseQuery } = require('./databaseQuery');

async function executeDbQuery(input, graphSnapshot) {
  const { container_name, query } = input;

  // Security: only allow SELECT queries
  const trimmed = query.trim().toUpperCase();
  if (!trimmed.startsWith('SELECT') && !trimmed.startsWith('SHOW') && !trimmed.startsWith('DESCRIBE') && !trimmed.startsWith('EXPLAIN')) {
    return { error: 'Only read-only queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are allowed' };
  }

  const node = graphSnapshot.nodes.find(n =>
    n.name === container_name ||
    n.name.includes(container_name)
  );

  if (!node?.containerId) {
    return { error: `Database container "${container_name}" not found` };
  }

  try {
    // Detect image type from node command/name
    const containerImage = detectContainerImage(node);
    const result = await executeDatabaseQuery(node.containerId, containerImage, query);
    if (result.success) {
      // Limit rows for context window
      const rows = result.rows?.slice(0, 50) || [];
      return { columns: result.columns, rows, totalRows: result.rows?.length || 0 };
    }
    return { error: result.error };
  } catch (err) {
    return { error: err.message };
  }
}
```

### Claude API Call

Standard Anthropic Messages API call using Node.js `https`:

```javascript
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
        resolve(JSON.parse(data));
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(body);
    req.end();
  });
}
```

### Helper: Summarize Tool Results

For the progress stream, create human-readable summaries of each tool result:

```javascript
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
```

---

## 2. IPC Handlers

### File: `electron/main.js` (add to existing handlers)

```javascript
const { runDebugAgent, getApiKey, setApiKey } = require('./services/debugAgent');

// Store active debug sessions for cancellation
let activeDebugSession = null;

ipcMain.handle('debug-set-api-key', async (_, key) => {
  if (typeof key !== 'string' || key.length < 10) {
    return { success: false, error: 'Invalid API key' };
  }
  setApiKey(key);
  return { success: true };
});

ipcMain.handle('debug-get-api-key-status', async () => {
  const key = getApiKey();
  return { hasKey: !!key };
});

ipcMain.handle('debug-start', async (event, options) => {
  // options: { problem: string }
  if (typeof options?.problem !== 'string' || !options.problem.trim()) {
    return { success: false, error: 'Problem description is required' };
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    return { success: false, error: 'No Claude API key configured' };
  }

  // Get current graph snapshot
  const snapshot = await getLatestSnapshot();  // existing function
  const graphSnapshot = {
    nodes: snapshot.graph.nodes,
    edges: snapshot.graph.edges,
  };

  // Cancel any existing session
  if (activeDebugSession) {
    activeDebugSession.cancelled = true;
  }

  const session = { cancelled: false };
  activeDebugSession = session;

  // Run agent asynchronously, streaming progress
  runDebugAgent(
    { problem: options.problem, graphSnapshot, apiKey },
    (progress) => {
      if (session.cancelled) return;
      // Send progress to renderer
      const sender = event.sender;
      if (!sender.isDestroyed()) {
        sender.send('debug-progress', progress);
      }
    }
  ).then((result) => {
    if (session === activeDebugSession) activeDebugSession = null;
  }).catch((err) => {
    if (!session.cancelled && !event.sender.isDestroyed()) {
      event.sender.send('debug-progress', {
        type: 'error',
        error: err.message,
      });
    }
    if (session === activeDebugSession) activeDebugSession = null;
  });

  return { success: true };
});

ipcMain.handle('debug-stop', async () => {
  if (activeDebugSession) {
    activeDebugSession.cancelled = true;
    activeDebugSession = null;
  }
  return { success: true };
});
```

### File: `electron/preload.js` (add to contextBridge)

```javascript
// Debug agent
debugSetApiKey: (key) => ipcRenderer.invoke('debug-set-api-key', key),
debugGetApiKeyStatus: () => ipcRenderer.invoke('debug-get-api-key-status'),
debugStart: (options) => ipcRenderer.invoke('debug-start', options),
debugStop: () => ipcRenderer.invoke('debug-stop'),
onDebugProgress: (callback) => {
  const listener = (event, data) => callback(data);
  ipcRenderer.on('debug-progress', listener);
  return () => ipcRenderer.removeListener('debug-progress', listener);
},
```

### File: `src/types/electron.d.ts` (add to ElectronAPI interface)

```typescript
// Debug agent
debugSetApiKey(key: string): Promise<{ success: boolean; error?: string }>;
debugGetApiKeyStatus(): Promise<{ hasKey: boolean }>;
debugStart(options: { problem: string }): Promise<{ success: boolean; error?: string }>;
debugStop(): Promise<{ success: boolean }>;
onDebugProgress(callback: (progress: DebugProgress) => void): () => void;
```

Add new types:

```typescript
export type DebugProgress =
  | { type: 'thinking'; iteration: number }
  | { type: 'tool_call'; tool: string; input: Record<string, unknown>; iteration: number }
  | { type: 'tool_result'; tool: string; summary: string; iteration: number }
  | { type: 'complete'; diagnosis: string }
  | { type: 'error'; error: string };
```

---

## 3. Renderer: Debug Panel

### File: `src/components/DebugPanel.tsx`

A slide-out panel from the right side of the screen (same animation pattern as `NodeDetailPanel`).

### States

1. **Closed** — not visible
2. **Setup** — API key input (only shown if no key stored)
3. **Input** — text area for describing the problem
4. **Running** — live investigation stream + stop button
5. **Complete** — final diagnosis report

### Component Structure

```tsx
interface DebugPanelProps {
  onClose: () => void;
}

// Internal state
type DebugPhase = 'setup' | 'input' | 'running' | 'complete';

interface InvestigationStep {
  type: 'thinking' | 'tool_call' | 'tool_result';
  tool?: string;
  input?: Record<string, unknown>;
  summary?: string;
  iteration: number;
  timestamp: number;
}
```

### UI Layout

```
┌─────────────────────────────────────────┐
│  Debug Agent                        ✕   │
│─────────────────────────────────────────│
│                                         │
│  Describe the issue:                    │
│  ┌─────────────────────────────────┐    │
│  │ My checkout endpoint returns    │    │
│  │ 500 sometimes when multiple     │    │
│  │ users order at the same time    │    │
│  └─────────────────────────────────┘    │
│                                         │
│  [Investigate]                          │
│                                         │
│  ─ ─ ─ ─ Investigation Log ─ ─ ─ ─ ─  │
│                                         │
│  ● Thinking...                     #1   │
│  ▶ fire_request                         │
│    GET http://localhost:3001/api/checkout│
│    ← 200 OK (42ms)                      │
│  ▶ fire_concurrent_requests             │
│    POST /api/checkout ×10               │
│    ← 8/10 succeeded {200: 8, 500: 2}   │
│  ▶ get_container_logs                   │
│    express-api (last 100 lines)         │
│    ← 100 log lines                      │
│  ▶ get_container_logs                   │
│    postgres (grep: "ERROR")             │
│    ← 3 log lines                        │
│  ▶ read_source_file                     │
│    src/routes/checkout.js               │
│    ← Read (142 lines)                   │
│  ● Thinking...                     #2   │
│  ▶ grep_source                          │
│    "inventory" in express-api           │
│    ← 5 matches                          │
│  ▶ read_source_file                     │
│    src/services/inventory.js:34-78      │
│    ← Read (44 lines)                    │
│                                         │
│  ─ ─ ─ ─ ─ Diagnosis ─ ─ ─ ─ ─ ─ ─ ─  │
│                                         │
│  ## Race condition in inventory check   │
│                                         │
│  The checkout handler reads inventory   │
│  count, validates it, then decrements   │
│  in separate queries with no locking... │
│                                         │
│  **Affected Services**: express-api,    │
│  postgres                               │
│                                         │
│  **Evidence**: [details...]             │
│                                         │
│  **Suggested Fix**: Use SELECT FOR      │
│  UPDATE or a transaction with row-level │
│  locking in inventory.js:45-52          │
│                                         │
│  **Confidence**: High                   │
│                                         │
│  [Run Again]  [Copy Report]  [Close]    │
└─────────────────────────────────────────┘
```

### Visual Design

- **Panel width**: 420px (same as NodeDetailPanel)
- **Background**: `var(--bg-primary)` with left border
- **Animation**: slide in from right (CSS `transform: translateX`)
- **Investigation steps**: Each step is a row with:
  - Icon: `●` for thinking (animated pulse), `▶` for tool call (blue), `←` for result (green/red)
  - Tool name in monospace
  - Input summary (truncated, expandable on click)
  - Result summary in muted text
- **Iteration markers**: Small `#1`, `#2` badges in the right margin when iteration changes
- **Diagnosis section**: Rendered markdown with styled headers, code blocks, bold text
- **Auto-scroll**: Investigation log auto-scrolls to bottom during running phase

### Key Interactions

1. **Enter to submit** in problem textarea (Shift+Enter for newline)
2. **Stop button** cancels the running investigation
3. **Copy Report** copies the diagnosis as markdown to clipboard
4. **Run Again** resets to input state, preserving the previous problem text
5. **Escape** closes the panel
6. **Click on a tool_call step** expands to show full input/output (optional, nice to have)

### Integration with Graph

When the diagnosis references specific services, highlight them on the graph:
- Parse service names from the diagnosis text
- Match against `nodes` in the graph
- Apply a CSS class (e.g., `rf-node-debug-highlighted`) to those nodes
- This is the same pattern as trace highlighting but simpler (just a static set of highlighted nodes)

---

## 4. Entry Points

### A. Header Button

Add a "Debug" button to the app header (next to the share/notification buttons):

```tsx
// In App.tsx, in the header-actions div:
<button
  className="alert-toggle"
  onClick={() => setShowDebugPanel(true)}
  title="Debug Agent"
>
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
    <circle cx="8" cy="8" r="6" />
    <path d="M8 5v3.5" />
    <circle cx="8" cy="11" r="0.5" fill="currentColor" />
  </svg>
</button>
```

State in App.tsx:
```tsx
const [showDebugPanel, setShowDebugPanel] = useState(false);

// In render:
{showDebugPanel && (
  <DebugPanel onClose={() => setShowDebugPanel(false)} />
)}
```

### B. Context Menu (optional, nice to have)

Add "Debug this service" to the graph context menu. Pre-fills the problem text with the service name, e.g., "Investigate issues with express-api:3001".

---

## 5. CSS

### File: `src/App.css` (add these styles)

Key classes to implement:

```
.debug-panel                     - Fixed right panel, 420px wide, full height
.debug-panel-header              - Title + close button
.debug-panel-setup               - API key input section
.debug-panel-input               - Problem description textarea
.debug-panel-input textarea      - Styled textarea matching app theme
.debug-panel-submit              - "Investigate" button (blue, prominent)
.debug-panel-investigation       - Scrollable log of steps
.debug-panel-step                - Individual step row
.debug-panel-step-thinking       - Pulsing dot animation for thinking
.debug-panel-step-tool           - Tool call with icon + details
.debug-panel-step-result         - Result summary line
.debug-panel-step-expandable     - Click to expand full input/output
.debug-panel-iteration-marker    - Small iteration number badge
.debug-panel-diagnosis           - Final report section
.debug-panel-diagnosis-header    - "Diagnosis" section header
.debug-panel-diagnosis-content   - Markdown-rendered content
.debug-panel-actions             - Bottom action buttons
.debug-panel-stop                - Red stop button during running
.debug-panel-copy                - Copy report button
.rf-node-debug-highlighted       - Node highlight class for diagnosed services
```

Animation: slide from right, same as NodeDetailPanel:
```css
.debug-panel {
  position: absolute;
  top: 0;
  right: 0;
  width: 420px;
  height: 100%;
  background: var(--bg-primary);
  border-left: 1px solid var(--border-primary);
  z-index: 100;
  display: flex;
  flex-direction: column;
  animation: slideInFromRight 0.2s ease-out;
}

@keyframes slideInFromRight {
  from { transform: translateX(100%); }
  to { transform: translateX(0); }
}
```

---

## 6. Files to Create

| File | Purpose |
|---|---|
| `electron/services/debugAgent.js` | Agent loop, tool execution, Claude API calls, API key management |
| `src/components/DebugPanel.tsx` | Renderer UI — input, investigation stream, diagnosis display |

## 7. Files to Modify

| File | Changes |
|---|---|
| `electron/main.js` | Add 4 IPC handlers: `debug-set-api-key`, `debug-get-api-key-status`, `debug-start`, `debug-stop` |
| `electron/preload.js` | Expose 5 methods on `window.electronAPI`: `debugSetApiKey`, `debugGetApiKeyStatus`, `debugStart`, `debugStop`, `onDebugProgress` |
| `src/types/electron.d.ts` | Add debug methods to `ElectronAPI` interface + `DebugProgress` type |
| `src/App.tsx` | Add `showDebugPanel` state + render `DebugPanel` + header button |
| `src/App.css` | Debug panel styles |

## 8. Implementation Order

1. **`debugAgent.js`** — API key storage + tool execution functions (test each tool independently against a running stack)
2. **IPC handlers + preload** — Wire up the bridge
3. **Types** — Add to `electron.d.ts`
4. **Agent loop** — The Claude API tool-use loop in `debugAgent.js`
5. **`DebugPanel.tsx`** — API key setup + input + investigation stream UI
6. **App integration** — Header button + panel rendering
7. **CSS** — Styling
8. **Polish** — Auto-scroll, copy report, graph highlighting

## 9. Security Considerations

- **API key**: Stored on disk at `~/.fere/config.json`, never sent to renderer, never logged
- **Source code reading**: Path traversal prevention — resolved path must be within `node.projectPath`
- **Database queries**: Only read-only queries allowed (SELECT, SHOW, DESCRIBE, EXPLAIN)
- **HTTP requests**: Uses existing SSRF protection from `security.js`
- **Context limits**: All tool results are truncated to prevent context window overflow
- **Iteration limit**: Max 25 agent iterations to prevent runaway API costs
- **Cancellation**: User can stop at any time; cancelled flag checked before each step

## 10. Cost Estimate

Typical investigation: ~5-15 iterations, each with 1-3 tool calls.
- Input tokens per call: ~2-4K (system prompt + conversation history)
- Output tokens per call: ~500-1K (tool calls + reasoning)
- Estimated total per investigation: ~30-80K tokens
- At Sonnet pricing (~$3/M input, $15/M output): **$0.10-$0.50 per investigation**

## 11. Verification

- Start a multi-service stack (e.g., `test/docker-test/`)
- Introduce a known bug (e.g., remove error handling from a route)
- Open Debug Panel, describe the symptom
- Verify the agent fires requests, reads logs, reads code
- Verify it identifies the correct root cause
- Verify the investigation stream updates in real-time
- Verify Stop button cancels the investigation
- Verify API key persistence across app restarts
- Run existing tests: `npm run test` and `npm run test:node`
