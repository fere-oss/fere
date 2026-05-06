const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { containerHealthToGraphHealth, buildContainerConnections } = require("./dockerMonitor");

// ── containerHealthToGraphHealth ──────────────────────────────────────────────

test("containerHealthToGraphHealth: running with healthy status → green", () => {
  assert.equal(
    containerHealthToGraphHealth({ state: "running", health: { status: "healthy" } }),
    "green",
  );
});

test("containerHealthToGraphHealth: running with no health → green", () => {
  assert.equal(containerHealthToGraphHealth({ state: "running" }), "green");
});

test("containerHealthToGraphHealth: running but unhealthy → yellow (degraded, not down)", () => {
  assert.equal(
    containerHealthToGraphHealth({ state: "running", health: { status: "unhealthy" } }),
    "yellow",
  );
});

test("containerHealthToGraphHealth: restarting → yellow", () => {
  assert.equal(containerHealthToGraphHealth({ state: "restarting" }), "yellow");
});

test("containerHealthToGraphHealth: paused → yellow", () => {
  assert.equal(containerHealthToGraphHealth({ state: "paused" }), "yellow");
});

test("containerHealthToGraphHealth: exited → red", () => {
  assert.equal(containerHealthToGraphHealth({ state: "exited" }), "red");
});

test("containerHealthToGraphHealth: dead → red", () => {
  assert.equal(containerHealthToGraphHealth({ state: "dead" }), "red");
});

test("containerHealthToGraphHealth: unknown state → yellow (safe default)", () => {
  assert.equal(containerHealthToGraphHealth({ state: "unknown" }), "yellow");
});

// ── buildContainerConnections ─────────────────────────────────────────────────
// buildContainerConnections derives edges from compose labels + source scanning.
// Without real compose files on disk, it produces no edges — but must not throw.

test("buildContainerConnections: returns empty array when no containers", () => {
  const result = buildContainerConnections([], []);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test("buildContainerConnections: returns empty array when containers have no compose labels", () => {
  const containers = [
    { id: "c1", name: "api", labels: {}, state: "running" },
    { id: "c2", name: "db", labels: {}, state: "running" },
  ];
  const result = buildContainerConnections(containers, []);
  assert.ok(Array.isArray(result));
  assert.equal(result.length, 0);
});

test("buildContainerConnections: does not throw with malformed labels", () => {
  const containers = [
    {
      id: "c3",
      name: "bad-labels",
      labels: {
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "api",
        "com.docker.compose.project.config_files": "/nonexistent/docker-compose.yml",
      },
      state: "running",
    },
  ];
  assert.doesNotThrow(() => buildContainerConnections(containers, []));
});

test("buildContainerConnections: infers edges from docker-compose depends_on", () => {
  // Write a minimal docker-compose.yml to a temp dir with depends_on syntax
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fere-docker-test-"));
  const composePath = path.join(tmpDir, "docker-compose.yml");
  const composeContent = `
services:
  api:
    image: node:20
    depends_on:
      - db
  db:
    image: postgres:15
`.trimStart();

  fs.writeFileSync(composePath, composeContent);

  const containers = [
    {
      id: "apicontainer12",
      name: "myapp-api-1",
      labels: {
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "api",
        "com.docker.compose.project.config_files": composePath,
      },
      state: "running",
    },
    {
      id: "dbcontainer123",
      name: "myapp-db-1",
      labels: {
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "db",
        "com.docker.compose.project.config_files": composePath,
      },
      state: "running",
    },
  ];

  try {
    const result = buildContainerConnections(containers, []);
    assert.ok(Array.isArray(result));
    assert.ok(result.length > 0, "expected at least one edge from depends_on");
    const edge = result[0];
    assert.ok("sourceContainerId" in edge);
    assert.ok("targetContainerId" in edge);
  } finally {
    fs.unlinkSync(composePath);
    fs.rmdirSync(tmpDir);
  }
});
