const https = require("https");
const path = require("path");

const MODEL = "gpt-4.1";
const MAX_TOKENS_QUERY = 900;
const MAX_PROMPT_SERVICES = 16;
const MAX_PROMPT_CONNECTIONS = 22;
const MAX_PROMPT_EXTERNALS = 12;
const MAX_PROMPT_ROUTES = 16;
const MAX_PROMPT_PROJECTS = 10;

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

  for (const node of graphSnapshot.nodes || []) {
    if (node.type === "external" || !node.name) continue;
    const name = node.name.toLowerCase();
    if (text.includes(`@${name}`) || text.includes(name)) {
      serviceIds.add(node.id);
    }
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
