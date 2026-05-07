const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildConnectionGraph,
  categorizeProcess,
  inferProjectPathFromCommand,
} = require("./connectionGraph");

function makeTempDir() {
  return fs.mkdtempSync(path.join(process.cwd(), "tmp-graph-"));
}

test("buildConnectionGraph maps connections to internal and external nodes", async () => {
  const snapshot = {
    processes: [
      {
        pid: 100,
        name: "node",
        command: "node server.js",
        cpu: 1,
        memory: 1,
        user: "me",
        tty: "ttys001",
      },
      {
        pid: 200,
        name: "python",
        command: "python server.py",
        cpu: 1,
        memory: 1,
        user: "me",
        tty: "ttys002",
      },
    ],
    ports: [
      { port: 3001, host: "127.0.0.1", pid: 100, process: "node", user: "me", protocol: "tcp" },
      { port: 5001, host: "127.0.0.1", pid: 200, process: "python", user: "me", protocol: "tcp" },
    ],
    connections: [
      {
        pid: 100,
        process: "node",
        user: "me",
        localHost: "127.0.0.1",
        localPort: 60000,
        remoteHost: "127.0.0.1",
        remotePort: 5001,
        protocol: "tcp",
      },
      {
        pid: 100,
        process: "node",
        user: "me",
        localHost: "127.0.0.1",
        localPort: 60001,
        remoteHost: "example.com",
        remotePort: 443,
        protocol: "tcp",
      },
    ],
  };

  const { nodes, edges } = await buildConnectionGraph(snapshot);
  const nodeIds = new Set(nodes.map((n) => n.id));

  assert.ok(nodeIds.has("proc-100"));
  assert.ok(nodeIds.has("proc-200"));
  assert.ok(Array.from(nodeIds).some((id) => id.startsWith("external-")));
  const proc100Edges = edges.filter((e) => e.source === "proc-100");
  assert.equal(proc100Edges.length, 2);

  const internalEdge = edges.find((e) => e.target === "proc-200");
  assert.ok(internalEdge);
  assert.equal(internalEdge.source, "proc-100");
  assert.equal(internalEdge.targetPort, 5001);
});

test("buildConnectionGraph tags SSH/SFTP style remote connections", async () => {
  const snapshot = {
    processes: [
      {
        pid: 300,
        name: "ssh",
        command: "ssh dev@10.0.0.42",
        cpu: 1,
        memory: 1,
        user: "me",
        tty: "ttys010",
      },
      {
        pid: 301,
        name: "sftp",
        command: "sftp dev@10.0.0.43",
        cpu: 1,
        memory: 1,
        user: "me",
        tty: "ttys011",
      },
    ],
    ports: [
      { port: 61000, host: "127.0.0.1", pid: 300, process: "ssh", user: "me", protocol: "tcp" },
      { port: 61001, host: "127.0.0.1", pid: 301, process: "sftp", user: "me", protocol: "tcp" },
    ],
    connections: [
      {
        pid: 300,
        process: "ssh",
        user: "me",
        localHost: "127.0.0.1",
        localPort: 61000,
        remoteHost: "example.com",
        remotePort: 22,
        protocol: "tcp",
      },
      {
        pid: 301,
        process: "sftp",
        user: "me",
        localHost: "127.0.0.1",
        localPort: 61001,
        remoteHost: "files.example.com",
        remotePort: 22,
        protocol: "tcp",
      },
    ],
  };

  const { edges } = await buildConnectionGraph(snapshot);
  assert.equal(edges.length, 2);
  assert.ok(edges.some((edge) => edge.source === "proc-300" && edge.protocol === "ssh"));
  assert.ok(edges.some((edge) => edge.source === "proc-301" && edge.protocol === "sftp"));
});

test("buildConnectionGraph keeps SSH edge when ps snapshot misses process row", async () => {
  const snapshot = {
    processes: [],
    ports: [],
    connections: [
      {
        pid: 999,
        process: "ssh",
        user: "me",
        localHost: "127.0.0.1",
        localPort: 61234,
        remoteHost: "example.com",
        remotePort: 22,
        protocol: "tcp",
      },
    ],
  };

  const { nodes, edges } = await buildConnectionGraph(snapshot);
  assert.ok(nodes.some((node) => node.id === "proc-999"));
  assert.ok(edges.some((edge) => edge.source === "proc-999" && edge.protocol === "ssh"));
});

