#!/usr/bin/env node
/**
 * fere-mcp
 *
 * Stdio MCP server that AI clients (Claude Code, Cursor, Windsurf, Zed) spawn
 * to pull live runtime data from a running Fere desktop app. The shim is thin —
 * every tool call forwards to the local-loopback HTTP bridge inside Fere
 * (electron/services/mcpBridge.js) so the AI sees current snapshot data, not
 * stale state.
 *
 * Discovery: reads ~/.fere/mcp.lock for {port, token, pid}. If the lockfile is
 * missing or the recorded PID is dead, every tool call returns a clean
 * "Fere is not running" error so the AI degrades gracefully.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const LOCKFILE_PATH = path.join(os.homedir(), '.fere', 'mcp.lock');

// ─── Bridge client ────────────────────────────────────────────────────────────

function readLockfile() {
  try {
    if (!fs.existsSync(LOCKFILE_PATH)) return null;
    const lock = JSON.parse(fs.readFileSync(LOCKFILE_PATH, 'utf8'));
    if (lock && lock.pid && !isPidAlive(lock.pid)) return null;
    return lock;
  } catch {
    return null;
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function bridgeRequest(pathname, params, options) {
  const lock = readLockfile();
  if (!lock) {
    return Promise.reject(
      new Error(
        'Fere is not running. Open the Fere desktop app and try again — its MCP bridge will become available within a few seconds.',
      ),
    );
  }

  const opts = options || {};
  const isPost = opts.method === 'POST';
  const url = new URL(`http://127.0.0.1:${lock.port}${pathname}`);
  if (!isPost && params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  return new Promise((resolve, reject) => {
    const headers = { Authorization: `Bearer ${lock.token}` };
    let bodyStr = null;
    if (isPost) {
      bodyStr = JSON.stringify(params || {});
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = http.request(
      url,
      {
        method: isPost ? 'POST' : 'GET',
        headers,
        timeout: opts.timeout || 15000,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let data;
          try {
            data = JSON.parse(body);
          } catch {
            return reject(new Error(`Bridge returned invalid JSON (HTTP ${res.statusCode})`));
          }
          if (res.statusCode >= 400) {
            return reject(new Error(data.error || `Bridge HTTP ${res.statusCode}`));
          }
          resolve(data);
        });
      },
    );
    req.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        reject(
          new Error(
            'Fere bridge unreachable — the app may have shut down. Reopen Fere and retry.',
          ),
        );
      } else {
        reject(e);
      }
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Fere bridge timed out after ${opts.timeout || 15000}ms`));
    });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_findings',
    description:
      'List ranked Sentinel findings — issues detected in the live local development stack (port conflicts, down services, unhealthy containers, high CPU, restart loops, env mismatches, etc). Each finding has severity (critical/warning/info), the affected service, downstream services impacted, and a concrete fix action where available. Use this first when the user asks "why is X broken" or "what is wrong with my stack".',
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['critical', 'warning', 'info'],
          description: 'Filter by severity',
        },
        service: {
          type: 'string',
          description: 'Only findings affecting this service (matches name, label, or in affectedServices)',
        },
      },
    },
  },
  {
    name: 'get_service',
    description:
      'Get live state of a single service: health, ports, container status, recent log tail (if it is a Docker container), and graph edges showing what it calls and what calls it. Use this to investigate a specific service in depth.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Service name — matches node.name, label, or id from the topology',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_topology',
    description:
      'Get the full live service graph: nodes (every running process / container) and edges (TCP connections between them). Use this when you need to understand what the user has running and how the services are wired together.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_routes',
    description:
      'List discovered HTTP API routes across the local stack — supports FastAPI, Flask, Express, Next.js API routes, Koa, Hono, and plain Node HTTP servers. Routes are scanned from source. Optionally scope to a single service.',
    inputSchema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          description: 'Only return routes from the project that owns this service',
        },
      },
    },
  },
  {
    name: 'list_external_apis',
    description:
      'List external API providers the local code calls (third-party services like OpenAI, Stripe, AWS, Postgres clouds, etc). Detected from source imports and .env hints. Optionally scope to a single service.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string' },
      },
    },
  },
  {
    name: 'get_logs',
    description:
      'Get a recent log slice from a Docker container by id or name. Use after list_findings or get_service to pull more context on a problem.',
    inputSchema: {
      type: 'object',
      properties: {
        container: { type: 'string', description: 'Container id or name' },
        lines: {
          type: 'number',
          description: 'Number of trailing log lines (default 80, max 500)',
        },
      },
      required: ['container'],
    },
  },
  {
    name: 'apply_fix',
    description:
      'Apply the fix attached to a Sentinel finding (kill a process on a port, restart a container, etc). REQUIRES HUMAN APPROVAL: Fere shows a modal to the user; the call blocks for up to 60 seconds waiting for them to click Approve or Deny. Returns { approved, executed, reason, summary, result }. Use only after list_findings has shown the finding to the user — do not invent finding IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        finding_id: {
          type: 'string',
          description: 'The id of the finding (from list_findings). The fix attached to that finding is what gets applied.',
        },
      },
      required: ['finding_id'],
    },
  },
];

// ─── Server wiring ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'fere', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = args || {};

  try {
    let result;
    switch (name) {
      case 'list_findings':
        result = await bridgeRequest('/findings', { severity: a.severity, service: a.service });
        break;
      case 'get_service':
        result = await bridgeRequest('/service', { name: a.name });
        break;
      case 'get_topology':
        result = await bridgeRequest('/topology');
        break;
      case 'list_routes':
        result = await bridgeRequest('/routes', { service: a.service });
        break;
      case 'list_external_apis':
        result = await bridgeRequest('/external-apis', { service: a.service });
        break;
      case 'get_logs':
        result = await bridgeRequest('/logs', { container: a.container, lines: a.lines });
        break;
      case 'apply_fix':
        result = await bridgeRequest(
          '/apply-fix',
          { finding_id: a.finding_id },
          { method: 'POST', timeout: 90_000 },
        );
        break;
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: err && err.message ? err.message : String(err) }],
      isError: true,
    };
  }
});

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})().catch((err) => {
  // Stdio is the protocol channel — write errors to stderr so they don't
  // corrupt JSON-RPC framing.
  process.stderr.write(`[fere-mcp] fatal: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
