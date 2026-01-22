#!/usr/bin/env node
/**
 * Test Node.js HTTP Server for Fere Dashboard Testing
 *
 * This server runs alongside the Flask API to test multi-service detection.
 * It simulates a frontend dev server or BFF (Backend for Frontend).
 *
 * Run with: node node-server.js
 */

const http = require('http');
const url = require('url');

const PORT = process.env.PORT || 3001;
const FLASK_API = process.env.FLASK_API || 'http://localhost:5001';

// Simple in-memory state
const state = {
  requests: 0,
  startTime: Date.now(),
};

// Route handlers
const routes = {
  'GET /': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'Fere Test Node Server',
      version: '1.0.0',
      type: 'frontend-proxy',
      upstreamApi: FLASK_API,
      endpoints: [
        'GET /',
        'GET /health',
        'GET /stats',
        'GET /proxy/*',
      ],
    }));
  },

  'GET /health': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime_ms: Date.now() - state.startTime,
    }));
  },

  'GET /stats': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      requests: state.requests,
      uptime_ms: Date.now() - state.startTime,
      memory: process.memoryUsage(),
      pid: process.pid,
    }));
  },
};

// Create server
const server = http.createServer((req, res) => {
  state.requests++;

  const parsedUrl = url.parse(req.url, true);
  const routeKey = `${req.method} ${parsedUrl.pathname}`;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
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
  if (parsedUrl.pathname.startsWith('/proxy/')) {
    const targetPath = parsedUrl.pathname.replace('/proxy', '');
    const targetUrl = `${FLASK_API}${targetPath}`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      message: 'Proxy endpoint - would forward to Flask API',
      targetUrl,
      note: 'Actual proxying not implemented in this test server',
    }));
    return;
  }

  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: parsedUrl.pathname }));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
