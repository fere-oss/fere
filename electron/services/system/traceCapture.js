const crypto = require("crypto");
const platform = require("../platform");

const POLL_INTERVAL_MS = 200;
const TRACE_TIMEOUT_MS = 30000;

/**
 * Get fresh (uncached) established TCP connections.
 * Bypasses portMonitor's 5s cache to get real-time data for tracing.
 * Calls the platform layer directly for uncached results.
 */
async function getFreshConnections() {
  try {
    return await platform.fetchEstablishedConnections();
  } catch (error) {
    console.error("[traceCapture] Error getting connections:", error.message);
    return [];
  }
}

/**
 * Build a Set key for a connection tuple.
 */
function connKey(conn) {
  return `${conn.pid}:${conn.localPort}->${conn.remoteHost}:${conn.remotePort}`;
}

/**
 * Resolve a connection to a graph edge (source node → target node).
 * Returns { sourceNodeId, targetNodeId, connectionType } or null.
 */
function resolveConnection(conn, pidToNode, portToNode, externalApis) {
  const sourceNode = pidToNode.get(conn.pid);
  if (!sourceNode) return null;

  // Check if target is a local service (by remote port)
  const targetNode = portToNode.get(conn.remotePort);
  if (targetNode && targetNode.id !== sourceNode.id) {
    return {
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      connectionType: "tcp",
    };
  }

  // Check if target is an external API (non-local IP)
  const rh = conn.remoteHost;
  if (
    rh !== "127.0.0.1" &&
    rh !== "::1" &&
    rh !== "localhost" &&
    !rh.startsWith("192.168.") &&
    !rh.startsWith("10.") &&
    !rh.startsWith("172.")
  ) {
    // Try to match to an external node in the graph
    for (const node of externalApis) {
      return {
        sourceNodeId: sourceNode.id,
        targetNodeId: node.id,
        connectionType: "external",
      };
    }
    // Even if no external node matched, record as external
    return {
      sourceNodeId: sourceNode.id,
      targetNodeId: `external:${rh}`,
      connectionType: "external",
    };
  }

  return null;
}

/**
 * Build lookup maps from graph nodes.
 */
function buildNodeMaps(graphNodes) {
  const pidToNode = new Map();
  const portToNode = new Map();
  const externalApis = [];

  for (const node of graphNodes) {
    if (node.type === "external") {
      externalApis.push(node);
      continue;
    }
    if (node.pid > 0) {
      pidToNode.set(node.pid, node);
    }
    for (const p of node.ports) {
      portToNode.set(p.port, node);
    }
  }

  return { pidToNode, portToNode, externalApis };
}

/**
 * Find the graph node that matches the request URL's port.
 * Prefers Docker container nodes over the Docker Desktop proxy process
 * (which owns ALL mapped ports but has no graph edges).
 */
function findTargetNode(url, graphNodes) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const port = parseInt(parsed.port, 10) || (parsed.protocol === "https:" ? 443 : 80);
  let fallback = null;
  for (const node of graphNodes) {
    if (node.type === "external") continue;
    for (const p of node.ports) {
      if (p.port === port) {
        // Prefer actual container nodes over the Docker Desktop backend process
        if (node.isDockerContainer || node.containerId) {
          return node;
        }
        // Keep first non-container match as fallback
        if (!fallback) fallback = node;
      }
    }
  }
  return fallback;
}

/** Data-layer node types that are always included as leaf nodes (no HTTP routes) */
const DATA_LAYER_TYPES = new Set(["database", "cache", "broker"]);

/**
 * Check whether a service node has a route that plausibly matches the request path.
 * e.g. request "/api/orders" matches a service with route "/api/orders" or "/api/orders/:id".
 */
function routeMatches(node, requestPath) {
  const routes = node.routes;
  if (!routes || routes.length === 0) return false;

  // Normalise: strip trailing slash, lowercase
  const rp = requestPath.replace(/\/+$/, "").toLowerCase();

  for (const route of routes) {
    // Normalise route path: strip param segments for prefix comparison
    // e.g. "/api/orders/:id" → "/api/orders"
    const routeBase = route.path
      .replace(/\/+$/, "")
      .toLowerCase()
      .replace(/\/:[^/]+/g, ""); // strip :param segments

    // Match if paths share a common prefix beyond just "/"
    if (routeBase.length <= 1) continue;
    if (rp.startsWith(routeBase) || routeBase.startsWith(rp)) {
      return true;
    }
  }
  return false;
}