test("buildConnectionGraph synthesizes SSH remote edge from command when lsof data is missing", async () => {
  const snapshot = {
    processes: [
      {
        pid: 777,
        name: "ssh",
        command: "ssh dev@example.com",
        cpu: 0.1,
        memory: 0.1,
        user: "me",
        tty: "ttys001",
      },
    ],
    ports: [],
    connections: [],
  };

  const { nodes, edges } = await buildConnectionGraph(snapshot);
  assert.ok(nodes.some((node) => node.id === "proc-777"));
  assert.ok(nodes.some((node) => node.id === "external-example.com:22"));
  assert.ok(edges.some((edge) => edge.source === "proc-777" && edge.protocol === "ssh"));
});

test("buildConnectionGraph parses ssh tunnel flags into remoteAccess metadata", async () => {
  const snapshot = {
    processes: [
      {
        pid: 778,
        name: "ssh",
        command: "ssh -L 5433:db.internal:5432 -D 1080 dev@example.com",
        cpu: 0.1,
        memory: 0.1,
        user: "me",
        tty: "ttys002",
      },
    ],
    ports: [],
    connections: [],
  };

  const { nodes } = await buildConnectionGraph(snapshot);
  const sshNode = nodes.find((node) => node.id === "proc-778");
  assert.ok(sshNode);
  assert.ok(sshNode.remoteAccess);
  assert.equal(sshNode.remoteAccess.host, "example.com");
  assert.equal(sshNode.remoteAccess.tunnels.length, 2);
  assert.ok(
    sshNode.remoteAccess.tunnels.some(
      (t) =>
        t.mode === "L" &&
        t.listenPort === 5433 &&
        t.targetHost === "db.internal" &&
        t.targetPort === 5432,
    ),
  );
  assert.ok(sshNode.remoteAccess.tunnels.some((t) => t.mode === "D" && t.listenPort === 1080));
});

test("buildConnectionGraph aggregates inbound sshd session stats", async () => {
  const snapshot = {
    processes: [
      {
        pid: 880,
        name: "sshd",
        command: "/usr/sbin/sshd -D",
        cpu: 0.2,
        memory: 0.2,
        user: "root",
        tty: null,
      },
    ],
    ports: [],
    connections: [
      {
        pid: 880,
        process: "sshd",
        user: "root",
        localHost: "0.0.0.0",
        localPort: 22,
        remoteHost: "203.0.113.12",
        remotePort: 55221,
        protocol: "tcp",
      },
      {
        pid: 880,
        process: "sshd",
        user: "root",
        localHost: "0.0.0.0",
        localPort: 22,
        remoteHost: "198.51.100.44",
        remotePort: 52111,
        protocol: "tcp",
      },
    ],
  };

  const { nodes } = await buildConnectionGraph(snapshot);
  const sshdNode = nodes.find((node) => node.id === "proc-880");
  assert.ok(sshdNode);
  assert.ok(sshdNode.remoteAccess);
  assert.equal(sshdNode.remoteAccess.inboundSessions, 2);
  assert.ok(sshdNode.remoteAccess.inboundClients.includes("198.51.100.44"));
  assert.ok(sshdNode.remoteAccess.inboundClients.includes("203.0.113.12"));
});

test("buildConnectionGraph marks missing connection and duplicate remote sessions", async () => {
  const snapshot = {
    processes: [
      {
        pid: 990,
        name: "ssh",
        command: "ssh dev@example.com",
        cpu: 0,
        memory: 0.1,
        user: "me",
        tty: "ttys010",
      },
      {
        pid: 991,
        name: "ssh",
        command: "ssh dev@example.com",
        cpu: 0,
        memory: 0.1,
        user: "me",
        tty: "ttys011",
      },
    ],
    ports: [],
    connections: [],
  };

  const { nodes } = await buildConnectionGraph(snapshot);
  const first = nodes.find((node) => node.id === "proc-990");
  const second = nodes.find((node) => node.id === "proc-991");
  assert.ok(first?.remoteAccess?.healthFlags);
  assert.ok(second?.remoteAccess?.healthFlags);
  assert.equal(first.remoteAccess.healthFlags.missingConnection, true);
  assert.equal(second.remoteAccess.healthFlags.missingConnection, true);
  assert.equal(first.remoteAccess.healthFlags.duplicateSessions, 1);
  assert.equal(second.remoteAccess.healthFlags.duplicateSessions, 1);
  assert.ok(first.remoteAccess.healthFlags.notes.includes("no active socket"));
});

