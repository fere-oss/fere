const fs = require('fs');
const path = require('path');

// Patterns for different frameworks
const ROUTE_PATTERNS = {
  // FastAPI: @app.get("/path"), @videos_router.post("/path"), @router.api_route(...)
  fastapi: [
    /@(?:[A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|delete|patch|head|options)\s*\(\s*["']([^"']+)["']/gi,
    /@(?:[A-Za-z_][A-Za-z0-9_]*)\.(api_route)\s*\(\s*["']([^"']+)["'](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/gi,
  ],
  // Flask: @app.route("/path", methods=["GET"]) or @users_bp.get("/path")
  // Captures: 1=decorator type, 2=path, 3=optional methods list
  flask: [
    /@(?:[A-Za-z_][A-Za-z0-9_]*)\.(route|get|post|put|delete|patch)\s*\(\s*["']([^"']+)["'](?:\s*,\s*methods\s*=\s*\[([^\]]+)\])?/gi,
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
  // Plain Node.js http server with object-based routes: "GET /path": handler
  // Matches patterns like: "GET /", "POST /users", 'DELETE /items/:id'
  'node-http': [
    /["'](GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|ALL)\s+(\/[^"']*)["']\s*:/gi,
  ],
  // Gin: r.GET("/path", handler), router.POST("/path", handler)
  gin: [
    /\w+\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["`]([^"`]+)["`]/g,
  ],
  // Echo: e.GET("/path", handler), echo.POST("/path", handler)
  echo: [
    /\w+\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*["`]([^"`]+)["`]/g,
  ],
  // Chi: r.Get("/path", handler), r.Post("/path", handler)
  // Chi also supports r.MethodFunc("GET", "/path", handler)
  chi: [
    /\w+\.(Get|Post|Put|Delete|Patch)\s*\(\s*["`]([^"`]+)["`]/g,
    /\w+\.MethodFunc\s*\(\s*["`](GET|POST|PUT|DELETE|PATCH)["`]\s*,\s*["`]([^"`]+)["`]/g,
  ],
  // Rails: get '/path', post '/path', etc. in config/routes.rb
  rails: [
    /(get|post|put|patch|delete)\s+['"]([^'"]+)['"]/gi,
  ],
  // Django: path('route/', view) — handled separately (no HTTP methods in URL patterns)
  django: null,
  // Spring Boot: @GetMapping("/path"), @PostMapping("/path"), etc.
  // @RequestMapping is handled separately in extractRoutes()
  spring: [
    /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["']/gi,
  ],
  // Laravel: Route::get('/path', ...), Route::post('/path', ...), etc.
  laravel: [
    /Route::(get|post|put|patch|delete)\s*\(\s*['"]([^'"]+)['"]/gi,
  ],
  // Fiber: app.Get("/path", handler), app.Post("/path", handler)
  fiber: [
    /\w+\.(Get|Post|Put|Delete|Patch)\s*\(\s*["`]([^"`]+)["`]/g,
  ],
};

// File extensions to scan — Set for O(1) lookup in hot path
const SCAN_EXTENSIONS = new Set(['.py', '.js', '.ts', '.jsx', '.tsx', '.mjs', '.go', '.rb', '.java', '.php']);

// Directories to skip — Set for O(1) lookup in hot path
const SKIP_DIRS = new Set([
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
  'vendor',
  'tmp',
  'log',
  'target',
  'storage',
]);
const MAX_FILES = 2000;
// OPTIMIZATION: Extended cache TTL from 10s to 2min
// Route definitions rarely change during active development,
// so longer caching significantly reduces filesystem I/O
const ROUTE_CACHE_TTL_MS = 120000; // 2 minutes (was 10 seconds)
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
        if (!SKIP_DIRS.has(entry.name)) {
          findFiles(fullPath, files);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SCAN_EXTENSIONS.has(ext)) {
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
    if (content.includes('from django.urls') || content.includes('from django.conf.urls')) {
      return 'django';
    }
  }

  // Ruby files
  if (ext === '.rb') {
    if (content.includes('routes.draw')) {
      return 'rails';
    }
  }

  // Go files
  if (ext === '.go') {
    if (content.includes('github.com/gin-gonic/gin')) return 'gin';
    if (content.includes('github.com/labstack/echo')) return 'echo';
    if (content.includes('github.com/go-chi/chi')) return 'chi';
    if (content.includes('github.com/gofiber/fiber')) return 'fiber';
  }

  // Java files
  if (ext === '.java') {
    if (content.includes('org.springframework.web') || content.includes('Mapping')) {
      if (/@(?:Get|Post|Put|Delete|Patch|Request)Mapping/.test(content)) return 'spring';
    }
  }

  // PHP files
  if (ext === '.php') {
    if (content.includes('Route::')) return 'laravel';
  }

  // JavaScript/TypeScript files
  if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx' || ext === '.mjs') {
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
    // Plain Node.js HTTP server - must have http.createServer (not just require('http') which could be a client)
    if (content.includes('http.createServer')) {
      return 'node-http';
    }
  }

  return null;
}

/**
 * Extract routes from file content
 */
function extractRoutes(filePath, content, framework) {
  const routes = [];

  // Handle Django URL patterns (no HTTP methods in urlpatterns)
  if (framework === 'django') {
    const pathPattern = /path\s*\(\s*['"]([^'"]*)['"]/g;
    const rePathPattern = /re_path\s*\(\s*r?['"]([^'"]*)['"]/g;

    let match;
    while ((match = pathPattern.exec(content)) !== null) {
      let routePath = match[1];
      // Clean up regex anchors for display
      routePath = routePath.replace(/^\^/, '').replace(/\$$/, '');
      const normalizedPath = routePath.startsWith('/') ? routePath : '/' + routePath;
      routes.push({ method: 'ALL', path: normalizedPath, file: filePath, framework });
    }
    while ((match = rePathPattern.exec(content)) !== null) {
      let routePath = match[1];
      // Clean up regex anchors for display
      routePath = routePath.replace(/^\^/, '').replace(/\$$/, '');
      const normalizedPath = routePath.startsWith('/') ? routePath : '/' + routePath;
      routes.push({ method: 'ALL', path: normalizedPath, file: filePath, framework });
    }
    return routes;
  }

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
      const decoratorType = match[1]?.toUpperCase();
      const routePath = match[2] || match[1];
      const methodsParam = match[3]; // Optional methods=['GET', 'POST'] for Flask

      // Skip if path looks like a variable
      if (!routePath || routePath.startsWith('{') || routePath.includes('${')) {
        continue;
      }

      // Handle Flask and FastAPI api_route decorators with methods= parameter
      if (framework === 'flask' && decoratorType === 'ROUTE') {
        if (methodsParam) {
          // Parse methods like "'GET', 'POST'" or '"GET", "POST"'
          const methods = methodsParam.match(/['"](\w+)['"]/g)
            ?.map(m => m.replace(/['"]/g, '').toUpperCase()) || ['GET'];
          for (const method of methods) {
            routes.push({ method, path: routePath, file: filePath, framework });
          }
        } else {
          // @app.route() without methods= defaults to GET
          routes.push({ method: 'GET', path: routePath, file: filePath, framework });
        }
      } else if (framework === 'fastapi' && decoratorType === 'API_ROUTE') {
        if (methodsParam) {
          const methods = methodsParam.match(/['"](\w+)['"]/g)
            ?.map(m => m.replace(/['"]/g, '').toUpperCase()) || ['GET'];
          for (const method of methods) {
            routes.push({ method, path: routePath, file: filePath, framework });
          }
        } else {
          routes.push({ method: 'GET', path: routePath, file: filePath, framework });
        }
      } else {
        // For @app.get(), @app.post(), etc. or other frameworks
        const method = decoratorType === 'ROUTE' || decoratorType === 'ALL' ? 'ALL' : decoratorType;
        routes.push({ method, path: routePath, file: filePath, framework });
      }
    }
  }

  // Handle Spring Boot @RequestMapping (method is optional, defaults to ALL)
  if (framework === 'spring') {
    const rmPattern = /@RequestMapping\s*\(\s*(?:value\s*=\s*)?["']([^"']+)["'](?:[^)]*method\s*=\s*RequestMethod\.(\w+))?/g;
    let rmMatch;
    while ((rmMatch = rmPattern.exec(content)) !== null) {
      const routePath = rmMatch[1];
      const method = rmMatch[2] ? rmMatch[2].toUpperCase() : 'ALL';
      if (routePath && !routePath.startsWith('{') && !routePath.includes('${')) {
        routes.push({ method, path: routePath, file: filePath, framework });
      }
    }
  }

  // Handle Laravel Route::resource and Route::apiResource
  if (framework === 'laravel') {
    const resourcePattern = /Route::(?:api)?[Rr]esource\s*\(\s*['"]([^'"]+)['"]/g;
    let resMatch;
    while ((resMatch = resourcePattern.exec(content)) !== null) {
      const name = resMatch[0].includes('apiResource') || resMatch[0].includes('apiR')
        ? resMatch[1] : resMatch[1];
      const basePath = name.startsWith('/') ? name : '/' + name;
      const isApi = resMatch[0].includes('api');
      routes.push({ method: 'GET', path: basePath, file: filePath, framework });
      routes.push({ method: 'POST', path: basePath, file: filePath, framework });
      routes.push({ method: 'GET', path: `${basePath}/{id}`, file: filePath, framework });
      routes.push({ method: 'PUT', path: `${basePath}/{id}`, file: filePath, framework });
      routes.push({ method: 'DELETE', path: `${basePath}/{id}`, file: filePath, framework });
      if (!isApi) {
        routes.push({ method: 'GET', path: `${basePath}/create`, file: filePath, framework });
        routes.push({ method: 'GET', path: `${basePath}/{id}/edit`, file: filePath, framework });
      }
    }
  }

  // Handle Rails root and resources directives (after regex extraction of explicit routes)
  if (framework === 'rails') {
    // root 'controller#action' or root to: 'controller#action'
    if (/root\s+(?:to:\s*)?['"][^'"]+['"]/.test(content)) {
      routes.push({ method: 'GET', path: '/', file: filePath, framework });
    }

    // resources :name generates standard CRUD routes
    const resourcesPattern = /resources\s+:(\w+)(?:\s*,\s*only:\s*\[([^\]]*)\])?/g;
    let resMatch;
    while ((resMatch = resourcesPattern.exec(content)) !== null) {
      const name = resMatch[1];
      const onlyParam = resMatch[2];
      const actions = onlyParam
        ? onlyParam.match(/:(\w+)/g)?.map(a => a.slice(1)) || []
        : ['index', 'show', 'create', 'update', 'destroy'];

      for (const action of actions) {
        if (action === 'index') routes.push({ method: 'GET', path: `/${name}`, file: filePath, framework });
        if (action === 'show') routes.push({ method: 'GET', path: `/${name}/:id`, file: filePath, framework });
        if (action === 'create') routes.push({ method: 'POST', path: `/${name}`, file: filePath, framework });
        if (action === 'update') routes.push({ method: 'PATCH', path: `/${name}/:id`, file: filePath, framework });
        if (action === 'destroy') routes.push({ method: 'DELETE', path: `/${name}/:id`, file: filePath, framework });
      }
    }

    // resource :name (singular) generates routes without :id
    const resourcePattern = /resource\s+:(\w+)(?:\s*,\s*only:\s*\[([^\]]*)\])?/g;
    let singMatch;
    while ((singMatch = resourcePattern.exec(content)) !== null) {
      const name = singMatch[1];
      const onlyParam = singMatch[2];
      const actions = onlyParam
        ? onlyParam.match(/:(\w+)/g)?.map(a => a.slice(1)) || []
        : ['show', 'create', 'update', 'destroy'];

      for (const action of actions) {
        if (action === 'show') routes.push({ method: 'GET', path: `/${name}`, file: filePath, framework });
        if (action === 'create') routes.push({ method: 'POST', path: `/${name}`, file: filePath, framework });
        if (action === 'update') routes.push({ method: 'PATCH', path: `/${name}`, file: filePath, framework });
        if (action === 'destroy') routes.push({ method: 'DELETE', path: `/${name}`, file: filePath, framework });
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

// Guardrail: only attach API routes to service types that can actually
// expose application endpoints. Hoisted to module level to avoid Set recreation per call.
const API_ELIGIBLE_TYPES = new Set([
  'backend',
  'frontend',
  'nodejs',
  'python',
  'service',
  'webserver',
]);

/**
 * Match routes to a service based on port/process
 */
function matchRoutesToService(routes, service) {
  if (!service.projectPath) return [];
  const normalizedProjectPath = path.resolve(service.projectPath);
  const serviceType = String(service.type || '').toLowerCase();

  if (serviceType && !API_ELIGIBLE_TYPES.has(serviceType)) {
    return [];
  }

  const serviceFrameworks = new Set();
  const command = (service.command || '').toLowerCase();
  const name = (service.name || '').toLowerCase();

  if (command.includes('fastapi') || command.includes('uvicorn')) serviceFrameworks.add('fastapi');
  if (command.includes('flask')) serviceFrameworks.add('flask');
  // uwsgi/gunicorn are Python WSGI servers — treat as Flask/Python API
  if (command.includes('uwsgi') || command.includes('gunicorn')) serviceFrameworks.add('flask');
  if (command.includes('express')) serviceFrameworks.add('express');
  if (command.includes('koa')) serviceFrameworks.add('koa');
  if (command.includes('hono')) serviceFrameworks.add('hono');
  if (command.includes('next')) serviceFrameworks.add('nextjs');
  if (command.includes('node') && command.includes('express')) serviceFrameworks.add('express');
  if (name.includes('python') && command.includes('fastapi')) serviceFrameworks.add('fastapi');
  if (name.includes('python') && command.includes('flask')) serviceFrameworks.add('flask');
  // Plain Node.js HTTP servers
  if (command.includes('node') && !command.includes('express') && !command.includes('next')) {
    serviceFrameworks.add('node-http');
    // Most Node API services are Express-based even when command line
    // does not include the framework name explicitly.
    serviceFrameworks.add('express');
  }
  // Go services: framework names rarely appear in command line (compiles to binary),
  // so add all Go frameworks and let route-level framework tags handle filtering.
  // `go run .` exec-replaces itself with a temp binary under a /go-build/ path.
  if (command.includes('go run') || command.includes('go build') || command.includes('/go-build')) {
    serviceFrameworks.add('gin');
    serviceFrameworks.add('echo');
    serviceFrameworks.add('chi');
    serviceFrameworks.add('fiber');
  }
  // Django
  if (command.includes('django') || command.includes('manage.py')) serviceFrameworks.add('django');
  // uwsgi/gunicorn can also serve Django — add django alongside flask
  if (command.includes('uwsgi') || command.includes('gunicorn')) serviceFrameworks.add('django');
  // Rails
  if (command.includes('rails') || command.includes('puma') || command.includes('unicorn') ||
      command.includes('passenger')) serviceFrameworks.add('rails');
  // Spring Boot
  if (command.includes('spring') || command.includes('java') || command.includes('mvn') ||
      command.includes('gradle')) serviceFrameworks.add('spring');
  // Laravel
  if (command.includes('artisan') || command.includes('laravel') || command.includes('php')) serviceFrameworks.add('laravel');

  const serviceRoutes = [];

  for (const route of routes) {
    if (!route.file) continue;
    const routePath = path.resolve(route.file);
    if (!routePath.startsWith(`${normalizedProjectPath}${path.sep}`)) continue;
    if (serviceFrameworks.size > 0 && route.framework && !serviceFrameworks.has(route.framework)) continue;

    // For node-http routes (plain Node.js servers), require the command to reference the actual file
    // This prevents routes from one Node file being matched to a different Node process
    if (route.framework === 'node-http') {
      const fileName = path.basename(routePath).toLowerCase();
      if (!command.includes(fileName) && !command.includes(routePath.toLowerCase())) continue;
    }

    if (serviceFrameworks.size === 0) {
      const fileName = path.basename(routePath).toLowerCase();
      if (!command.includes(fileName) && !command.includes(routePath.toLowerCase())) continue;
    }
    serviceRoutes.push({
      method: route.method,
      path: route.path,
      framework: route.framework || null,
    });
  }

  return serviceRoutes;
}

function getRouteCacheTimestamp(projectPath) {
  const cached = routeCache.get(projectPath);
  return cached ? cached.timestamp : null;
}

function clearRouteCache(projectPath) {
  if (projectPath) {
    routeCache.delete(projectPath);
  } else {
    routeCache.clear();
  }
}

module.exports = {
  scanRoutes,
  matchRoutesToService,
  findFiles,
  detectFramework,
  getRouteCacheTimestamp,
  clearRouteCache,
};
