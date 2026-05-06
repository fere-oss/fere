const test = require("node:test");
const assert = require("node:assert/strict");

const { runScan, executeAction, buildNodeDetails } = require("./sentinelEngine");

// Minimal snapshot with no projectPaths — avoids filesystem reads in detectAdvisory / detectEnvMismatches.
function makeSnapshot({ nodes = [], edges = [], ports = [], docker = null } = {}) {
  return {
    processes: [],
    ports,
    connections: [],
    graph: { nodes, edges },
    docker,
    meta: { collectedAt: Date.now() },
  };
}

function makeNode(overrides = {}) {
  return {
    id: overrides.id ?? "node-1",
    name: overrides.name ?? "api",
    type: overrides.type ?? "nodejs",
    pid: overrides.pid ?? 1234,
    pids: overrides.pids ?? [],
    ports: overrides.ports ?? [],
    healthStatus: overrides.healthStatus ?? "green",
    cpu: overrides.cpu ?? null,
    memory: overrides.memory ?? null,
    isContainer: overrides.isContainer ?? false,
    isDockerContainer: overrides.isDockerContainer ?? false,
    projectPath: overrides.projectPath ?? null,
    ...overrides,
  };
}

// ── detectHighResourceUsage ───────────────────────────────────────────────────

test("detectHighResourceUsage: emits warning when CPU >= 80%", async () => {
  const node = makeNode({ id: "svc-1", name: "api", cpu: 85, pid: 100 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "high-cpu-svc-1");
  assert.ok(f, "expected high-cpu finding");
  assert.equal(f.severity, "warning");
  assert.match(f.summary, /85/);
});

test("detectHighResourceUsage: emits critical when CPU >= 95%", async () => {
  const node = makeNode({ id: "svc-2", name: "worker", cpu: 97, pid: 200 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "high-cpu-svc-2");
  assert.ok(f);
  assert.equal(f.severity, "critical");
});

test("detectHighResourceUsage: no finding when CPU below threshold", async () => {
  const node = makeNode({ id: "svc-3", name: "web", cpu: 50, pid: 300 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "high-cpu-svc-3"));
});

test("detectHighResourceUsage: skips docker containers", async () => {
  const node = makeNode({ id: "c-1", name: "redis", cpu: 99, pid: 400, isDockerContainer: true });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "high-cpu-c-1"));
});

test("detectHighResourceUsage: warning when memory >= 512 MB", async () => {
  const node = makeNode({ id: "svc-4", name: "api", memory: 600, pid: 500 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "high-mem-svc-4");
  assert.ok(f);
  assert.equal(f.severity, "warning");
});

test("detectHighResourceUsage: critical when memory >= 2048 MB", async () => {
  const node = makeNode({ id: "svc-5", name: "api", memory: 2100, pid: 600 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "high-mem-svc-5");
  assert.ok(f);
  assert.equal(f.severity, "critical");
});

// ── detectDownServices ────────────────────────────────────────────────────────

test("detectDownServices: emits finding for red health node", async () => {
  const node = makeNode({ id: "down-1", name: "auth", healthStatus: "red", pid: 700 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "service-down-down-1");
  assert.ok(f);
  assert.equal(f.severity, "critical");
  assert.equal(f.service, "auth");
});

test("detectDownServices: includes dependents in impact", async () => {
  const downNode = makeNode({ id: "db-1", name: "postgres", healthStatus: "red", pid: 800 });
  const depNode = makeNode({ id: "api-1", name: "api", healthStatus: "green", pid: 801 });
  const edges = [{ source: "api-1", target: "db-1", sourcePort: 5001, targetPort: 5432 }];
  const snapshot = makeSnapshot({ nodes: [downNode, depNode], edges });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "service-down-db-1");
  assert.ok(f);
  assert.ok(f.affectedServices.includes("api"), "expected api in affectedServices");
});

test("detectDownServices: skips pid=-1 ghost nodes", async () => {
  const node = makeNode({ id: "ghost-1", name: "ghost", healthStatus: "red", pid: -1 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "service-down-ghost-1"));
});

// ── detectCascadeImpact ───────────────────────────────────────────────────────

test("detectCascadeImpact: emits finding when 2+ services depend on a down node", async () => {
  const down = makeNode({ id: "cache-1", name: "redis", healthStatus: "red", pid: 900 });
  const dep1 = makeNode({ id: "svc-a", name: "checkout", pid: 901 });
  const dep2 = makeNode({ id: "svc-b", name: "sessions", pid: 902 });
  const edges = [
    { source: "svc-a", target: "cache-1", sourcePort: 6000, targetPort: 6379 },
    { source: "svc-b", target: "cache-1", sourcePort: 6001, targetPort: 6379 },
  ];
  const snapshot = makeSnapshot({ nodes: [down, dep1, dep2], edges });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "cascade-cache-1");
  assert.ok(f);
  assert.equal(f.severity, "critical");
  assert.ok(f.affectedServices.includes("checkout"));
  assert.ok(f.affectedServices.includes("sessions"));
});

test("detectCascadeImpact: no finding when only 1 dependent", async () => {
  const down = makeNode({ id: "q-1", name: "rabbit", healthStatus: "red", pid: 910 });
  const dep = makeNode({ id: "svc-c", name: "mailer", pid: 911 });
  const edges = [{ source: "svc-c", target: "q-1", sourcePort: 5001, targetPort: 5672 }];
  const snapshot = makeSnapshot({ nodes: [down, dep], edges });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "cascade-q-1"));
});

