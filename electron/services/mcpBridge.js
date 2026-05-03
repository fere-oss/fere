/**
 * mcpBridge.js
 *
 * Local-loopback HTTP bridge that exposes Fere's runtime data to the MCP
 * stdio shim (bin/fere-mcp.js). The shim is what AI clients (Claude Code,
 * Cursor, Windsurf) spawn; this bridge is what the shim talks to so that
 * every tool call hits the *live* Fere snapshot instead of stale data.
 *
 * Wire format:
 *   GET /health
 *   GET /findings?severity=&service=
 *   GET /service?name=
 *   GET /topology
 *   GET /routes?service=
 *   GET /external-apis?service=
 *   GET /logs?container=&lines=
 *
 * Auth:  Authorization: Bearer <token>  (token persisted in ~/.fere/mcp.lock)
 * Bind:  127.0.0.1 only, ephemeral port written to the lockfile
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const LOCKFILE_DIR = path.join(os.homedir(), '.fere');
const LOCKFILE_PATH = path.join(LOCKFILE_DIR, 'mcp.lock');

let server = null;
let token = null;
let port = null;
let deps = null;

// ─── Lifecycle ────────────────────────────────────────────────────────────────

async function start(injectedDeps) {
  if (server) return { port, token };
  deps = injectedDeps;
  token = crypto.randomBytes(32).toString('hex');

  server = http.createServer(handleRequest);

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      writeLockfile();
      resolve({ port, token });
    });
  });
}

function stop() {
  if (server) {
    try { server.close(); } catch { /* noop */ }
    server = null;
  }
  try { fs.unlinkSync(LOCKFILE_PATH); } catch { /* noop */ }
  token = null;
  port = null;
}

function writeLockfile() {
  fs.mkdirSync(LOCKFILE_DIR, { recursive: true });
  const payload = JSON.stringify({
    port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
    version: 1,
  });
  fs.writeFileSync(LOCKFILE_PATH, payload, { mode: 0o600 });
}

