const fs = require('fs');
const path = require('path');

// Patterns for different frameworks
const ROUTE_PATTERNS = {
  // FastAPI: @app.get("/path"), @router.post("/path")
  fastapi: [
    /@(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi,
    /@(?:app|router)\.api_route\s*\(\s*["']([^"']+)["']/gi,
  ],
  // Flask: @app.route("/path", methods=["GET"])
  flask: [
    /@(?:app|bp|blueprint)\.(route|get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/gi,
  ],
  // Express: app.get("/path"), router.post("/path")
  express: [
    /(?:app|router)\.(get|post|put|delete|patch|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  ],
  // Next.js API routes (file-based)
  nextjs: null, // Handled separately via file paths
  // Hono: app.get("/path")
  hono: [
    /(?:app|hono)\.(get|post|put|delete|patch|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  ],
  // Koa: router.get("/path")
  koa: [
    /router\.(get|post|put|delete|patch|all)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
  ],
};

// File extensions to scan
const SCAN_EXTENSIONS = ['.py', '.js', '.ts', '.jsx', '.tsx', '.mjs'];

// Directories to skip
const SKIP_DIRS = [
  'node_modules',
  '.git',
  '__pycache__',
  'venv',
  '.venv',
  'dist',
  'build',
  '.next',
  '.cache',
  '.nvm',
  '.npm',
  '.yarn',
  '.pnpm-store',
];
const MAX_FILES = 2000;
const ROUTE_CACHE_TTL_MS = 10000;
const routeCache = new Map();

/**
 * Recursively find all relevant files in a directory
 */
function findFiles(dir, files = []) {
  try {
    if (files.length >= MAX_FILES) return files;
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.includes(entry.name)) {
          findFiles(fullPath, files);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCAN_EXTENSIONS.includes(ext)) {
          files.push(fullPath);
        }
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }

  return files;
}

/**
 * Detect framework from file content/path
 */
function detectFramework(filePath, content) {
  const ext = path.extname(filePath).toLowerCase();

  // Python files
  if (ext === '.py') {
    if (content.includes('from fastapi') || content.includes('import fastapi')) {
      return 'fastapi';
    }
    if (content.includes('from flask') || content.includes('import flask')) {
      return 'flask';
    }
  }

  // JavaScript/TypeScript files
  if (['.js', '.ts', '.jsx', '.tsx', '.mjs'].includes(ext)) {
    if (content.includes('express')) {
      return 'express';
    }
    if (content.includes('hono') || content.includes('Hono')) {
      return 'hono';
    }
    if (content.includes('@koa/router') || content.includes('koa-router')) {
      return 'koa';
    }
    // Check for Next.js API routes
    if (filePath.includes('/pages/api/') || filePath.includes('/app/api/')) {
      return 'nextjs';
    }
  }

  return null;
}

/**
 * Extract routes from file content
 */
function extractRoutes(filePath, content, framework) {
  const routes = [];

  // Handle Next.js file-based routing
  if (framework === 'nextjs') {
    const routePath = extractNextjsRoute(filePath);
    if (routePath) {
      // Check for HTTP method exports
      const methods = [];
      if (/export\s+(async\s+)?function\s+GET/i.test(content)) methods.push('GET');
      if (/export\s+(async\s+)?function\s+POST/i.test(content)) methods.push('POST');
      if (/export\s+(async\s+)?function\s+PUT/i.test(content)) methods.push('PUT');
      if (/export\s+(async\s+)?function\s+DELETE/i.test(content)) methods.push('DELETE');
      if (/export\s+(async\s+)?function\s+PATCH/i.test(content)) methods.push('PATCH');

      // Default handler for pages/api style
      if (methods.length === 0 && /export\s+default/.test(content)) {
        methods.push('ALL');
      }

      for (const method of methods) {
        routes.push({
          method,
          path: routePath,
          file: filePath,
          framework,
        });
      }
    }
    return routes;
  }

  // Apply regex patterns for the framework
  const patterns = ROUTE_PATTERNS[framework];
  if (!patterns) return routes;

  for (const pattern of patterns) {
    // Reset regex state
    pattern.lastIndex = 0;
    let match;

    while ((match = pattern.exec(content)) !== null) {
      const methodToken = match[2] ? match[1] : null;
      const method = methodToken ? methodToken.toUpperCase() : 'ALL';
      const routePath = match[2] || match[1];

      // Skip if path looks like a variable
      if (routePath && !routePath.startsWith('{') && !routePath.includes('${')) {
        routes.push({
          method: method === 'ROUTE' ? 'ALL' : method,
          path: routePath,
          file: filePath,
          framework,
        });
      }
    }
  }

  return routes;
}

/**
 * Extract API route path from Next.js file path
 */
function extractNextjsRoute(filePath) {
  // Handle app router: /app/api/users/route.ts -> /api/users
  let match = filePath.match(/[/\\]app([/\\]api[/\\].+?)[/\\]route\.(ts|js|tsx|jsx)$/);
  if (match) {
    return match[1].replace(/\\/g, '/').replace(/\/\[([^\]]+)\]/g, '/:$1');
  }

  // Handle pages router: /pages/api/users.ts -> /api/users
  match = filePath.match(/[/\\]pages([/\\]api[/\\].+?)\.(ts|js|tsx|jsx)$/);
  if (match) {
    let route = match[1].replace(/\\/g, '/');
    // Handle index files
    route = route.replace(/\/index$/, '');
    // Handle dynamic routes [id] -> :id
    route = route.replace(/\/\[([^\]]+)\]/g, '/:$1');
    return route || '/api';
  }

  return null;
}

/**
 * Scan a directory for API routes
 */
async function scanRoutes(projectPath) {
  const routes = [];

  if (!projectPath || !fs.existsSync(projectPath)) {
    return routes;
  }
  const cached = routeCache.get(projectPath);
  if (cached && Date.now() - cached.timestamp < ROUTE_CACHE_TTL_MS) {
    return cached.routes;
  }

  const files = findFiles(projectPath);

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const framework = detectFramework(filePath, content);

      if (framework) {
        const fileRoutes = extractRoutes(filePath, content, framework);
        routes.push(...fileRoutes);
      }
    } catch (err) {
      // Skip files we can't read
    }
  }

  // Deduplicate routes
  const seen = new Set();
  const uniqueRoutes = routes.filter(route => {
    const key = `${route.method}:${route.path}:${route.file}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  routeCache.set(projectPath, { timestamp: Date.now(), routes: uniqueRoutes });
  return uniqueRoutes;
}

/**
 * Match routes to a service based on port/process
 */
function matchRoutesToService(routes, service) {
  if (!service.projectPath) return [];
  const normalizedProjectPath = path.resolve(service.projectPath);

  const serviceFrameworks = new Set();
  const command = (service.command || '').toLowerCase();
  const name = (service.name || '').toLowerCase();

  if (command.includes('fastapi') || command.includes('uvicorn')) serviceFrameworks.add('fastapi');
  if (command.includes('flask')) serviceFrameworks.add('flask');
  if (command.includes('express')) serviceFrameworks.add('express');
  if (command.includes('koa')) serviceFrameworks.add('koa');
  if (command.includes('hono')) serviceFrameworks.add('hono');
  if (command.includes('next')) serviceFrameworks.add('nextjs');
  if (command.includes('node') && command.includes('express')) serviceFrameworks.add('express');
  if (name.includes('python') && command.includes('fastapi')) serviceFrameworks.add('fastapi');
  if (name.includes('python') && command.includes('flask')) serviceFrameworks.add('flask');

  const serviceRoutes = [];

  for (const route of routes) {
    if (!route.file) continue;
    const routePath = path.resolve(route.file);
    if (!routePath.startsWith(`${normalizedProjectPath}${path.sep}`)) continue;
    if (serviceFrameworks.size > 0 && route.framework && !serviceFrameworks.has(route.framework)) continue;
    if (serviceFrameworks.size === 0) {
      const fileName = path.basename(routePath).toLowerCase();
      if (!command.includes(fileName) && !command.includes(routePath.toLowerCase())) continue;
    }
    serviceRoutes.push({
      method: route.method,
      path: route.path,
    });
  }

  return serviceRoutes;
}

module.exports = {
  scanRoutes,
  matchRoutesToService,
  findFiles,
  detectFramework,
};
