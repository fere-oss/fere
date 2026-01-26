#!/usr/bin/env node
/**
 * Test Node.js HTTP Server for Fere Dashboard Testing
 *
 * This server runs alongside the Flask API to test multi-service detection.
 * It simulates a frontend dev server or BFF (Backend for Frontend).
 *
 * Run with: node node-server.js
 */

const http = require("http");
const url = require("url");
const net = require("net");

const PORT = process.env.PORT || 3002;
const FLASK_API = process.env.FLASK_API || "http://localhost:5001";

// Simple in-memory state
const state = {
  requests: 0,
  startTime: Date.now(),
};

// Route handlers
const routes = {
  "GET /": (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        name: "Fere Test Node Server",
        version: "1.0.0",
        type: "frontend-proxy",
        upstreamApi: FLASK_API,
        endpoints: ["GET /", "GET /health", "GET /stats", "GET /proxy/*"],
      }),
    );
  },

  "GET /health": (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime_ms: Date.now() - state.startTime,
      }),
    );
  },

  "GET /stats": (req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        requests: state.requests,
        uptime_ms: Date.now() - state.startTime,
        memory: process.memoryUsage(),
        pid: process.pid,
      }),
    );
  },
};

// Create server
const server = http.createServer((req, res) => {
  state.requests++;

  const parsedUrl = url.parse(req.url, true);
  const routeKey = `${req.method} ${parsedUrl.pathname}`;

  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS",
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Check for exact route match
  if (routes[routeKey]) {
    routes[routeKey](req, res);
    return;
  }

  // Proxy requests to Flask API
  if (parsedUrl.pathname.startsWith("/proxy/")) {
    const targetPath = parsedUrl.pathname.replace("/proxy", "");
    const targetUrl = `${FLASK_API}${targetPath}`;

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        message: "Proxy endpoint - would forward to Flask API",
        targetUrl,
        note: "Actual proxying not implemented in this test server",
      }),
    );
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not Found", path: parsedUrl.pathname }));
});

// Start server
server.listen(PORT, "0.0.0.0", () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                  Fere Test Node Server                        ║
╠═══════════════════════════════════════════════════════════════╣
║  Server running on http://localhost:${PORT}                      ║
║  PID: ${process.pid}                                                 ║
║  Upstream API: ${FLASK_API}                            ║
║                                                               ║
║  Endpoints:                                                   ║
║    GET  /         - Server info                               ║
║    GET  /health   - Health check                              ║
║    GET  /stats    - Request statistics                        ║
║    GET  /proxy/*  - Proxy to Flask API                        ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Keep a persistent TCP connection to the Flask API so edges show up in the graph.
let keepaliveSocket = null;
let keepaliveTimer = null;
const extraKeepalives = [];

function scheduleKeepaliveReconnect() {
  if (keepaliveTimer) return;
  keepaliveTimer = setTimeout(() => {
    keepaliveTimer = null;
    startKeepalive();
  }, 2000);
}

function startKeepalive() {
  try {
    const target = new URL(FLASK_API);
    const port = target.port ? parseInt(target.port, 10) : 80;
    keepaliveSocket = net.createConnection(
      { host: target.hostname, port },
      () => {
        keepaliveSocket.setKeepAlive(true, 10000);
      },
    );
    keepaliveSocket.on("error", scheduleKeepaliveReconnect);
    keepaliveSocket.on("close", scheduleKeepaliveReconnect);
  } catch (err) {
    scheduleKeepaliveReconnect();
  }
}

startKeepalive();

function startTcpKeepalive(host, port) {
  const state = { socket: null, timer: null };

  const reconnect = () => {
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      connect();
    }, 2000);
  };

  const connect = () => {
    state.socket = net.createConnection({ host, port }, () => {
      state.socket.setKeepAlive(true, 10000);
    });
    state.socket.on("error", reconnect);
    state.socket.on("close", reconnect);
  };

  connect();
  return state;
}

// Extra connections to surface multiple edges in the graph.
extraKeepalives.push(startTcpKeepalive("127.0.0.1", 6379)); // Redis mock
extraKeepalives.push(startTcpKeepalive("127.0.0.1", 2375)); // Docker mock
extraKeepalives.push(startTcpKeepalive("127.0.0.1", 7070)); // Service mock

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  if (keepaliveTimer) clearTimeout(keepaliveTimer);
  if (keepaliveSocket) keepaliveSocket.destroy();
  extraKeepalives.forEach((state) => {
    if (state.timer) clearTimeout(state.timer);
    if (state.socket) state.socket.destroy();
  });
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
});