// ─── Request dispatch ─────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  // Loopback enforcement (defense in depth — listen() already binds 127.0.0.1)
  const remote = req.socket.remoteAddress;
  if (
    remote !== '127.0.0.1' &&
    remote !== '::1' &&
    remote !== '::ffff:127.0.0.1'
  ) {
    return reply(res, 403, { error: 'forbidden: loopback only' });
  }

  // Token auth
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${token}`) {
    return reply(res, 401, { error: 'unauthorized' });
  }

  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const params = url.searchParams;

  try {
    let result;
    switch (url.pathname) {
      case '/health':         result = await handleHealth(); break;
      case '/findings':       result = await handleFindings(params); break;
      case '/service':        result = await handleService(params); break;
      case '/topology':       result = await handleTopology(); break;
      case '/routes':         result = await handleRoutes(params); break;
      case '/external-apis':  result = await handleExternalApis(params); break;
      case '/logs':           result = await handleLogs(params); break;
      default:
        return reply(res, 404, { error: `unknown path: ${url.pathname}` });
    }
    return reply(res, 200, result);
  } catch (err) {
    return reply(res, 500, { error: err && err.message ? err.message : String(err) });
  }
}

function reply(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ─── Snapshot helpers ─────────────────────────────────────────────────────────

function getSnapshot() {
  const sched = deps && deps.snapshotScheduler;
  if (!sched) return null;
  if (typeof sched.getLatestSnapshot === 'function') {
    const s = sched.getLatestSnapshot();
    if (s) return s;
  }
  return sched.previousSnapshot || null;
}

function findNode(nodes, name) {
  return nodes.find(
    (n) => n.name === name || n.label === name || n.id === name,
  );
}

function findContainerForService(snapshot, serviceName) {
  const containers = (snapshot && snapshot.docker && snapshot.docker.containers) || [];
  return containers.find(
    (c) =>
      (c.labels && c.labels['com.docker.compose.service'] === serviceName) ||
      c.name === serviceName ||
      (c.name && c.name.endsWith(`-${serviceName}-1`)),
  );
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleHealth() {
  const snapshot = getSnapshot();
  return {
    ok: true,
    bridgeVersion: 1,
    snapshotAvailable: !!snapshot,
    snapshotAge: snapshot && snapshot.meta && snapshot.meta.timestamp
      ? Date.now() - snapshot.meta.timestamp
      : null,
    nodeCount: snapshot && snapshot.graph && snapshot.graph.nodes
      ? snapshot.graph.nodes.length
      : 0,
  };
}

async function handleFindings(params) {
  const snapshot = getSnapshot();
  if (!snapshot) {
    return { findings: [], total: 0, error: 'no snapshot available yet' };
  }

  const all = await deps.runScan(snapshot);
  let filtered = all;

  const severity = params.get('severity');
  if (severity) {
    filtered = filtered.filter((f) => f.severity === severity);
  }
  const service = params.get('service');
  if (service) {
    filtered = filtered.filter(
      (f) =>
        f.service === service ||
        (Array.isArray(f.affectedServices) && f.affectedServices.includes(service)),
    );
  }

  return {
    findings: filtered.map((f) => ({
      id: f.id,
      severity: f.severity,
      category: f.category,
      service: f.service,
      summary: f.summary,
      detail: f.detail,
      impact: f.impact,
      affectedServices: f.affectedServices || [],
      fix: f.fix
        ? {
            type: f.fix.type,
            label: f.fix.label,
            executable: !!f.fix.executable,
          }
        : null,
    })),
    total: all.length,
  };
}

async function handleService(params) {
  const name = params.get('name');
  if (!name) throw new Error('parameter "name" is required');

  const snapshot = getSnapshot();
  if (!snapshot) return { error: 'no snapshot available yet' };

  const nodes = (snapshot.graph && snapshot.graph.nodes) || [];
  const edges = (snapshot.graph && snapshot.graph.edges) || [];

  const node = findNode(nodes, name);
  if (!node) return { error: `service '${name}' not found` };

  const idToNode = new Map(nodes.map((n) => [n.id, n]));
  const calls = edges
    .filter((e) => e.source === node.id)
    .map((e) => {
      const t = idToNode.get(e.target);
      return { service: (t && (t.name || t.label)) || e.target, type: e.type || null };
    });
  const calledBy = edges
    .filter((e) => e.target === node.id)
    .map((e) => {
      const s = idToNode.get(e.source);
      return { service: (s && (s.name || s.label)) || e.source, type: e.type || null };
    });

  // Pull recent logs if this service maps to a Docker container
  let recentLogs = null;
  const container = findContainerForService(snapshot, node.name || name);
  if (container && deps.agentDockerLogs) {
    try {
      recentLogs = await deps.agentDockerLogs(container.id, 40);
    } catch { /* skip */ }
  }

  return {
    service: {
      id: node.id,
      name: node.name,
      label: node.label,
      type: node.type,
      health: node.health,
      pid: node.pid,
      ports: (node.ports || []).map((p) => ({
        port: p.port,
        protocol: p.protocol,
        process: p.process,
      })),
      projectPath: node.projectPath,
      project: node.project,
      isContainer: !!(node.isContainer || node.isDockerContainer),
      cpu: node.cpu,
      memoryMB: node.memory,
    },
    container: container
      ? { id: container.id, name: container.name, status: container.status, state: container.state }
      : null,
    calls,
    calledBy,
    recentLogs,
  };
}

async function handleTopology() {
  const snapshot = getSnapshot();
  if (!snapshot) return { nodes: [], edges: [], error: 'no snapshot available yet' };

  const nodes = ((snapshot.graph && snapshot.graph.nodes) || []).map((n) => ({
    id: n.id,
    name: n.name,
    type: n.type,
    health: n.health,
    ports: (n.ports || []).map((p) => p.port),
    projectPath: n.projectPath,
    isContainer: !!(n.isContainer || n.isDockerContainer),
  }));
  const edges = ((snapshot.graph && snapshot.graph.edges) || []).map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    type: e.type || null,
  }));

  return {
    nodes,
    edges,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    timestamp: snapshot.meta && snapshot.meta.timestamp,
  };
}

function projectPathsForServiceFilter(snapshot, serviceFilter) {
  const nodes = (snapshot.graph && snapshot.graph.nodes) || [];
  const targets = serviceFilter
    ? nodes.filter(
        (n) => n.name === serviceFilter || n.label === serviceFilter || n.id === serviceFilter,
      )
    : nodes;
  const set = new Set();
  for (const n of targets) {
    if (n.projectPath) set.add(n.projectPath);
  }
  return [...set];
}

async function handleRoutes(params) {
  const snapshot = getSnapshot();
  if (!snapshot) return { routes: [] };

  const projectPaths = projectPathsForServiceFilter(snapshot, params.get('service'));
  const out = [];
  for (const p of projectPaths) {
    try {
      const r = await deps.scanRoutes(p);
      if (Array.isArray(r)) {
        for (const route of r) out.push({ ...route, projectPath: p });
      }
    } catch { /* skip */ }
  }
  return { routes: out };
}

async function handleExternalApis(params) {
  const snapshot = getSnapshot();
  if (!snapshot) return { apis: [] };

  const projectPaths = projectPathsForServiceFilter(snapshot, params.get('service'));
  const out = [];
  for (const p of projectPaths) {
    try {
      const data = await deps.scanExternalApis(p);
      const items = Array.isArray(data) ? data : (data && data.providers) || [];
      for (const it of items) out.push({ ...it, projectPath: p });
    } catch { /* skip */ }
  }
  return { apis: out };
}

async function handleLogs(params) {
  const container = params.get('container');
  if (!container) throw new Error('parameter "container" is required');
  const linesRaw = parseInt(params.get('lines') || '80', 10);
  const lines = Number.isFinite(linesRaw) ? Math.max(1, Math.min(500, linesRaw)) : 80;

  const logs = await deps.agentDockerLogs(container, lines);
  return { logs, lines };
}

module.exports = { start, stop };
