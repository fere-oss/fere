const test = require("node:test");
const assert = require("node:assert/strict");

const { SnapshotScheduler } = require("./snapshotScheduler");

function makeSnapshot(projectPath) {
  return {
    processes: [],
    ports: [],
    connections: [],
    graph: {
      nodes: [
        {
          id: "proc-1",
          pid: 1,
          name: "node",
          command: "node server.js",
          type: "nodejs",
          cpu: 0,
          memory: 0,
          user: "me",
          tty: null,
          project: projectPath ? "demo-stack" : null,
          projectPath: projectPath || null,
          repoPath: "/Users/me/fere",
          ports: [],
          routes: [],
          healthStatus: "green",
          lastSeen: Date.now(),
        },
      ],
      edges: [],
    },
    docker: null,
    meta: {
      collectedAt: Date.now(),
      processesAgeMs: 0,
      portsAgeMs: 0,
      connectionsAgeMs: 0,
    },
  };
}

test("computeDelta includes projectPath updates for existing nodes", () => {
  const scheduler = new SnapshotScheduler();
  scheduler.previousSnapshot = makeSnapshot("/Users/me/demo-stack");

  const second = scheduler.computeDelta(makeSnapshot(null));
  assert.equal(second.type, "metrics");
  assert.ok(second.graph?.nodes?.modified?.length, "expected modified node patch");

  const patch = second.graph.nodes.modified[0];
  assert.equal(patch.id, "proc-1");
  assert.equal(patch.projectPath, null);
  assert.equal(patch.project, null);
});

// ── computeDelta: first snapshot → full type ──────────────────────────────────

test("computeDelta: returns full type when no previous snapshot", () => {
  const scheduler = new SnapshotScheduler();
  const snap = makeSnapshot("/Users/me/project");
  const delta = scheduler.computeDelta(snap);
  assert.equal(delta.type, "full");
  assert.ok(delta.graph);
});

// ── computeDelta: null when nothing changed ───────────────────────────────────

test("computeDelta: returns null when snapshot is identical", () => {
  const scheduler = new SnapshotScheduler();
  const snap = makeSnapshot("/Users/me/project");
  scheduler.previousSnapshot = snap;
  const delta = scheduler.computeDelta(snap);
  assert.equal(delta, null);
});

// ── computeDelta: process additions and removals ──────────────────────────────

test("computeDelta: detects added process as topology change", () => {
  const scheduler = new SnapshotScheduler();
  const prev = makeSnapshot(null);
  scheduler.previousSnapshot = prev;

  const next = makeSnapshot(null);
  next.processes = [{ pid: 9999, name: "new-proc", cpu: 0, memory: 0, status: "S" }];
  next.graph.nodes.push({
    id: "new-node",
    pid: 9999,
    name: "new-proc",
    type: "other",
    cpu: 0,
    memory: 0,
    user: "me",
    tty: null,
    project: null,
    projectPath: null,
    repoPath: null,
    ports: [],
    routes: [],
    healthStatus: "green",
    lastSeen: Date.now(),
  });

  const delta = scheduler.computeDelta(next);
  assert.ok(delta);
  assert.ok(["delta", "full"].includes(delta.type));
  assert.ok(delta.processes?.added?.length > 0, "expected added process in delta");
});

test("computeDelta: detects removed process as topology change", () => {
  const scheduler = new SnapshotScheduler();
  const prev = {
    processes: [{ pid: 1234, name: "old-proc", cpu: 0, memory: 0, status: "S" }],
    ports: [],
    connections: [],
    graph: {
      nodes: [
        {
          id: "old-node",
          pid: 1234,
          name: "old-proc",
          type: "other",
          cpu: 0,
          memory: 0,
          user: "me",
          tty: null,
          project: null,
          projectPath: null,
          repoPath: null,
          ports: [],
          routes: [],
          healthStatus: "green",
          lastSeen: Date.now(),
        },
      ],
      edges: [],
    },
    docker: null,
    meta: { collectedAt: Date.now() },
  };
  scheduler.previousSnapshot = prev;

  const next = makeSnapshot(null);
  next.processes = [];
  next.graph.nodes = [];

  const delta = scheduler.computeDelta(next);
  assert.ok(delta);
  assert.ok(delta.processes?.removed?.includes(1234), "expected removed PID in delta");
});

// ── computeDelta: metrics-only change ────────────────────────────────────────

test("computeDelta: returns metrics type when only cpu/memory changed", () => {
  const scheduler = new SnapshotScheduler();
  const prev = makeSnapshot("/Users/me/project");
  scheduler.previousSnapshot = prev;

  const next = makeSnapshot("/Users/me/project");
  // Change cpu on the existing node
  next.graph.nodes[0] = { ...next.graph.nodes[0], cpu: 45.5 };

  const delta = scheduler.computeDelta(next);
  assert.ok(delta);
  assert.equal(delta.type, "metrics");
  assert.equal(delta.graph.nodes.modified[0].cpu, 45.5);
});

// ── computeDelta: port changes ────────────────────────────────────────────────

test("computeDelta: detects added port", () => {
  const scheduler = new SnapshotScheduler();
  const prev = makeSnapshot(null);
  scheduler.previousSnapshot = prev;

  const next = makeSnapshot(null);
  next.ports = [{ port: 3000, pid: 1, process: "node" }];

  const delta = scheduler.computeDelta(next);
  assert.ok(delta);
  assert.ok(delta.ports?.added?.length > 0);
  assert.equal(delta.ports.added[0].port, 3000);
});