test("categorizeProcess detects common service types", () => {
  assert.equal(categorizeProcess("postgres", "postgres"), "database");
  assert.equal(categorizeProcess("redis", "redis"), "cache");
  assert.equal(categorizeProcess("nginx", "nginx"), "webserver");
  assert.equal(categorizeProcess("node", "vite dev"), "frontend");
  assert.equal(categorizeProcess("python", "uvicorn app:app"), "backend");
  assert.equal(categorizeProcess("ssh", "ssh user@example.com"), "client");
  assert.equal(categorizeProcess("sftp", "sftp user@example.com"), "client");
  assert.equal(categorizeProcess("sshd", "/usr/sbin/sshd -D"), "service");
});

test("categorizeProcess detects framework backends", () => {
  assert.equal(categorizeProcess("go", "go run main.go"), "backend");
  assert.equal(categorizeProcess("ruby", "rails server"), "backend");
  assert.equal(categorizeProcess("ruby", "puma -C config/puma.rb"), "backend");
  assert.equal(categorizeProcess("java", "java -jar spring-app.jar"), "backend");
  assert.equal(categorizeProcess("php", "php artisan serve"), "backend");
});

test("categorizeProcess detects infrastructure services", () => {
  // Message brokers
  assert.equal(categorizeProcess("rabbitmq", "rabbitmq-server"), "broker");
  assert.equal(categorizeProcess("kafka", "kafka-server-start"), "broker");
  assert.equal(categorizeProcess("zookeeper", "zookeeper"), "broker");
  assert.equal(categorizeProcess("activemq", "activemq start"), "broker");

  // Caching
  assert.equal(categorizeProcess("memcached", "memcached -m 64"), "cache");

  // Search engines
  assert.equal(categorizeProcess("elasticsearch", "elasticsearch"), "database");
  assert.equal(categorizeProcess("opensearch", "opensearch"), "database");
  assert.equal(categorizeProcess("meilisearch", "meilisearch"), "database");
  assert.equal(categorizeProcess("solr", "solr start"), "database");

  // Workers
  assert.equal(categorizeProcess("python", "celery -A app worker"), "worker");
  assert.equal(categorizeProcess("ruby", "sidekiq"), "worker");

  // Proxy / load balancer
  assert.equal(categorizeProcess("traefik", "traefik"), "webserver");
  assert.equal(categorizeProcess("haproxy", "haproxy"), "webserver");
  assert.equal(categorizeProcess("envoy", "envoy"), "webserver");
});

test("inferProjectPathFromCommand prefers git root", () => {
  const root = makeTempDir();
  const nested = path.join(root, "src", "server");
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(nested, { recursive: true });

  try {
    const serverPath = path.join(nested, "server.js");
    fs.writeFileSync(serverPath, 'console.log("ok");');
    const cmd = `node ${serverPath}`;
    const projectPath = inferProjectPathFromCommand(cmd);
    assert.equal(projectPath, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inferProjectPathFromCommand falls back to marker files", () => {
  // inferProjectPathFromCommand only considers paths starting with /Users/
  // or /home/, so the temp dir must live under one of those prefixes.
  // Try os.homedir() first (works locally), fall back to os.tmpdir() if not
  // writable (sandbox/CI), and skip if neither provides a recognized prefix.
  let base;
  try {
    base = fs.mkdtempSync(path.join(os.homedir(), "tmp-graph-"));
  } catch {
    const tmp = os.tmpdir();
    if (!tmp.startsWith("/Users/") && !tmp.startsWith("/home/")) {
      return; // skip: no writable path under a recognized prefix
    }
    base = fs.mkdtempSync(path.join(tmp, "tmp-graph-"));
  }

  const nested = path.join(base, "api");
  fs.mkdirSync(nested, { recursive: true });
  fs.writeFileSync(path.join(base, "package.json"), "{}");

  try {
    const serverPath = path.join(nested, "server.js");
    fs.writeFileSync(serverPath, 'console.log("ok");');
    const cmd = `node ${serverPath}`;
    const projectPath = inferProjectPathFromCommand(cmd);
    // Should find the real project root, never collapse to $HOME
    // even if ~/.git exists (e.g. for dotfile management)
    assert.equal(projectPath, base);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