/**
 * Route-aware walk from a starting node through graph edges.
 * Instead of blind BFS (which lights up every connected service), only follows
 * edges to downstream nodes that either:
 *   a) Have a route matching the request path (likely involved in this request)
 *   b) Are data-layer nodes (database/cache/broker) directly connected to a matched service
 * Returns edges in walk order.
 */
function bfsDockerHops(startNodeId, graphNodes, graphEdges, requestPath) {
  const nodeMap = new Map();
  for (const n of graphNodes) nodeMap.set(n.id, n);

  // Build adjacency list from graph edges (directed: source → target)
  const adj = new Map();
  for (const edge of graphEdges) {
    if (!adj.has(edge.source)) adj.set(edge.source, []);
    adj.get(edge.source).push(edge);
  }

  const visited = new Set([startNodeId]);
  const queue = [startNodeId];
  const result = [];

  while (queue.length > 0) {
    const current = queue.shift();
    const outEdges = adj.get(current) || [];
    for (const edge of outEdges) {
      if (visited.has(edge.target)) continue;
      const targetNode = nodeMap.get(edge.target);
      if (!targetNode) continue;

      // Always include data-layer nodes as leaf nodes (they don't have routes)
      if (DATA_LAYER_TYPES.has(targetNode.type)) {
        visited.add(edge.target);
        result.push(edge);
        continue; // don't recurse further from data nodes
      }

      // For service nodes, only include if they have a matching route
      if (requestPath && routeMatches(targetNode, requestPath)) {
        visited.add(edge.target);
        result.push(edge);
        queue.push(edge.target); // continue walking from this service
        continue;
      }

      // Skip: this service's routes don't match the request path
    }
  }

  return result;
}

/**
 * Execute a traced HTTP request.
 *
 * 1. Snapshot TCP connections before request
 * 2. Fire request + poll for new connections
 * 3. Diff to find hops
 * 4. Infer missed hops from known topology
 *
 * @param {Object} options - { method, url, headers, body, graphNodes, graphEdges }
 * @param {Function} makeRequest - function that fires the HTTP request, returns { response, duration }
 * @returns {Object} TraceResult
 */