// ── detectPortConflicts ───────────────────────────────────────────────────────

test("detectPortConflicts: flags port held by unknown PID", async () => {
  const node = makeNode({ id: "web-1", name: "frontend", pid: 1000, ports: [{ port: 3000 }] });
  // Port 3000 is owned by known PID 1000, but there is also a stale entry from PID 9999 (unknown)
  const ports = [
    { port: 3000, pid: 1000, process: "node" },
    { port: 3000, pid: 9999, process: "old-server" },
  ];
  const snapshot = makeSnapshot({ nodes: [node], ports });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "port-conflict-3000");
  assert.ok(f);
  assert.equal(f.severity, "critical");
  assert.equal(f.fix.type, "kill-port");
  assert.equal(f.fix.pid, 9999);
});

test("detectPortConflicts: no finding when all PIDs are known", async () => {
  const node = makeNode({ id: "web-2", name: "server", pid: 2000, ports: [{ port: 8080 }] });
  const ports = [{ port: 8080, pid: 2000, process: "node" }];
  const snapshot = makeSnapshot({ nodes: [node], ports });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "port-conflict-8080"));
});

// ── detectStoppedContainers ───────────────────────────────────────────────────

test("detectStoppedContainers: finds exited containers from snapshot", async () => {
  const docker = {
    containers: [{ id: "abc123def456", name: "myapp-db", image: "postgres:15", state: "exited" }],
  };
  const snapshot = makeSnapshot({ docker });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "container-stopped-abc123def456");
  assert.ok(f);
  assert.equal(f.severity, "warning");
  assert.equal(f.fix.type, "restart-container");
});

test("detectStoppedContainers: running containers are not flagged", async () => {
  const docker = {
    containers: [{ id: "run123456789", name: "myapp-api", image: "node:20", state: "running" }],
  };
  const snapshot = makeSnapshot({ docker });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "container-stopped-run123456789"));
});

test("detectStoppedContainers: dead containers are flagged", async () => {
  const docker = {
    containers: [{ id: "dead12345678", name: "myapp-worker", image: "node:20", state: "dead" }],
  };
  const snapshot = makeSnapshot({ docker });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.service === "myapp-worker");
  assert.ok(f);
  assert.match(f.id, /container-stopped-/);
});

// ── detectUnhealthyContainers ─────────────────────────────────────────────────

test("detectUnhealthyContainers: flags running container with failing health checks", async () => {
  const docker = {
    containers: [
      {
        id: "unhealthy00123",
        name: "myapp-cache",
        state: "running",
        health: {
          status: "unhealthy",
          failingStreak: 3,
          checks: [{ output: "connection refused" }],
        },
      },
    ],
  };
  const snapshot = makeSnapshot({ docker });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.service === "myapp-cache");
  assert.ok(f);
  assert.equal(f.severity, "critical");
  assert.match(f.detail, /3 consecutive/);
});

// ── detectRestartingContainers ────────────────────────────────────────────────

test("detectRestartingContainers: flags crash-looping container", async () => {
  const docker = {
    containers: [
      { id: "restart12345", name: "myapp-bg", image: "worker:latest", state: "restarting" },
    ],
  };
  const snapshot = makeSnapshot({ docker });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "container-restarting-restart12345");
  assert.ok(f);
  assert.equal(f.severity, "critical");
  assert.match(f.summary, /crash-looping/);
});

// ── detectDisconnectedServices ────────────────────────────────────────────────