test("computeDelta: detects removed port", () => {
  const scheduler = new SnapshotScheduler();
  const prev = makeSnapshot(null);
  prev.ports = [{ port: 8080, pid: 1, process: "node" }];
  scheduler.previousSnapshot = prev;

  const next = makeSnapshot(null);
  next.ports = [];

  const delta = scheduler.computeDelta(next);
  assert.ok(delta);
  assert.ok(delta.ports?.removed?.length > 0);
});

// ── computeDelta: edge changes ────────────────────────────────────────────────

test("computeDelta: detects added edge", () => {
  const scheduler = new SnapshotScheduler();
  scheduler.previousSnapshot = makeSnapshot(null);

  const next = makeSnapshot(null);
  next.graph.edges = [
    { id: "edge-1", source: "proc-1", target: "proc-2", sourcePort: 8000, targetPort: 5432 },
  ];

  const delta = scheduler.computeDelta(next);
  assert.ok(delta);
  assert.ok(delta.graph?.edges?.added?.length > 0);
});

test("computeDelta: source-analysis edges are never removed via delta", () => {
  const scheduler = new SnapshotScheduler();
  const prev = makeSnapshot(null);
  prev.graph.edges = [
    { id: "source-analysis:a->b", source: "a", target: "b", sourcePort: 0, targetPort: 0 },
  ];
  scheduler.previousSnapshot = prev;

  const next = makeSnapshot(null);
  next.graph.edges = []; // source-analysis edge gone from current snapshot

  const delta = scheduler.computeDelta(next);
  // May be null (no other changes) or have no removed source-analysis edges
  if (delta?.graph?.edges?.removed) {
    assert.ok(
      !delta.graph.edges.removed.some((id) => id.startsWith("source-analysis:")),
      "source-analysis edges must never appear in removed list",
    );
  }
});

// ── sequence number ───────────────────────────────────────────────────────────

test("computeDelta: sequence number increments on each call", () => {
  const scheduler = new SnapshotScheduler();
  const snap1 = scheduler.computeDelta(makeSnapshot(null));
  const seq1 = snap1.seq;

  scheduler.previousSnapshot = makeSnapshot(null);
  const snap2 = makeSnapshot(null);
  snap2.ports = [{ port: 9000, pid: 1, process: "node" }];
  const delta2 = scheduler.computeDelta(snap2);
  assert.ok(delta2.seq > seq1, "sequence should increment");
});

// ── throttle / unthrottle ─────────────────────────────────────────────────────

test("throttle: sets throttled flag and re-uses on multiple calls", () => {
  const scheduler = new SnapshotScheduler({ reconciliationInterval: 100, fastProbeInterval: 50 });
  scheduler.running = true;
  scheduler.reconcileTimer = setInterval(() => {}, 100000);
  scheduler.fastProbeTimer = setInterval(() => {}, 100000);

  scheduler.throttle();
  assert.equal(scheduler.throttled, true);

  // Second call is a no-op
  scheduler.throttle();
  assert.equal(scheduler.throttled, true);

  scheduler.stop();
});

test("unthrottle: clears throttled flag and resets idle probe counter", () => {
  const scheduler = new SnapshotScheduler({ reconciliationInterval: 100, fastProbeInterval: 50 });
  scheduler.running = true;
  scheduler.reconcileTimer = setInterval(() => {}, 100000);
  scheduler.fastProbeTimer = setInterval(() => {}, 100000);
  scheduler.throttled = true;
  scheduler._stableProbeCount = 20;

  scheduler.unthrottle();
  assert.equal(scheduler.throttled, false);
  assert.equal(scheduler._stableProbeCount, 0);

  scheduler.stop();
});

// ── _getMultiplier ────────────────────────────────────────────────────────────

test("_getMultiplier: 1× when normal", () => {
  const s = new SnapshotScheduler();
  assert.equal(s._getMultiplier(), 1);
});

test("_getMultiplier: THROTTLE_MULTIPLIER when throttled", () => {
  const s = new SnapshotScheduler();
  s.throttled = true;
  assert.equal(s._getMultiplier(), s.THROTTLE_MULTIPLIER);
});

test("_getMultiplier: BATTERY_MULTIPLIER when on battery", () => {
  const s = new SnapshotScheduler();
  s.onBattery = true;
  assert.equal(s._getMultiplier(), s.BATTERY_MULTIPLIER);
});

test("_getMultiplier: product of both multipliers when throttled + on battery", () => {
  const s = new SnapshotScheduler();
  s.throttled = true;
  s.onBattery = true;
  assert.equal(s._getMultiplier(), s.THROTTLE_MULTIPLIER * s.BATTERY_MULTIPLIER);
});

// ── worker restart cap ────────────────────────────────────────────────────────

test("_restartWorker: stops retrying after MAX_RESTART_ATTEMPTS", () => {
  const scheduler = new SnapshotScheduler();
  scheduler.running = true;
  scheduler.workerReady = true;

  // Simulate MAX_RESTART_ATTEMPTS exceeded — _workerRestartCount is already at the limit
  scheduler._workerRestartCount = 5; // MAX_RESTART_ATTEMPTS
  scheduler._restartWorker();

  assert.equal(scheduler.workerReady, false, "workerReady should be false after giving up");
  assert.equal(scheduler.workerBusy, false);

  scheduler.running = false;
});
