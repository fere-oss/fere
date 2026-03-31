/**
 * Sentinel — deterministic runtime detection and typed fix execution
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DEP_PORT_MAP = {
  ioredis: { port: 6379, label: "Redis" },
  redis: { port: 6379, label: "Redis" },
  "redis-om": { port: 6379, label: "Redis" },
  pg: { port: 5432, label: "PostgreSQL" },
  postgres: { port: 5432, label: "PostgreSQL" },
  mongoose: { port: 27017, label: "MongoDB" },
  mongodb: { port: 27017, label: "MongoDB" },
  mysql: { port: 3306, label: "MySQL" },
  mysql2: { port: 3306, label: "MySQL" },
  amqplib: { port: 5672, label: "RabbitMQ" },
  kafkajs: { port: 9092, label: "Kafka" },
  "@elastic/elasticsearch": { port: 9200, label: "Elasticsearch" },
};

// ── Deterministic Scan ────────────────────────────────────────────────────────

async function runScan(snapshot, nodeIds) {
  const allNodes = snapshot.graph?.nodes ?? [];
  const nodes = nodeIds?.length > 0
    ? allNodes.filter((n) => nodeIds.includes(n.id))
    : allNodes;
  const edges = snapshot.graph?.edges ?? [];
  const ports = snapshot.ports ?? [];
  const docker = snapshot.docker ?? null;
  const findings = [];

  findings.push(...detectPortConflicts(ports, nodes));
  findings.push(...detectDownServices(nodes, edges));
  findings.push(...detectCascadeImpact(nodes, edges));
  findings.push(...detectStoppedContainers(docker));
  findings.push(...detectUnhealthyContainers(docker));
  findings.push(...detectRestartingContainers(docker));
  findings.push(...detectDisconnectedServices(nodes, edges));
  findings.push(...(await detectAdvisory(nodes)));
  findings.push(...(await detectEnvMismatches(nodes)));

  // Deduplicate by id
  const seen = new Set();
  return findings.filter((f) => { if (seen.has(f.id)) return false; seen.add(f.id); return true; });
}

function detectPortConflicts(ports, nodes) {
  const findings = [];
  const knownPids = new Set();
  for (const node of nodes) {
    for (const pid of node.pids ?? []) knownPids.add(pid);
    if (node.pid > 0) knownPids.add(node.pid);
  }
  const nodeByPort = new Map();
  for (const node of nodes) {
    for (const p of node.ports ?? []) nodeByPort.set(p.port, node);
  }
  const portGroups = new Map();
  for (const entry of ports) {
    if (!portGroups.has(entry.port)) portGroups.set(entry.port, []);
    portGroups.get(entry.port).push(entry);
  }
  for (const [portNum, entries] of portGroups) {
    const node = nodeByPort.get(portNum);
    if (!node) continue;
    const stale = entries.filter((e) => e.pid > 0 && !knownPids.has(e.pid));
    if (stale.length > 0) {
      const { pid, process: proc = "unknown" } = stale[0];
      findings.push({
        id: `port-conflict-${portNum}`,
        severity: "critical",
        category: "connectivity",
        service: node.name,
        summary: `Port ${portNum} conflict — ${node.name} can't bind`,
        detail: `Port ${portNum} is already held by PID ${pid} (${proc}). ${node.name} cannot bind to this port until the conflicting process is killed. Run \`lsof -i :${portNum}\` to investigate.`,
        impact: `${node.name} will fail to start`,
        affectedServices: [node.name],
        fix: { type: "kill-port", port: portNum, pid, preview: `lsof -ti:${portNum} | xargs kill`, label: `Kill PID ${pid} on port ${portNum}` },
      });
    }
  }
  return findings;
}

function detectDownServices(nodes, edges) {
  const nodeById = new Map(nodes.map((n) => [n.id, n.name]));
  return nodes
    .filter((n) => n.healthStatus === "red" && !(n.pid === -1 && !n.pids?.length) && !n.isContainer && !n.isDockerContainer)
    .map((n) => {
      // Find dependents
      const dependents = edges
        .filter((e) => e.target === n.id)
        .map((e) => nodeById.get(e.source))
        .filter(Boolean);
      return {
        id: `service-down-${n.id}`,
        severity: "critical",
        category: "health",
        service: n.name,
        summary: `${n.name} is not responding`,
        detail: `${n.name} was last seen active but is no longer responding to health checks. The process may have crashed, run out of resources, or been stopped externally. Check logs or restart the service.`,
        impact: dependents.length > 0 ? `${dependents.length} service${dependents.length !== 1 ? "s" : ""} depend on it: ${dependents.join(", ")}` : null,
        affectedServices: dependents,
        fix: null,
      };
    });
}

function detectCascadeImpact(nodes, edges) {
  const findings = [];
  const downNodes = nodes.filter((n) => n.healthStatus === "red");
  const nodeById = new Map(nodes.map((n) => [n.id, n.name]));
  for (const down of downNodes) {
    // Services that call INTO this down service
    const dependents = edges
      .filter((e) => e.target === down.id)
      .map((e) => nodeById.get(e.source))
      .filter(Boolean);
    if (dependents.length < 2) continue; // only show when blast radius is meaningful
    findings.push({
      id: `cascade-${down.id}`,
      severity: "critical",
      category: "connectivity",
      service: down.name,
      summary: `${down.name} outage cascades to ${dependents.length} services`,
      detail: `${dependents.join(", ")} ${dependents.length === 1 ? "has" : "have"} active connections to ${down.name}. Since ${down.name} is down, these services will return errors or time out on any request that reaches it.`,
      impact: `Blast radius: ${dependents.join(", ")}`,
      affectedServices: dependents,
      fix: null,
    });
  }
  return findings;
}

function detectStoppedContainers(docker) {
  if (!docker?.containers) return [];
  return docker.containers
    .filter((c) => c.state === "exited" || c.state === "dead")
    .map((c) => ({
      id: `container-stopped-${c.id.slice(0, 12)}`,
      severity: "warning",
      category: "health",
      service: c.name,
      summary: `${c.name} container stopped`,
      detail: `Container ${c.name} (image: ${c.image}) has exited. This is usually caused by a startup error or an OOM kill. Run \`docker logs ${c.name}\` to find the root cause.`,
      impact: null,
      affectedServices: [],
      fix: { type: "restart-container", containerId: c.id, preview: `docker logs --tail 50 ${c.name}\ndocker start ${c.name}`, label: `Restart ${c.name}` },
    }));
}

function detectUnhealthyContainers(docker) {
  if (!docker?.containers) return [];
  return docker.containers
    .filter((c) => c.state === "running" && c.health?.status === "unhealthy")
    .map((c) => {
      const streak = c.health?.failingStreak ?? 0;
      const lastCheck = c.health?.checks?.[c.health.checks.length - 1];
      const lastOutput = lastCheck?.output?.trim().slice(0, 120);
      return {
        id: `container-unhealthy-${c.id.slice(0, 12)}`,
        severity: "critical",
        category: "health",
        service: c.name,
        summary: `${c.name} health check failing`,
        detail: `Container is running but Docker health checks are failing (${streak} consecutive failure${streak !== 1 ? "s" : ""}).${lastOutput ? ` Last health check output: "${lastOutput}"` : " No output captured — check if the healthcheck command is correct."}`,
        impact: `Container may be accepting traffic but not functioning correctly`,
        affectedServices: [],
        fix: { type: "restart-container", containerId: c.id, preview: `docker inspect --format='{{json .State.Health}}' ${c.name} | jq\ndocker restart ${c.name}`, label: `Restart ${c.name}` },
      };
    });
}

function detectRestartingContainers(docker) {
  if (!docker?.containers) return [];
  return docker.containers
    .filter((c) => c.state === "restarting")
    .map((c) => ({
      id: `container-restarting-${c.id.slice(0, 12)}`,
      severity: "critical",
      category: "health",
      service: c.name,
      summary: `${c.name} is crash-looping`,
      detail: `${c.name} (${c.image}) is in a restart loop — it keeps crashing on startup. This is usually caused by a missing environment variable, misconfigured entrypoint, or dependency that isn't ready yet. Check logs immediately.`,
      impact: `Service is unavailable while crash-looping`,
      affectedServices: [],
      fix: { type: "copy-only", preview: `docker logs --tail 50 ${c.name}`, label: `View crash logs` },
    }));
}

function detectDisconnectedServices(nodes, edges) {
  return nodes
    .filter((n) => {
      if (n.pid === -1 && !n.pids?.length) return false;
      if (n.isContainer || n.isDockerContainer) return false;
      if (n.healthStatus === "red") return false;
      const connected = edges.some((e) => e.source === n.id || e.target === n.id);
      return !connected && nodes.length > 1;
    })
    .map((n) => ({
      id: `disconnected-${n.id}`,
      severity: "warning",
      category: "connectivity",
      service: n.name,
      summary: `${n.name} is isolated — no active connections`,
      detail: `${n.name} is running on ${(n.ports ?? []).map((p) => p.port).join(", ") || "unknown port"} but has no TCP connections to any other service in the topology. This may indicate a misconfigured service URL, firewall rule, or the service hasn't been called yet.`,
      impact: null,
      affectedServices: [],
      fix: null,
    }));
}

async function detectEnvMismatches(nodes) {
  const findings = [];
  const activePorts = new Set(nodes.flatMap((n) => (n.ports ?? []).map((p) => p.port)));
  const projectPaths = new Set(nodes.map((n) => n.projectPath).filter(Boolean));

  const PORT_VARS = [
    { keys: ["DATABASE_URL", "DB_URL", "POSTGRES_URL", "POSTGRESQL_URL", "PG_URI"], port: 5432, label: "PostgreSQL" },
    { keys: ["REDIS_URL", "REDIS_URI", "CACHE_URL"], port: 6379, label: "Redis" },
    { keys: ["MONGODB_URI", "MONGO_URI", "MONGODB_URL", "MONGO_URL"], port: 27017, label: "MongoDB" },
    { keys: ["RABBITMQ_URL", "AMQP_URL", "BROKER_URL"], port: 5672, label: "RabbitMQ" },
    { keys: ["KAFKA_BROKERS", "KAFKA_URL", "KAFKA_BOOTSTRAP_SERVERS"], port: 9092, label: "Kafka" },
    { keys: ["ELASTICSEARCH_URL", "ES_URL"], port: 9200, label: "Elasticsearch" },
  ];

  for (const projectPath of projectPaths) {
    const envFiles = [".env", ".env.local", ".env.development"].map((f) => path.join(projectPath, f)).filter(fs.existsSync);
    for (const envFile of envFiles) {
      let content;
      try { content = fs.readFileSync(envFile, "utf8"); } catch { continue; }
      const vars = {};
      for (const line of content.split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.+)$/);
        if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
      for (const { keys, port, label } of PORT_VARS) {
        for (const key of keys) {
          if (!vars[key]) continue;
          const val = vars[key];
          // Extract port from URL like postgresql://host:5433/db or host:5433
          const portMatch = val.match(/:(\d{2,5})(?:\/|$)/);
          const usedPort = portMatch ? parseInt(portMatch[1], 10) : port;
          if (!activePorts.has(usedPort)) {
            const owner = nodes.find((n) => n.projectPath === projectPath);
            const id = `env-mismatch-${key}-${path.basename(projectPath)}`;
            if (!findings.some((f) => f.id === id)) {
              findings.push({
                id,
                severity: "warning",
                category: "config",
                service: owner?.name ?? path.basename(projectPath),
                summary: `${key} points to port ${usedPort} — nothing listening`,
                detail: `${path.basename(envFile)} sets ${key}=${val.slice(0, 80)} but no process is bound to port ${usedPort}. ${label} is likely not running. This will cause connection errors at runtime.`,
                impact: `Runtime connection failures for ${label}`,
                affectedServices: [],
                fix: { type: "copy-only", preview: `docker run -d -p ${usedPort}:${usedPort} ${label.toLowerCase()}:latest`, label: `Start ${label}` },
              });
            }
          }
        }
      }
    }
  }
  return findings;
}

async function detectAdvisory(nodes) {
  const findings = [];
  const projectPaths = new Set(nodes.map((n) => n.projectPath).filter(Boolean));
  const activePorts = new Set(nodes.flatMap((n) => (n.ports ?? []).map((p) => p.port)));

  for (const projectPath of projectPaths) {
    const pkgPath = path.join(projectPath, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    let pkg;
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")); } catch { continue; }
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [dep, mapping] of Object.entries(DEP_PORT_MAP)) {
      if (!mapping || !allDeps[dep] || activePorts.has(mapping.port)) continue;
      const id = `dep-missing-${mapping.port}`;
      if (findings.some((f) => f.id === id)) continue;
      const owner = nodes.find((n) => n.projectPath === projectPath);
      findings.push({
        id,
        severity: "suggestion",
        category: "dependency",
        service: owner?.name ?? path.basename(projectPath),
        summary: `${mapping.label} dependency not running`,
        detail: `package.json includes "${dep}" but no process is listening on port ${mapping.port} (${mapping.label}'s default port). Calls to ${mapping.label} will fail until it's started.`,
        impact: `${dep} calls will throw connection errors`,
        affectedServices: [],
        fix: { type: "copy-only", preview: `docker run -d -p ${mapping.port}:${mapping.port} ${mapping.label.toLowerCase()}`, label: `Start ${mapping.label}` },
      });
    }

    const composePath = findComposePath(projectPath);
    if (composePath) findings.push(...checkHealthChecks(composePath));
  }
  return findings;
}

function findComposePath(startPath) {
  const names = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
  let dir = startPath;
  for (let i = 0; i < 4; i++) {
    for (const name of names) {
      const p = path.join(dir, name);
      if (fs.existsSync(p)) return p;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function checkHealthChecks(composePath) {
  let content;
  try { content = fs.readFileSync(composePath, "utf8"); } catch { return []; }
  const serviceNames = [];
  for (const m of content.matchAll(/^  (\w[\w-]+):\s*$/gm)) serviceNames.push(m[1]);
  const missing = serviceNames.filter((name) => {
    const idx = content.indexOf(`  ${name}:`);
    if (idx === -1) return false;
    const next = content.slice(idx + name.length + 3).search(/^  \w[\w-]+:/m);
    const block = next === -1 ? content.slice(idx) : content.slice(idx, idx + name.length + 3 + next);
    return !block.includes("healthcheck:");
  });
  if (!missing.length) return [];
  const id = `compose-missing-healthcheck-${path.basename(path.dirname(composePath))}`;
  return [{
    id,
    severity: "suggestion",
    category: "config",
    service: path.basename(path.dirname(composePath)),
    summary: `${missing.length} container${missing.length !== 1 ? "s" : ""} missing Docker health checks`,
    detail: `${missing.join(", ")} ${missing.length === 1 ? "has" : "have"} no healthcheck in docker-compose.yml. Without health checks, Docker can't detect when a container starts but isn't ready, and dependent services may connect too early.`,
    impact: `Dependent services may connect before ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} ready`,
    affectedServices: [],
    fix: { type: "copy-only", preview: `healthcheck:\n  test: ["CMD", "curl", "-f", "http://localhost:PORT/health"]\n  interval: 10s\n  timeout: 5s\n  retries: 3\n  start_period: 20s`, label: "Copy healthcheck template" },
  }];
}

// ── Apply Fix ─────────────────────────────────────────────────────────────────

async function executeAction(action) {
  if (action.type === "kill-port") {
    const { port, pid } = action;
    if (!Number.isInteger(port) || !Number.isInteger(pid) || pid <= 0) throw new Error("Invalid kill-port payload");
    try { execSync(`kill ${pid}`, { timeout: 5000 }); } catch {}
    return { success: true };
  }
  if (action.type === "restart-container") {
    const { containerId } = action;
    if (typeof containerId !== "string" || containerId.length < 4) throw new Error("Invalid restart-container payload");
    execSync(`docker start ${containerId.slice(0, 64)}`, { timeout: 15000 });
    return { success: true };
  }
  if (action.type === "write-file") {
    const { filePath, content } = action;
    if (typeof filePath !== "string" || !filePath.startsWith("/")) throw new Error("Invalid filePath");
    if (!filePath.startsWith("/Users/") && !filePath.startsWith("/home/")) throw new Error("Access denied");
    if (typeof content !== "string") throw new Error("Invalid content");
    const fs = require("fs");
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf8");
    return { success: true };
  }
  throw new Error(`Unknown action type: ${action.type}`);
}

// ── Chat Context Builder ───────────────────────────────────────────────────────

async function readCodebaseContext(nodes) {
  const projectPaths = [
    ...new Set(
      nodes
        .filter((n) => n.type !== "external" && typeof n.projectPath === "string" && n.projectPath)
        .map((n) => n.projectPath),
    ),
  ].slice(0, 4);

  if (projectPaths.length === 0) return "";

  const lines = ["\n## Codebase Context"];
  for (const projectPath of projectPaths) {
    try {
      const name = path.basename(projectPath);
      lines.push(`\n### ${name} (${projectPath})`);

      // Top-level directory
      try {
        const entries = fs
          .readdirSync(projectPath)
          .filter((e) => !e.startsWith(".") && e !== "node_modules" && e !== "__pycache__")
          .slice(0, 24);
        lines.push(`  Structure: ${entries.join(", ")}`);
      } catch (_) {}

      // package.json
      const pkgPath = path.join(projectPath, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
          if (pkg.name) lines.push(`  Package: ${pkg.name}${pkg.version ? ` v${pkg.version}` : ""}`);
          if (pkg.description) lines.push(`  Description: ${pkg.description}`);
          const deps = Object.keys({ ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }).slice(0, 20);
          if (deps.length) lines.push(`  Dependencies: ${deps.join(", ")}`);
          const scripts = Object.keys(pkg.scripts ?? {}).slice(0, 10);
          if (scripts.length) lines.push(`  Scripts: ${scripts.join(", ")}`);
        } catch (_) {}
      }

      // requirements.txt (Python)
      const reqPath = path.join(projectPath, "requirements.txt");
      if (fs.existsSync(reqPath)) {
        try {
          const reqs = fs.readFileSync(reqPath, "utf8").split("\n")
            .map((l) => l.trim().split(/[>=<!]/)[0])
            .filter(Boolean)
            .slice(0, 16);
          if (reqs.length) lines.push(`  Python deps: ${reqs.join(", ")}`);
        } catch (_) {}
      }

      // docker-compose
      const composePath = ["docker-compose.yml", "docker-compose.yaml"]
        .map((f) => path.join(projectPath, f))
        .find((p) => fs.existsSync(p));
      if (composePath) {
        try {
          const raw = fs.readFileSync(composePath, "utf8");
          const services = [...raw.matchAll(/^\s{2}([\w-]+):\s*$/gm)]
            .map((m) => m[1])
            .filter((s) => s !== "services" && s !== "networks" && s !== "volumes");
          if (services.length) lines.push(`  Compose services: ${services.join(", ")}`);
        } catch (_) {}
      }

      // .env keys (not values — privacy)
      const envPath = path.join(projectPath, ".env");
      if (fs.existsSync(envPath)) {
        try {
          const keys = fs.readFileSync(envPath, "utf8")
            .split("\n")
            .map((l) => l.split("=")[0].trim())
            .filter((k) => /^[A-Z_][A-Z0-9_]*$/.test(k))
            .slice(0, 20);
          if (keys.length) lines.push(`  .env keys: ${keys.join(", ")}`);
        } catch (_) {}
      }
    } catch (_) {}
  }

  return lines.join("\n");
}

async function buildChatContext(snapshot, findings, tabLabel = null) {
  const nodes = snapshot.graph?.nodes ?? [];
  const edges = snapshot.graph?.edges ?? [];
  const ports = snapshot.ports ?? [];
  const containers = snapshot.docker?.containers ?? [];

  const serviceLines = nodes
    .filter((n) => n.type !== "external")
    .map((n) => {
      const portList = (n.ports ?? []).map((p) => p.port).join(", ") || "none";
      const pid =
        n.pid > 0
          ? `PID ${n.pid}`
          : n.pids?.length
            ? `PIDs ${n.pids.join(",")}`
            : "no PID";
      const health = n.healthStatus ?? "unknown";
      const cpu = n.cpu != null ? ` | cpu: ${n.cpu.toFixed(1)}%` : "";
      const mem = n.memoryUsage ? ` | mem: ${n.memoryUsage}` : n.memory != null ? ` | mem: ${n.memory.toFixed(1)}MB` : "";
      const typeTag = n.type ? ` | type: ${n.type}` : "";
      const cmd = n.command ? ` | cmd: ${n.command.slice(0, 80)}` : "";
      const projectTag = n.projectPath ? ` | path: ${n.projectPath}` : "";

      let containerTag = "";
      if (n.isDockerContainer) {
        const hStatus = n.containerHealth?.status ?? "no healthcheck";
        const image = n.containerImage ? ` image: ${n.containerImage}` : "";
        const nets = (n.containerNetworks ?? []).map((net) => net.name).join(", ");
        containerTag = ` | container: ${n.containerState ?? "unknown"} | health: ${hStatus}${image}${nets ? ` | networks: ${nets}` : ""}`;
      }

      const routes = (n.routes ?? []).slice(0, 8);
      const routeTag = routes.length
        ? `\n      routes: ${routes.map((r) => `${r.method} ${r.path}`).join(", ")}`
        : "";

      const apis = (n.externalApis ?? []).slice(0, 6);
      const apiTag = apis.length
        ? `\n      external APIs: ${apis.map((a) => a.name).join(", ")}`
        : "";

      return `  - ${n.name}${typeTag} | port(s): ${portList} | ${pid} | health: ${health}${cpu}${mem}${cmd}${projectTag}${containerTag}${routeTag}${apiTag}`;
    })
    .join("\n");

  const externalNodes = nodes.filter((n) => n.type === "external");
  const externalLines = externalNodes.length
    ? externalNodes.map((n) => `  - ${n.name}`).join("\n")
    : "  (none)";

  const edgeLines = edges.length
    ? edges
        .map((e) => {
          const src = nodes.find((n) => n.id === e.source)?.name ?? e.source;
          const tgt = nodes.find((n) => n.id === e.target)?.name ?? e.target;
          return `  - ${src} → ${tgt}`;
        })
        .join("\n")
    : "  (no active connections)";

  const containerLines = containers.length
    ? containers
        .map((c) => {
          const restarts = c.restartCount != null ? ` | restarts: ${c.restartCount}` : "";
          const image = c.image ? ` | image: ${c.image}` : "";
          const hStatus = c.health?.status ?? "no healthcheck";
          const mappedPorts = (c.ports ?? [])
            .filter((p) => p.hostPort)
            .map((p) => `${p.hostPort}→${p.containerPort}`)
            .join(", ");
          const portTag = mappedPorts ? ` | ports: ${mappedPorts}` : "";
          const nets = Object.keys(c.networks ?? {}).join(", ");
          const netTag = nets ? ` | networks: ${nets}` : "";
          return `  - ${c.name}${image} | state: ${c.state} | health: ${hStatus}${portTag}${netTag}${restarts}`;
        })
        .join("\n")
    : "  (no containers)";

  const listeningPortLines = ports.length
    ? ports
        .map((p) => `  - :${p.port} → PID ${p.pid} (${p.process ?? "unknown"})`)
        .slice(0, 30)
        .join("\n")
    : "  (none)";

  const findingLines = findings.length
    ? findings
        .map((f) => `  - [${f.severity.toUpperCase()}] ${f.service}: ${f.summary}`)
        .join("\n")
    : "  (no issues detected)";

  const codebaseContext = await readCodebaseContext(nodes);

  const scopeLine = tabLabel
    ? `The user is currently viewing the **${tabLabel}** project tab. All services, connections, and findings listed below are scoped to that project only. Do not reference or assume the existence of services from other projects.`
    : `The user is viewing the system-wide tab showing all running services.`;

  return `You are Fere's built-in runtime intelligence for a local development environment. You have real-time visibility into what is actually running on this machine — something no IDE assistant or code editor can see.

${scopeLine}

Snapshot captured at: ${new Date().toISOString()}

## Services Running
${serviceLines || "  (none running)"}

## External Services Detected
${externalLines}

## Service Topology (active TCP connections)
${edgeLines}

## Docker Containers
${containerLines}

## All Listening Ports
${listeningPortLines}

## Issues Detected (deterministic scan)
${findingLines}
${codebaseContext}

---

Rules:
- Ground every answer in the live data above. Reference actual service names, ports, PIDs, health states, and connection graphs.
- When asked about blast radius or dependencies, trace the edges in the topology.
- When asked why something isn't working, cross-reference health status, connections, and port ownership.
- Format responses with Markdown: use **bold** for service names and key terms, \`code\` for ports/PIDs/commands, bullet lists for multi-item answers.
- Keep answers focused and actionable. Lead with the direct answer, then explain.
- You have a \`get_node_details\` tool. Use it whenever the user asks about a specific service to get full details: all routes, external API calls, Docker image/networks/mounts, health check output, CPU/memory, inbound/outbound connections, and more.
- You have a \`read_file\` tool. Use it proactively when the user asks about code logic, bugs, or implementation details. Use \`list_directory\` first if unsure of the path.
- You have \`run_command\` for short diagnostic commands (e.g. \`npm test\`, \`python -c\`, \`cat error.log\`). NEVER use it for long-running servers.
- You have \`launch_in_terminal\` for starting dev servers and long-running processes (uvicorn, npm run dev, next dev, flask run, nodemon, etc.). This opens macOS Terminal and runs the command there so the user can see its output. Always use this when the user asks you to start or run a service.
- You have \`docker_logs\`, \`docker_exec\`, and \`docker_control\` to read container output, run commands inside containers, and start/stop/restart them.
- Do not tell the user to run commands manually when a tool can run it. Use the tools first and return the output.
- Do not claim generic sandbox/restriction limitations. If a tool returns an error, quote that exact error and then propose a next step.
- Do not start long-running dev servers (for example \`npm start\`, \`next dev\`, \`vite\`) unless the user explicitly asks you to launch one.
- If the data doesn't contain enough information to answer, say so clearly rather than guessing.`;
}

function buildNodeDetails(node, allNodes, edges) {
  if (!node) return "Node not found.";
  const lines = [];
  lines.push(`# ${node.name}`);
  lines.push(`Type: ${node.type ?? "unknown"}`);
  lines.push(`Health: ${node.healthStatus ?? "unknown"}`);
  if (node.pid > 0) lines.push(`PID: ${node.pid}`);
  if (node.pids?.length) lines.push(`PIDs: ${node.pids.join(", ")}`);
  if (node.command) lines.push(`Command: ${node.command}`);
  if (node.user) lines.push(`User: ${node.user}`);
  if (node.cpu != null) lines.push(`CPU: ${node.cpu.toFixed(2)}%`);
  if (node.memoryUsage) lines.push(`Memory: ${node.memoryUsage}`);
  else if (node.memory != null) lines.push(`Memory: ${node.memory.toFixed(1)} MB`);
  if (node.projectPath) lines.push(`Project path: ${node.projectPath}`);
  if (node.repoPath) lines.push(`Repo path: ${node.repoPath}`);
  if (node.description) lines.push(`Description: ${node.description}`);

  const ports = node.ports ?? [];
  if (ports.length) lines.push(`Ports: ${ports.map((p) => `:${p.port}${p.description ? ` (${p.description})` : ""}`).join(", ")}`);

  const routes = node.routes ?? [];
  if (routes.length) {
    lines.push(`\nAPI Routes (${routes.length}):`);
    for (const r of routes) lines.push(`  ${r.method} ${r.path}${r.framework ? ` [${r.framework}]` : ""}`);
  }

  const apis = node.externalApis ?? [];
  if (apis.length) {
    lines.push(`\nExternal APIs used (${apis.length}):`);
    for (const a of apis) lines.push(`  ${a.name} (matched: ${(a.matchedOn ?? []).join(", ")})`);
  }

  if (node.isDockerContainer) {
    lines.push(`\nDocker:`);
    if (node.containerImage) lines.push(`  Image: ${node.containerImage}`);
    if (node.containerId) lines.push(`  Container ID: ${node.containerId}`);
    if (node.containerState) lines.push(`  State: ${node.containerState}`);
    if (node.containerStatus) lines.push(`  Status: ${node.containerStatus}`);
    const h = node.containerHealth;
    if (h) {
      lines.push(`  Health: ${h.status}${h.failingStreak ? ` (${h.failingStreak} failures)` : ""}`);
      const last = h.checks?.[h.checks.length - 1];
      if (last?.output) lines.push(`  Last health output: ${last.output.slice(0, 200)}`);
    }
    const nets = node.containerNetworks ?? [];
    if (nets.length) lines.push(`  Networks: ${nets.map((n) => `${n.name} (${n.ipAddress})`).join(", ")}`);
    const mounts = node.containerMounts ?? [];
    if (mounts.length) lines.push(`  Mounts: ${mounts.map((m) => `${m.source}→${m.destination}`).join(", ")}`);
    const cPorts = node.containerPorts ?? [];
    if (cPorts.length) lines.push(`  Mapped ports: ${cPorts.filter((p) => p.hostPort).map((p) => `${p.hostPort}→${p.containerPort}`).join(", ")}`);
  }

  // Connections
  const outbound = edges.filter((e) => e.source === node.id);
  const inbound = edges.filter((e) => e.target === node.id);
  if (inbound.length) {
    lines.push(`\nInbound connections from: ${inbound.map((e) => allNodes.find((n) => n.id === e.source)?.name ?? e.source).join(", ")}`);
  }
  if (outbound.length) {
    lines.push(`Outbound connections to: ${outbound.map((e) => allNodes.find((n) => n.id === e.target)?.name ?? e.target).join(", ")}`);
  }

  return lines.join("\n");
}

module.exports = { runScan, executeAction, buildChatContext, readCodebaseContext, buildNodeDetails };