test("detectDisconnectedServices: flags isolated service when others exist", async () => {
  const nodeA = makeNode({ id: "iso-1", name: "isolated-api", pid: 3000, ports: [{ port: 9000 }] });
  const nodeB = makeNode({ id: "iso-2", name: "other-svc", pid: 3001 });
  const snapshot = makeSnapshot({ nodes: [nodeA, nodeB], edges: [] });
  const findings = await runScan(snapshot);
  const f = findings.find((f) => f.id === "disconnected-iso-1");
  assert.ok(f);
  assert.equal(f.severity, "warning");
});

test("detectDisconnectedServices: single-node graph does not flag isolation", async () => {
  const node = makeNode({ id: "solo-1", name: "only-svc", pid: 4000 });
  const snapshot = makeSnapshot({ nodes: [node] });
  const findings = await runScan(snapshot);
  assert.ok(!findings.find((f) => f.id === "disconnected-solo-1"));
});

// ── runScan: deduplication ────────────────────────────────────────────────────

test("runScan: deduplicates findings by id", async () => {
  // A node that triggers both service-down and cascade (same down node referenced twice)
  const down = makeNode({ id: "dup-svc", name: "db", healthStatus: "red", pid: 5000 });
  const snapshot = makeSnapshot({ nodes: [down] });
  const findings = await runScan(snapshot);
  const ids = findings.map((f) => f.id);
  const unique = new Set(ids);
  assert.equal(ids.length, unique.size, "findings should not have duplicate IDs");
});

test("runScan: empty snapshot returns no findings", async () => {
  const findings = await runScan(makeSnapshot());
  assert.equal(findings.length, 0);
});

// ── runScan: nodeIds filter ───────────────────────────────────────────────────

test("runScan: scopes to specified nodeIds", async () => {
  const nodeA = makeNode({ id: "a", name: "frontend", cpu: 90, pid: 6000 });
  const nodeB = makeNode({ id: "b", name: "backend", cpu: 90, pid: 6001 });
  const snapshot = makeSnapshot({ nodes: [nodeA, nodeB] });
  // Only scan node a
  const findings = await runScan(snapshot, ["a"]);
  assert.ok(findings.find((f) => f.id === "high-cpu-a"));
  assert.ok(!findings.find((f) => f.id === "high-cpu-b"));
});

// ── executeAction ─────────────────────────────────────────────────────────────

test("executeAction: rejects unknown action type", async () => {
  await assert.rejects(() => executeAction({ type: "explode" }), /Unknown action type/);
});

test("executeAction: rejects kill-port with invalid port", async () => {
  await assert.rejects(
    () => executeAction({ type: "kill-port", port: -1, pid: 123 }),
    /Invalid kill-port payload/,
  );
});

test("executeAction: rejects restart-container with short id", async () => {
  await assert.rejects(
    () => executeAction({ type: "restart-container", containerId: "ab" }),
    /Invalid restart-container payload/,
  );
});

test("executeAction: rejects write-file outside home directories", async () => {
  await assert.rejects(
    () => executeAction({ type: "write-file", filePath: "/etc/passwd", content: "bad" }),
    /Access denied/,
  );
});

test("executeAction: rejects write-file with non-absolute path", async () => {
  await assert.rejects(
    () => executeAction({ type: "write-file", filePath: "relative/path.txt", content: "x" }),
    /Invalid filePath/,
  );
});

// ── buildNodeDetails ──────────────────────────────────────────────────────────

test("buildNodeDetails: returns not-found string for missing node", () => {
  const result = buildNodeDetails(null, [], []);
  assert.equal(result, "Node not found.");
});

test("buildNodeDetails: includes basic node fields", () => {
  const node = makeNode({
    id: "n1",
    name: "api-server",
    type: "nodejs",
    pid: 7000,
    healthStatus: "green",
    cpu: 12.5,
    command: "node server.js",
  });
  const result = buildNodeDetails(node, [], []);
  assert.match(result, /api-server/);
  assert.match(result, /nodejs/);
  assert.match(result, /green/);
  assert.match(result, /7000/);
  assert.match(result, /12.50%/);
  assert.match(result, /node server\.js/);
});

test("buildNodeDetails: lists inbound and outbound connections", () => {
  const node = makeNode({ id: "mid", name: "api", pid: 8000 });
  const caller = makeNode({ id: "fe", name: "frontend", pid: 8001 });
  const db = makeNode({ id: "db", name: "postgres", pid: 8002 });
  const edges = [
    { source: "fe", target: "mid", sourcePort: 3000, targetPort: 8000 },
    { source: "mid", target: "db", sourcePort: 8000, targetPort: 5432 },
  ];
  const result = buildNodeDetails(node, [node, caller, db], edges);
  assert.match(result, /Inbound.*frontend/s);
  assert.match(result, /Outbound.*postgres/s);
});