async function executeTracedRequest(options, makeRequest) {
  const { graphNodes, graphEdges } = options;
  const traceId = crypto.randomUUID();
  const traceStart = Date.now();

  const { pidToNode, portToNode, externalApis } = buildNodeMaps(graphNodes);

  // 0. Identify the entry point node (the service that receives the initial request)
  const entryNode = findTargetNode(options.url, graphNodes);

  // 1. Snapshot connections before
  const beforeConns = await getFreshConnections();
  const beforeKeys = new Set(beforeConns.map(connKey));

  // Timeline of detected hops
  const timeline = [];
  const seenHopKeys = new Set();

  // 2. Start polling for new connections
  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      if (!polling) break;

      try {
        const currentConns = await getFreshConnections();
        const now = Date.now();

        for (const conn of currentConns) {
          const key = connKey(conn);
          if (beforeKeys.has(key)) continue;

          const resolved = resolveConnection(conn, pidToNode, portToNode, externalApis);
          if (!resolved) continue;

          const hopKey = `${resolved.sourceNodeId}->${resolved.targetNodeId}`;
          if (seenHopKeys.has(hopKey)) continue;
          seenHopKeys.add(hopKey);

          timeline.push({
            ...resolved,
            detectedAt: now - traceStart,
            inferred: false,
          });
        }
      } catch (err) {
        // Non-fatal — continue polling
      }
    }
  })();

  // 3. Fire the actual HTTP request
  let requestResult;
  let timedOut = false;
  try {
    requestResult = await Promise.race([
      makeRequest(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Trace timeout")), TRACE_TIMEOUT_MS),
      ),
    ]);
  } catch (err) {
    if (err.message === "Trace timeout") {
      timedOut = true;
      requestResult = null;
    } else {
      throw err;
    }
  }

  // 4. Stop polling, do one final snapshot
  polling = false;
  await pollLoop;

  const afterConns = await getFreshConnections();
  const afterNow = Date.now();
  for (const conn of afterConns) {
    const key = connKey(conn);
    if (beforeKeys.has(key)) continue;

    const resolved = resolveConnection(conn, pidToNode, portToNode, externalApis);
    if (!resolved) continue;

    const hopKey = `${resolved.sourceNodeId}->${resolved.targetNodeId}`;
    if (seenHopKeys.has(hopKey)) continue;
    seenHopKeys.add(hopKey);

    timeline.push({
      ...resolved,
      detectedAt: afterNow - traceStart,
      inferred: false,
    });
  }

  // 5. Compute totalTime early so inference can use it
  const totalTime = requestResult ? requestResult.duration : afterNow - traceStart;

  // 6. Infer hops from known topology
  if (graphEdges && graphEdges.length > 0) {
    // First: infer edges where both endpoints were already detected
    const detectedNodes = new Set(timeline.flatMap((t) => [t.sourceNodeId, t.targetNodeId]));
    for (const edge of graphEdges) {
      const hopKey = `${edge.source}->${edge.target}`;
      if (seenHopKeys.has(hopKey)) continue;
      if (detectedNodes.has(edge.source) && detectedNodes.has(edge.target)) {
        seenHopKeys.add(hopKey);
        timeline.push({
          sourceNodeId: edge.source,
          targetNodeId: edge.target,
          connectionType: "tcp",
          detectedAt: afterNow - traceStart,
          inferred: true,
        });
      }
    }

    // Second: if no hops were detected (e.g. Docker containers where host lsof
    // can't see internal traffic), walk the graph from the target node via BFS
    if (timeline.length === 0) {
      const targetNode = findTargetNode(options.url, graphNodes);
      console.log(
        "[traceCapture] BFS fallback: url=",
        options.url,
        "targetNode=",
        targetNode ? `${targetNode.name} (${targetNode.id})` : "NOT FOUND",
        "graphNodes=",
        graphNodes.length,
        "graphEdges=",
        graphEdges.length,
        "nodePorts=",
        graphNodes.map((n) => `${n.name}:[${n.ports.map((p) => p.port).join(",")}]`).join(", "),
      );
      if (targetNode) {
        // Extract request path for route-aware filtering
        let requestPath = "/";
        try {
          requestPath = new URL(options.url).pathname;
        } catch {}
        const inferredEdges = bfsDockerHops(targetNode.id, graphNodes, graphEdges, requestPath);
        console.log(
          "[traceCapture] Route-aware BFS found",
          inferredEdges.length,
          "edges from",
          targetNode.name,
          "for path",
          requestPath,
          "edges:",
          inferredEdges.map((e) => `${e.source}->${e.target}`).join(", "),
        );
        let time = 0;
        const hopInterval = totalTime / Math.max(1, inferredEdges.length + 1);
        for (const edge of inferredEdges) {
          const hopKey = `${edge.source}->${edge.target}`;
          if (seenHopKeys.has(hopKey)) continue;
          seenHopKeys.add(hopKey);
          time += hopInterval;
          timeline.push({
            sourceNodeId: edge.source,
            targetNodeId: edge.target,
            connectionType: "tcp",
            detectedAt: time,
            inferred: true,
          });
        }
      }
    }
  }

  // 7. Sort timeline and build TraceHop objects
  timeline.sort((a, b) => a.detectedAt - b.detectedAt);

  const hops = timeline.map((entry, i) => {
    const startTime = entry.detectedAt;
    const endTime = i + 1 < timeline.length ? timeline[i + 1].detectedAt : totalTime;
    return {
      sourceNodeId: entry.sourceNodeId,
      targetNodeId: entry.targetNodeId,
      startTime,
      endTime,
      latency: Math.max(0, endTime - startTime),
      connectionType: entry.connectionType,
      inferred: entry.inferred,
    };
  });

  return {
    id: traceId,
    timestamp: traceStart,
    request: {
      method: options.method,
      url: options.url,
      headers: options.headers,
    },
    response: requestResult
      ? {
          status: requestResult.status,
          statusText: requestResult.statusText,
          time: requestResult.duration,
        }
      : null,
    hops,
    totalTime,
    timedOut,
    entryNodeId: entryNode ? entryNode.id : null,
  };
}

module.exports = { executeTracedRequest };
