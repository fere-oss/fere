const https = require("https");
const path = require("path");

const MODEL = "gpt-4.1";
const MAX_TOKENS_QUERY = 900;
const MAX_PROMPT_SERVICES = 16;
const MAX_PROMPT_CONNECTIONS = 22;
const MAX_PROMPT_EXTERNALS = 12;
const MAX_PROMPT_ROUTES = 16;
const MAX_PROMPT_PROJECTS = 10;
const GENERIC_SERVICE_TOKENS = new Set([
  "service",
  "services",
  "server",
  "container",
  "containers",
  "app",
  "dev",
  "local",
  "test",
]);

function normalizeLookupValue(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^`+|`+$/g, "")
    .replace(/^@+/, "")
    .replace(/^[([{"']+|[)\]}",.!?:;'"]+$/g, "");
}

function buildNodeAliases(node) {
  const aliases = new Set();
  const addAlias = (value) => {
    const normalized = normalizeLookupValue(value);
    if (!normalized) return;
    aliases.add(normalized);
  };

  addAlias(node.name);
  addAlias(node.project);

  const name = normalizeLookupValue(node.name);
  const parts = name.split(/[^a-z0-9]+/).filter(Boolean);
  for (const part of parts) {
    if (!GENERIC_SERVICE_TOKENS.has(part)) addAlias(part);
  }

  if (parts.length > 1) {
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join("-");
      if (suffix && !GENERIC_SERVICE_TOKENS.has(suffix)) addAlias(suffix);
    }
  }

  const typeAliases = {
    frontend: ["frontend", "ui", "web"],
    backend: ["backend", "api"],
    webserver: ["webserver", "gateway", "proxy"],
    database: ["database", "db"],
    cache: ["cache", "redis"],
    broker: ["broker", "queue", "messaging"],
    worker: ["worker", "job"],
  };
  for (const alias of typeAliases[node.type] || []) addAlias(alias);

  const commandTokens = normalizeLookupValue(node.command)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const token of commandTokens.slice(0, 12)) {
    if (!GENERIC_SERVICE_TOKENS.has(token) && token.length > 2) addAlias(token);
  }

  return aliases;
}

function resolveFocusedServiceIds(graphSnapshot, inputText) {
  const text = normalizeLookupValue(inputText);
  const serviceIds = new Set();
  if (!text) return serviceIds;

  const searchTokens = text.split(/[^a-z0-9/:-]+/).filter(Boolean);
  for (const node of graphSnapshot.nodes || []) {
    if (node.type === "external" || !node.name) continue;
    const aliases = buildNodeAliases(node);
    const hasDirectMatch = Array.from(aliases).some(
      (alias) => text.includes(`@${alias}`) || text.includes(alias),
    );
    const hasTokenMatch = searchTokens.some((token) => aliases.has(token));
    if (hasDirectMatch || hasTokenMatch) {
      serviceIds.add(node.id);
    }
  }
  return serviceIds;
}

function summarizePromptList(items, maxItems, formatter) {
  const visible = items.slice(0, maxItems).map(formatter);
  const omitted = items.length - visible.length;
  if (omitted > 0) {
    visible.push(`- ... ${omitted} more omitted for brevity`);
  }
  return visible.join("\n");
}

function extractFocusTerms(graphSnapshot, inputText) {
  const text = String(inputText || "").toLowerCase();
  if (!text) {
    return {
      serviceIds: new Set(),
      ports: new Set(),
      routeTerms: new Set(),
      projectTerms: new Set(),
    };
  }

  const serviceIds = new Set();
  const ports = new Set();
  const routeTerms = new Set();
  const projectTerms = new Set();

  for (const id of resolveFocusedServiceIds(graphSnapshot, text)) {
    serviceIds.add(id);
  }

  for (const node of graphSnapshot.nodes || []) {
    if (node.type === "external" || !node.name) continue;
    const projectBits = [
      node.project,
      node.projectPath ? path.basename(node.projectPath) : null,
      node.repoPath ? path.basename(node.repoPath) : null,
    ]
      .filter(Boolean)
      .map((value) => String(value).toLowerCase());
    for (const bit of projectBits) {
      if (text.includes(bit)) projectTerms.add(bit);
    }
  }

  const portMatches = text.match(/\b\d{2,5}\b/g) || [];
  for (const token of portMatches) {
    const port = Number(token);
    if (port > 0) ports.add(port);
  }

  for (const node of graphSnapshot.nodes || []) {
    if ((node.ports || []).some((entry) => ports.has(entry.port))) {
      serviceIds.add(node.id);
    }
  }

  const routeMatches = text.match(/\/[a-z0-9\-_/.:]*/gi) || [];
  for (const route of routeMatches) {
    if (route.length > 1) routeTerms.add(route.toLowerCase());
  }

  return { serviceIds, ports, routeTerms, projectTerms };
}

function formatResourceState(node) {
  const cpu = Number(node.cpu || 0);
  const memory = Number(node.memory || 0);
  return `cpu ${cpu.toFixed(1)}%, memory ${memory.toFixed(1)}%`;
}

function getProjectLabel(node) {
  const parts = [];
  if (node.project) parts.push(`project: ${node.project}`);
  else if (node.projectPath) parts.push(`project: ${path.basename(node.projectPath)}`);
  if (node.repoPath && (!node.projectPath || node.repoPath !== node.projectPath)) {
    parts.push(`repo: ${path.basename(node.repoPath)}`);
  }
  return parts.join(", ");
}

function buildOptimizationSignals(nodes) {
  const signals = [];
  const duplicateBuckets = new Map();

  for (const node of nodes) {
    if (node.type === "external") continue;

    const memory = Number(node.memory || 0);
    const cpu = Number(node.cpu || 0);
    const health = node.healthStatus || "unknown";
    const projectLabel =
      node.project ||
      (node.projectPath ? path.basename(node.projectPath) : null) ||
      (node.repoPath ? path.basename(node.repoPath) : null);

    if (health === "yellow" && memory >= 5) {
      signals.push({
        priority: 4 + memory,
        serviceName: node.name,
        text: `${node.name} is idle but using ${memory.toFixed(1)}% memory${
          projectLabel ? ` in ${projectLabel}` : ""
        }.`,
      });
    }

    if (cpu >= 20 || memory >= 12) {
      signals.push({
        priority: 3 + cpu + memory,
        serviceName: node.name,
        text: `${node.name} is resource-heavy right now (${formatResourceState(node)})${
          projectLabel ? ` in ${projectLabel}` : ""
        }.`,
      });
    }

    const duplicateKey = `${(projectLabel || "global").toLowerCase()}::${node.name.toLowerCase()}`;
    const bucket = duplicateBuckets.get(duplicateKey) || {
      name: node.name,
      projectLabel,
      count: 0,
      running: 0,
    };
    bucket.count += 1;
    if (health === "green") bucket.running += 1;
    duplicateBuckets.set(duplicateKey, bucket);
  }

  for (const bucket of duplicateBuckets.values()) {
    if (bucket.count < 2) continue;
    signals.push({
      priority: 5 + bucket.count,
      serviceName: bucket.name,
      text: `${bucket.count} instances of ${bucket.name} are visible${
        bucket.projectLabel ? ` in ${bucket.projectLabel}` : ""
      } (${bucket.running} active).`,
    });
  }

  return signals
    .sort((a, b) => b.priority - a.priority || a.text.localeCompare(b.text))
    .map((entry) => ({
      text: entry.text,
      serviceName: entry.serviceName || null,
    }));
}

function buildQueryPrompt(graphSnapshot, query) {
  const nodes = graphSnapshot.nodes || [];
  const edges = graphSnapshot.edges || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const focus = extractFocusTerms(graphSnapshot, query);
  const queryText = String(query || "").toLowerCase();

  const services = summarizePromptList(
    nodes
      .filter((node) => node.type !== "external")
      .sort((a, b) => {
        const aFocused = focus.serviceIds.has(a.id) ? 1 : 0;
        const bFocused = focus.serviceIds.has(b.id) ? 1 : 0;
        const aRouteMatch = (a.routes || []).some((route) =>
          Array.from(focus.routeTerms).some((term) =>
            String(route.path || "").toLowerCase().includes(term),
          ),
        )
          ? 1
          : 0;
        const bRouteMatch = (b.routes || []).some((route) =>
          Array.from(focus.routeTerms).some((term) =>
            String(route.path || "").toLowerCase().includes(term),
          ),
        )
          ? 1
          : 0;
        const aPorts = Array.isArray(a.ports) ? a.ports.length : 0;
        const bPorts = Array.isArray(b.ports) ? b.ports.length : 0;
        return (
          bFocused - aFocused ||
          bRouteMatch - aRouteMatch ||
          bPorts - aPorts ||
          a.name.localeCompare(b.name)
        );
      }),
    MAX_PROMPT_SERVICES,
    (node) => {
      const ports = (node.ports || []).map((entry) => entry.port).join(", ");
      const status = node.healthStatus || "unknown";
      const project = getProjectLabel(node);
      const routeCount = Array.isArray(node.routes) ? node.routes.length : 0;
      const routeHint = routeCount > 0 ? `, routes: ${routeCount}` : "";
      const projectHint = project ? `, ${project}` : "";
      return `- ${node.name} (type: ${node.type}, ports: ${ports || "none"}, health: ${status}, ${formatResourceState(node)}${routeHint}${projectHint})`;
    },
  );

  const connections = summarizePromptList(
    [...edges].sort((a, b) => {
      const aFocusBoost =
        (focus.serviceIds.has(a.source) || focus.serviceIds.has(a.target) ? 2 : 0) +
        (focus.ports.has(a.sourcePort) || focus.ports.has(a.targetPort) ? 1 : 0);
      const bFocusBoost =
        (focus.serviceIds.has(b.source) || focus.serviceIds.has(b.target) ? 2 : 0) +
        (focus.ports.has(b.sourcePort) || focus.ports.has(b.targetPort) ? 1 : 0);
      const aScore = aFocusBoost + (a.confidence || 0);
      const bScore = bFocusBoost + (b.confidence || 0);
      return bScore - aScore;
    }),
    MAX_PROMPT_CONNECTIONS,
    (edge) => {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      return `- ${source?.name || edge.source} -> ${target?.name || edge.target} (target port ${edge.targetPort || "?"})`;
    },
  );

  const externalApis = summarizePromptList(
    nodes.filter((node) => node.type === "external"),
    MAX_PROMPT_EXTERNALS,
    (node) => `- ${node.name}`,
  );

  const routes = summarizePromptList(
    nodes
      .filter((node) => Array.isArray(node.routes) && node.routes.length > 0)
      .sort((a, b) => {
        const aFocused = focus.serviceIds.has(a.id) ? 2 : 0;
        const bFocused = focus.serviceIds.has(b.id) ? 2 : 0;
        const aRouteMatch = (a.routes || []).some((route) =>
          Array.from(focus.routeTerms).some((term) =>
            String(route.path || "").toLowerCase().includes(term),
          ),
        )
          ? 2
          : 0;
        const bRouteMatch = (b.routes || []).some((route) =>
          Array.from(focus.routeTerms).some((term) =>
            String(route.path || "").toLowerCase().includes(term),
          ),
        )
          ? 2
          : 0;
        return (
          bFocused + bRouteMatch - (aFocused + aRouteMatch) ||
          (b.routes?.length || 0) - (a.routes?.length || 0)
        );
      })
      .flatMap((node) =>
        (node.routes || []).map((route) => ({
          serviceName: node.name,
          method: route.method,
          path: route.path,
          framework: route.framework || null,
        })),
      ),
    MAX_PROMPT_ROUTES,
    (route) =>
      `- ${route.serviceName}: ${route.method} ${route.path}${route.framework ? ` (${route.framework})` : ""}`,
  );

  const projectMap = new Map();
  for (const node of nodes) {
    if (node.type === "external") continue;
    const key =
      node.project ||
      (node.projectPath ? path.basename(node.projectPath) : null) ||
      (node.repoPath ? path.basename(node.repoPath) : null);
    if (!key) continue;
    const current = projectMap.get(key) || {
      name: key,
      services: 0,
      healthy: 0,
      ports: new Set(),
    };
    current.services += 1;
    if (node.healthStatus === "green") current.healthy += 1;
    for (const entry of node.ports || []) current.ports.add(entry.port);
    projectMap.set(key, current);
  }
  const projects = summarizePromptList(
    Array.from(projectMap.values()).sort((a, b) => {
      const aFocus = focus.projectTerms.has(String(a.name).toLowerCase()) ? 1 : 0;
      const bFocus = focus.projectTerms.has(String(b.name).toLowerCase()) ? 1 : 0;
      return bFocus - aFocus || b.services - a.services || a.name.localeCompare(b.name);
    }),
    MAX_PROMPT_PROJECTS,
    (project) =>
      `- ${project.name} (${project.services} services, ${project.healthy} active, ports: ${
        Array.from(project.ports).sort((a, b) => a - b).join(", ") || "none"
      })`,
  );
  const optimizationSignalList = buildOptimizationSignals(nodes);
  const optimizationSignals = summarizePromptList(
    optimizationSignalList,
    8,
    (signal) => `- ${signal.text}`,
  );

  const routeOwners = summarizePromptList(
    nodes
      .filter((node) => Array.isArray(node.routes) && node.routes.length > 0)
      .flatMap((node) =>
        (node.routes || [])
          .filter((route) =>
            focus.routeTerms.size === 0
              ? false
              : Array.from(focus.routeTerms).some((term) =>
                  String(route.path || "").toLowerCase().includes(term),
                ),
          )
          .map((route) => ({
            serviceName: node.name,
            method: route.method,
            path: route.path,
            ports: (node.ports || []).map((entry) => entry.port),
            project: getProjectLabel(node),
          })),
      ),
    8,
    (route) =>
      `- ${route.method} ${route.path} -> ${route.serviceName}${
        route.ports.length > 0 ? ` (ports: ${route.ports.join(", ")})` : ""
      }${route.project ? `, ${route.project}` : ""}`,
  );

  const portOwners = summarizePromptList(
    nodes
      .filter((node) =>
        (node.ports || []).some((entry) => focus.ports.has(entry.port)),
      )
      .map((node) => ({
        name: node.name,
        type: node.type,
        health: node.healthStatus || "unknown",
        ports: (node.ports || [])
          .map((entry) => entry.port)
          .filter((port) => focus.ports.has(port)),
        project: getProjectLabel(node),
      })),
    8,
    (node) =>
      `- ${node.name} (${node.type}, ports: ${node.ports.join(", ")}, health: ${node.health}${
        node.project ? `, ${node.project}` : ""
      })`,
  );

  const idleOrHeavyServices = summarizePromptList(
    nodes
      .filter((node) => node.type !== "external")
      .filter(
        (node) =>
          node.healthStatus === "yellow" ||
          Number(node.cpu || 0) >= 5 ||
          Number(node.memory || 0) >= 5,
      )
      .sort((a, b) => {
        const aScore =
          (a.healthStatus === "yellow" ? 3 : 0) + Number(a.memory || 0) + Number(a.cpu || 0);
        const bScore =
          (b.healthStatus === "yellow" ? 3 : 0) + Number(b.memory || 0) + Number(b.cpu || 0);
        return bScore - aScore;
      }),
    10,
    (node) =>
      `- ${node.name} (health: ${node.healthStatus}, ${formatResourceState(node)}${
        getProjectLabel(node) ? `, ${getProjectLabel(node)}` : ""
      })`,
  );

  const intentHints = [];
  if (focus.routeTerms.size > 0 || queryText.includes("route") || queryText.includes("endpoint")) {
    intentHints.push(
      "- If the user asks about a route or endpoint, answer with the owning service first, then mention relevant ports and project.",
    );
  }
  if (focus.ports.size > 0 || queryText.includes("port")) {
    intentHints.push(
      "- If the user asks about a port, identify the owning service directly before describing dependencies.",
    );
  }
  if (queryText.includes("idle") || queryText.includes("active") || queryText.includes("memory") || queryText.includes("cpu")) {
    intentHints.push(
      "- If the user asks about activity or resources, rank services by health and current cpu/memory instead of giving a generic topology summary.",
    );
  }
  if (queryText.includes("project") || queryText.includes("repo")) {
    intentHints.push(
      "- If the user asks about a project or repo, summarize the project grouping and which services belong to it.",
    );
  }

  return `You are Fere's stack assistant. Answer questions about the user's local development environment clearly and concisely.

You are not debugging a failure unless the user explicitly asks for diagnosis. For general questions:
- answer directly from the environment topology
- use route, health, resource, and project context when it helps answer the question
- explain relationships between services
- identify likely owners of ports and dependencies
- call out uncertainty when topology alone is insufficient
- keep answers short and practical
${intentHints.length > 0 ? intentHints.join("\n") : ""}

Use this response structure unless the user asks for something else:
1. Start with a single sentence that directly answers the question.
2. Then add a short \`Supporting facts\` bullet list with 2-4 bullets.
3. If there is uncertainty or missing context, end with one short \`Uncertainty\` bullet.

Formatting rules:
- Prefer bullets over paragraphs.
- Do not write a long introduction.
- Do not restate the entire graph.
- If ownership is clear, name the owning service in the first sentence.
- If the answer is a list, rank the most relevant items first.

When referencing services, ports, or files, use backticks.

## Current Services
${services || "No services detected"}

## Current Connections
${connections || "No connections detected"}

## Known Routes
${routes || "No API routes detected"}

## Project Context
${projects || "No project grouping detected"}

## Matching Route Owners
${routeOwners || "No route-specific matches"}

## Matching Port Owners
${portOwners || "No port-specific matches"}

## Idle / Heavy Services
${idleOrHeavyServices || "No notable idle or heavy services"}

## Optimization Signals
${optimizationSignals || "No obvious optimization signals"}

## External APIs
${externalApis || "None detected"}
`;
}

function buildQueryReferences(graphSnapshot, query) {
  const nodes = graphSnapshot.nodes || [];
  const focus = extractFocusTerms(graphSnapshot, query);
  const serviceNames = [];
  const seenServices = new Set();
  const ports = Array.from(focus.ports).sort((a, b) => a - b).slice(0, 6);
  const routes = [];
  const seenRoutes = new Set();
  const projects = [];
  const seenProjects = new Set();

  for (const node of nodes) {
    if (node.type === "external") continue;
    const focused = focus.serviceIds.has(node.id);
    const routeMatches = (node.routes || []).filter((route) =>
      Array.from(focus.routeTerms).some((term) =>
        String(route.path || "").toLowerCase().includes(term),
      ),
    );
    if (focused && !seenServices.has(node.name)) {
      seenServices.add(node.name);
      serviceNames.push(node.name);
    }
    const projectName =
      node.project ||
      (node.projectPath ? path.basename(node.projectPath) : null) ||
      (node.repoPath ? path.basename(node.repoPath) : null);
    if (
      projectName &&
      (focus.projectTerms.has(String(projectName).toLowerCase()) || focused) &&
      !seenProjects.has(projectName)
    ) {
      seenProjects.add(projectName);
      projects.push(projectName);
    }
    for (const route of routeMatches) {
      const key = `${node.name}:${route.method}:${route.path}`;
      if (seenRoutes.has(key)) continue;
      seenRoutes.add(key);
      routes.push({
        serviceName: node.name,
        method: route.method,
        path: route.path,
      });
    }
  }

  if (serviceNames.length === 0) {
    const topNodes = nodes
      .filter((node) => node.type !== "external")
      .sort((a, b) => (b.ports?.length || 0) - (a.ports?.length || 0))
      .slice(0, 3);
    for (const node of topNodes) {
      if (!seenServices.has(node.name)) {
        seenServices.add(node.name);
        serviceNames.push(node.name);
      }
    }
  }

  return {
    services: serviceNames.slice(0, 6),
    ports,
    routes: routes.slice(0, 6),
    projects: projects.slice(0, 4),
  };
}

function classifyQueryIntent(graphSnapshot, query, focus) {
  const text = String(query || "").toLowerCase();
  if (
    focus.routeTerms.size > 0 ||
    /\b(route|routes|endpoint|endpoints|path|paths|url)\b/.test(text)
  ) {
    return "route_owner";
  }
  if (
    focus.ports.size > 0 &&
    /\b(port|ports|using|uses|owner|owns|what is on|what's on)\b/.test(text)
  ) {
    return "port_owner";
  }
  if (
    /\b(idle|active|inactive|heavy|resource|resources|memory|cpu)\b/.test(text)
  ) {
    return "resource_summary";
  }
  if (
    /\b(project|repo|repository|stack)\b/.test(text) &&
    (focus.projectTerms.size > 0 || focus.serviceIds.size > 0)
  ) {
    return "project_summary";
  }
  if (
    /\bwhat depends on\b|\bdepends on\b|\bwho depends on\b|\bwhat uses\b/.test(text) &&
    focus.serviceIds.size > 0
  ) {
    if (/\bwhat does\b|\bdoes .* depend on\b|\bdependencies\b/.test(text)) {
      return "dependencies";
    }
    return "dependents";
  }
  if (
    (/\b(flow|path|between|from)\b/.test(text) && focus.serviceIds.size >= 2) ||
    /\bhow does .* get to\b/.test(text)
  ) {
    return "path_trace";
  }
  if (
    focus.serviceIds.size === 1 &&
    /\b(what does|what is|tell me about|about|explain)\b/.test(text)
  ) {
    return "service_summary";
  }
  return null;
}

function buildGraphIndexes(graphSnapshot) {
  const nodes = (graphSnapshot.nodes || []).filter((node) => node.type !== "external");
  const edges = graphSnapshot.edges || [];
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const edge of edges) {
    if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
    const out = outgoing.get(edge.source) || [];
    out.push(edge);
    outgoing.set(edge.source, out);
    const inc = incoming.get(edge.target) || [];
    inc.push(edge);
    incoming.set(edge.target, inc);
  }
  return { nodes, edges, nodeById, outgoing, incoming };
}

function buildStructuredResult(kind, directAnswer, supportingFacts, uncertainty) {
  return {
    kind,
    directAnswer,
    supportingFacts: supportingFacts.filter(Boolean).slice(0, 6),
    uncertainty: (uncertainty || []).filter(Boolean).slice(0, 3),
  };
}

function formatStructuredAnswer(result) {
  const lines = [result.directAnswer];
  if (result.supportingFacts.length > 0) {
    lines.push("", "Supporting facts");
    for (const fact of result.supportingFacts) lines.push(`- ${fact}`);
  }
  if (result.uncertainty && result.uncertainty.length > 0) {
    lines.push("", "Uncertainty");
    for (const item of result.uncertainty) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}

function resolveDeterministicQuery(graphSnapshot, query) {
  const focus = extractFocusTerms(graphSnapshot, query);
  const intent = classifyQueryIntent(graphSnapshot, query, focus);
  if (!intent) return null;

  const indexes = buildGraphIndexes(graphSnapshot);
  const focusedNodes = indexes.nodes.filter((node) => focus.serviceIds.has(node.id));
  const firstNode = focusedNodes[0];

  if (intent === "port_owner" && focus.ports.size > 0) {
    const ports = Array.from(focus.ports).sort((a, b) => a - b);
    const owners = indexes.nodes.filter((node) =>
      (node.ports || []).some((entry) => focus.ports.has(entry.port)),
    );
    const directAnswer =
      owners.length === 0
        ? `No visible service in this scope owns ${ports.map((port) => `\`:${port}\``).join(", ")}.`
        : owners.length === 1
          ? `${ports.map((port) => `\`:${port}\``).join(", ")} ${
              ports.length === 1 ? "is" : "are"
            } owned by \`${owners[0].name}\`.`
          : `${ports.map((port) => `\`:${port}\``).join(", ")} map to multiple services in this scope.`;
    return {
      structuredAnswer: buildStructuredResult(
        "port_owner",
        directAnswer,
        owners.map(
          (node) =>
            `\`${node.name}\` listens on ${(node.ports || [])
              .filter((entry) => focus.ports.has(entry.port))
              .map((entry) => `\`:${entry.port}\``)
              .join(", ")} with health \`${node.healthStatus}\`.`,
        ),
        owners.length === 0 ? ["The port may belong to a system service or a service outside the current filtered graph."] : [],
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  if (intent === "route_owner" && focus.routeTerms.size > 0) {
    const matches = indexes.nodes.flatMap((node) =>
      (node.routes || [])
        .filter((route) =>
          Array.from(focus.routeTerms).some((term) =>
            String(route.path || "").toLowerCase().includes(term),
          ),
        )
        .map((route) => ({ node, route })),
    );
    const directAnswer =
      matches.length === 0
        ? `No matching route owner was found in the current scope.`
        : matches.length === 1
          ? `\`${matches[0].route.method} ${matches[0].route.path}\` is owned by \`${matches[0].node.name}\`.`
          : `I found multiple route matches in the current scope.`;
    return {
      structuredAnswer: buildStructuredResult(
        "route_owner",
        directAnswer,
        matches.map(
          ({ node, route }) =>
            `\`${node.name}\` exposes \`${route.method} ${route.path}\`${node.ports?.length ? ` on ${(node.ports || []).map((entry) => `\`:${entry.port}\``).join(", ")}` : ""}.`,
        ),
        matches.length === 0 ? ["The route may not have been discovered yet, or it belongs to a service outside the current scope."] : [],
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  if (intent === "dependents" && firstNode) {
    const incoming = indexes.incoming.get(firstNode.id) || [];
    const sources = incoming
      .map((edge) => indexes.nodeById.get(edge.source))
      .filter(Boolean);
    return {
      structuredAnswer: buildStructuredResult(
        "dependents",
        sources.length > 0
          ? `\`${firstNode.name}\` is used by ${sources.map((node) => `\`${node.name}\``).join(", ")}.`
          : `No visible services in this scope currently depend on \`${firstNode.name}\`.`,
        incoming.map(
          (edge) =>
            `\`${indexes.nodeById.get(edge.source)?.name}\` connects to \`${firstNode.name}\` on \`:${edge.targetPort}\`.`,
        ),
        sources.length === 0 ? ["Only visible edges in the current filtered graph are considered."] : [],
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  if (intent === "dependencies" && firstNode) {
    const outgoing = indexes.outgoing.get(firstNode.id) || [];
    const targets = outgoing
      .map((edge) => indexes.nodeById.get(edge.target))
      .filter(Boolean);
    return {
      structuredAnswer: buildStructuredResult(
        "dependencies",
        targets.length > 0
          ? `\`${firstNode.name}\` depends on ${targets.map((node) => `\`${node.name}\``).join(", ")}.`
          : `No visible downstream dependencies were found for \`${firstNode.name}\` in this scope.`,
        outgoing.map(
          (edge) =>
            `\`${firstNode.name}\` connects to \`${indexes.nodeById.get(edge.target)?.name}\` on \`:${edge.targetPort}\`.`,
        ),
        targets.length === 0 ? ["Only visible edges in the current filtered graph are considered."] : [],
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  if (intent === "resource_summary") {
    const ranked = indexes.nodes
      .filter(
        (node) =>
          node.healthStatus === "yellow" ||
          Number(node.cpu || 0) >= 5 ||
          Number(node.memory || 0) >= 5,
      )
      .sort((a, b) => {
        const aScore =
          (a.healthStatus === "yellow" ? 3 : 0) + Number(a.cpu || 0) + Number(a.memory || 0);
        const bScore =
          (b.healthStatus === "yellow" ? 3 : 0) + Number(b.cpu || 0) + Number(b.memory || 0);
        return bScore - aScore;
      })
      .slice(0, 5);
    return {
      structuredAnswer: buildStructuredResult(
        "resource_summary",
        ranked.length > 0
          ? `The most notable services right now are ${ranked.map((node) => `\`${node.name}\``).join(", ")}.`
          : `There are no standout idle or resource-heavy services in the current scope.`,
        ranked.map(
          (node) =>
            `\`${node.name}\` is \`${node.healthStatus}\` with ${formatResourceState(node)}${getProjectLabel(node) ? `, ${getProjectLabel(node)}` : ""}.`,
        ),
      ),
      references: buildQueryReferences(graphSnapshot, query),
      optimizationSignals: buildOptimizationSignals(graphSnapshot.nodes || []).slice(0, 6),
    };
  }

  if (intent === "project_summary") {
    const projectNames = new Set(focus.projectTerms);
    for (const node of focusedNodes) {
      if (node.project) projectNames.add(String(node.project).toLowerCase());
      if (node.projectPath) projectNames.add(path.basename(node.projectPath).toLowerCase());
      if (node.repoPath) projectNames.add(path.basename(node.repoPath).toLowerCase());
    }
    const matchedNodes = indexes.nodes.filter((node) => {
      const labels = [
        node.project,
        node.projectPath ? path.basename(node.projectPath) : null,
        node.repoPath ? path.basename(node.repoPath) : null,
      ]
        .filter(Boolean)
        .map((value) => String(value).toLowerCase());
      return labels.some((label) => projectNames.has(label));
    });
    const projectLabel =
      matchedNodes[0]?.project ||
      (matchedNodes[0]?.projectPath ? path.basename(matchedNodes[0].projectPath) : null) ||
      (matchedNodes[0]?.repoPath ? path.basename(matchedNodes[0].repoPath) : null);
    return {
      structuredAnswer: buildStructuredResult(
        "project_summary",
        matchedNodes.length > 0
          ? `\`${projectLabel || "This project"}\` contains ${matchedNodes.length} visible services.`
          : `No matching project was found in the current scope.`,
        matchedNodes.slice(0, 6).map(
          (node) =>
            `\`${node.name}\` is a \`${node.type}\` service${node.ports?.length ? ` on ${(node.ports || []).map((entry) => `\`:${entry.port}\``).join(", ")}` : ""} with health \`${node.healthStatus}\`.`,
        ),
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  if (intent === "service_summary" && firstNode) {
    const incoming = indexes.incoming.get(firstNode.id) || [];
    const outgoing = indexes.outgoing.get(firstNode.id) || [];
    return {
      structuredAnswer: buildStructuredResult(
        "service_summary",
        `\`${firstNode.name}\` is a \`${firstNode.type}\` service${firstNode.ports?.length ? ` listening on ${(firstNode.ports || []).map((entry) => `\`:${entry.port}\``).join(", ")}` : ""}.`,
        [
          `Health is \`${firstNode.healthStatus}\` with ${formatResourceState(firstNode)}.`,
          `${incoming.length} incoming and ${outgoing.length} outgoing visible connection${incoming.length + outgoing.length === 1 ? "" : "s"}.`,
          Array.isArray(firstNode.routes) && firstNode.routes.length > 0
            ? `${firstNode.routes.length} discovered route${firstNode.routes.length === 1 ? "" : "s"}.`
            : `No discovered API routes in the current snapshot.`,
          getProjectLabel(firstNode) ? `${getProjectLabel(firstNode)}.` : "",
        ],
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  if (intent === "path_trace" && focusedNodes.length >= 2) {
    const source = focusedNodes[0];
    const target = focusedNodes[1];
    const queue = [[source.id]];
    const visited = new Set([source.id]);
    let foundPath = null;
    while (queue.length > 0) {
      const currentPath = queue.shift();
      const last = currentPath[currentPath.length - 1];
      if (last === target.id) {
        foundPath = currentPath;
        break;
      }
      for (const edge of indexes.outgoing.get(last) || []) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);
        queue.push([...currentPath, edge.target]);
      }
    }
    const pathNodes = foundPath
      ? foundPath.map((id) => indexes.nodeById.get(id)).filter(Boolean)
      : [];
    return {
      structuredAnswer: buildStructuredResult(
        "path_trace",
        pathNodes.length > 0
          ? `The visible path from \`${source.name}\` to \`${target.name}\` is ${pathNodes.map((node) => `\`${node.name}\``).join(" -> ")}.`
          : `No visible path from \`${source.name}\` to \`${target.name}\` was found in this scope.`,
        pathNodes.slice(0, -1).map((node, index) => {
          const next = pathNodes[index + 1];
          const edge = (indexes.outgoing.get(node.id) || []).find((candidate) => candidate.target === next.id);
          return `\`${node.name}\` connects to \`${next.name}\`${edge?.targetPort ? ` on \`:${edge.targetPort}\`` : ""}.`;
        }),
        pathNodes.length === 0 ? ["Only currently visible directed connections are considered."] : [],
      ),
      references: buildQueryReferences(graphSnapshot, query),
    };
  }

  return null;
}

function callOpenAIStream(apiKey, systemPrompt, query, onToken) {
  const body = JSON.stringify({
    model: MODEL,
    max_tokens: MAX_TOKENS_QUERY,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: query },
    ],
    stream: true,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.openai.com",
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          let errData = "";
          res.on("data", (chunk) => {
            errData += chunk;
          });
          res.on("end", () => {
            reject(new Error(`OpenAI API error ${res.statusCode}: ${errData}`));
          });
          return;
        }

        let sseBuffer = "";
        let messageContent = "";

        res.on("data", (chunk) => {
          sseBuffer += chunk.toString();
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            let parsed;
            try {
              parsed = JSON.parse(data);
            } catch {
              continue;
            }

            const delta = parsed.choices?.[0]?.delta;
            if (!delta) continue;
            if (typeof delta.content === "string" && delta.content) {
              messageContent += delta.content;
              onToken(delta.content);
            }
          }
        });

        res.on("end", () => resolve(messageContent));
        res.on("error", reject);
      },
    );

    req.on("error", reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error("OpenAI API timeout (60s)"));
    });
    req.write(body);
    req.end();
  });
}

async function runQueryAgent(options, onProgress) {
  const { query, graphSnapshot, apiKey } = options;
  const deterministic = resolveDeterministicQuery(graphSnapshot, query);
  if (deterministic) {
    onProgress({ type: "thinking" });
    onProgress({
      type: "complete",
      answer: formatStructuredAnswer(deterministic.structuredAnswer),
      structuredAnswer: deterministic.structuredAnswer,
      references: deterministic.references,
      optimizationSignals:
        deterministic.optimizationSignals ||
        buildOptimizationSignals(graphSnapshot.nodes || []).slice(0, 6),
    });
    return { success: true, answer: deterministic.structuredAnswer.directAnswer };
  }

  const systemPrompt = buildQueryPrompt(graphSnapshot, query);
  const references = buildQueryReferences(graphSnapshot, query);
  const optimizationSignals = buildOptimizationSignals(graphSnapshot.nodes || []).slice(0, 6);

  onProgress({ type: "thinking" });

  const text = await callOpenAIStream(apiKey, systemPrompt, query, (delta) => {
    if (!options._cancelled) {
      onProgress({ type: "answer_delta", text: delta });
    }
  });

  if (options._cancelled) {
    return { success: false, error: "Cancelled" };
  }

  onProgress({ type: "complete", answer: text, references, optimizationSignals });
  return { success: true, answer: text };
}

module.exports = {
  runQueryAgent,
};
