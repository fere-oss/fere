const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { scanRoutes, matchRoutesToService } = require('./routeScanner');

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fere-routes-'));
  return dir;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, 'utf8');
}

test('scanRoutes tags frameworks and matchRoutesToService filters by project path and framework', async () => {
  const projectDir = makeTempProject();
  const externalDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'app.py'),
      [
        'from flask import Flask',
        'app = Flask(__name__)',
        '@app.route("/health", methods=["GET"])',
        'def health():',
        '    return "ok"',
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'server.js'),
      [
        "const express = require('express')",
        'const app = express()',
        "app.get('/api/items', (req, res) => res.send('ok'))",
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'app/api/users/route.ts'),
      [
        'export async function GET() {',
        '  return new Response("ok")',
        '}',
      ].join('\n')
    );

    writeFile(
      path.join(externalDir, 'external.js'),
      [
        "const express = require('express')",
        'const app = express()',
        "app.get('/outside', (req, res) => res.send('ok'))",
      ].join('\n')
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(routes.length >= 3, 'expected routes from multiple frameworks');
    assert.ok(routes.some(r => r.framework === 'flask'), 'expected flask routes');
    assert.ok(routes.some(r => r.framework === 'express'), 'expected express routes');
    assert.ok(routes.some(r => r.framework === 'nextjs'), 'expected nextjs routes');

    const externalRoutes = await scanRoutes(externalDir);
    const combined = routes.concat(externalRoutes);

    const flaskService = {
      projectPath: projectDir,
      command: 'python -m flask run',
      name: 'python',
    };
    const flaskRoutes = matchRoutesToService(combined, flaskService);
    assert.ok(flaskRoutes.every(r => r.path === '/health'), 'expected only flask routes');

    const expressService = {
      projectPath: projectDir,
      command: 'node server.js --express',
      name: 'node',
    };
    const expressRoutes = matchRoutesToService(combined, expressService);
    assert.ok(expressRoutes.every(r => r.path === '/api/items'), 'expected only express routes');

    const expressByFileService = {
      projectPath: projectDir,
      command: 'node server.js',
      name: 'node',
    };
    const expressByFileRoutes = matchRoutesToService(combined, expressByFileService);
    assert.ok(expressByFileRoutes.every(r => r.path === '/api/items'), 'expected routes to match by file name');

    const nextService = {
      projectPath: projectDir,
      command: 'next dev',
      name: 'node',
    };
    const nextRoutes = matchRoutesToService(combined, nextService);
    assert.ok(nextRoutes.every(r => r.path === '/api/users'), 'expected only nextjs routes');

    const noProjectService = {
      projectPath: null,
      command: 'python app.py',
      name: 'python',
    };
    const emptyRoutes = matchRoutesToService(combined, noProjectService);
    assert.equal(emptyRoutes.length, 0, 'expected no routes without projectPath');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test('scanRoutes detects Gin routes and matchRoutesToService filters correctly', async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'main.go'),
      [
        'package main',
        '',
        'import "github.com/gin-gonic/gin"',
        '',
        'func main() {',
        '  r := gin.Default()',
        '  r.GET("/api/users", getUsers)',
        '  r.POST("/api/users", createUser)',
        '  r.PUT("/api/users/:id", updateUser)',
        '  r.DELETE("/api/users/:id", deleteUser)',
        '}',
      ].join('\n')
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(routes.length === 4, `expected 4 gin routes, got ${routes.length}`);
    assert.ok(routes.every(r => r.framework === 'gin'), 'expected all routes tagged as gin');
    assert.ok(routes.some(r => r.method === 'GET' && r.path === '/api/users'), 'expected GET /api/users');
    assert.ok(routes.some(r => r.method === 'POST' && r.path === '/api/users'), 'expected POST /api/users');
    assert.ok(routes.some(r => r.method === 'PUT' && r.path === '/api/users/:id'), 'expected PUT with param');
    assert.ok(routes.some(r => r.method === 'DELETE' && r.path === '/api/users/:id'), 'expected DELETE with param');

    const goService = {
      projectPath: projectDir,
      command: 'go run main.go',
      name: 'go',
    };
    const matched = matchRoutesToService(routes, goService);
    assert.equal(matched.length, 4, 'expected all 4 gin routes matched to go run service');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('scanRoutes detects Echo routes with dynamic params', async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'server.go'),
      [
        'package main',
        '',
        'import "github.com/labstack/echo/v4"',
        '',
        'func main() {',
        '  e := echo.New()',
        '  e.GET("/api/items", listItems)',
        '  e.POST("/api/items", createItem)',
        '  e.DELETE("/api/items/:id", deleteItem)',
        '}',
      ].join('\n')
    );

    const routes = await scanRoutes(projectDir);
    assert.equal(routes.length, 3, `expected 3 echo routes, got ${routes.length}`);
    assert.ok(routes.every(r => r.framework === 'echo'), 'expected all routes tagged as echo');
    assert.ok(routes.some(r => r.method === 'GET' && r.path === '/api/items'), 'expected GET /api/items');
    assert.ok(routes.some(r => r.method === 'DELETE' && r.path === '/api/items/:id'), 'expected DELETE with :id param');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('scanRoutes detects Chi routes including MethodFunc', async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'routes.go'),
      [
        'package main',
        '',
        'import "github.com/go-chi/chi/v5"',
        '',
        'func main() {',
        '  r := chi.NewRouter()',
        '  r.Get("/api/posts", listPosts)',
        '  r.Post("/api/posts", createPost)',
        '  r.Put("/api/posts/{id}", updatePost)',
        '  r.Patch("/api/posts/{id}", patchPost)',
        '  r.MethodFunc("DELETE", "/api/posts/{id}", deletePost)',
        '}',
      ].join('\n')
    );

    const routes = await scanRoutes(projectDir);
    assert.equal(routes.length, 5, `expected 5 chi routes, got ${routes.length}`);
    assert.ok(routes.every(r => r.framework === 'chi'), 'expected all routes tagged as chi');
    assert.ok(routes.some(r => r.method === 'GET' && r.path === '/api/posts'), 'expected GET /api/posts');
    assert.ok(routes.some(r => r.method === 'POST' && r.path === '/api/posts'), 'expected POST /api/posts');
    assert.ok(routes.some(r => r.method === 'PUT' && r.path === '/api/posts/{id}'), 'expected PUT with {id}');
    assert.ok(routes.some(r => r.method === 'PATCH' && r.path === '/api/posts/{id}'), 'expected PATCH with {id}');
    assert.ok(routes.some(r => r.method === 'DELETE' && r.path === '/api/posts/{id}'), 'expected DELETE via MethodFunc');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test('Go frameworks are isolated per file and go run matches all Go frameworks', async () => {
  const projectDir = makeTempProject();
  const externalDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, 'gin_api.go'),
      [
        'package main',
        'import "github.com/gin-gonic/gin"',
        'func setupGin(r *gin.Engine) {',
        '  r.GET("/gin/health", health)',
        '}',
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'echo_api.go'),
      [
        'package handlers',
        'import "github.com/labstack/echo/v4"',
        'func setupEcho(e *echo.Echo) {',
        '  e.POST("/echo/data", postData)',
        '}',
      ].join('\n')
    );

    writeFile(
      path.join(projectDir, 'chi_api.go'),
      [
        'package handlers',
        'import "github.com/go-chi/chi/v5"',
        'func setupChi(r chi.Router) {',
        '  r.Put("/chi/resource", putResource)',
        '}',
      ].join('\n')
    );

    writeFile(
      path.join(externalDir, 'outside.go'),
      [
        'package main',
        'import "github.com/gin-gonic/gin"',
        'func main() {',
        '  r := gin.Default()',
        '  r.GET("/outside", handler)',
        '}',
      ].join('\n')
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(routes.some(r => r.framework === 'gin'), 'expected gin routes');
    assert.ok(routes.some(r => r.framework === 'echo'), 'expected echo routes');
    assert.ok(routes.some(r => r.framework === 'chi'), 'expected chi routes');

    const externalRoutes = await scanRoutes(externalDir);
    const combined = routes.concat(externalRoutes);

    const goService = {
      projectPath: projectDir,
      command: 'go run .',
      name: 'go',
    };
    const matched = matchRoutesToService(combined, goService);
    assert.equal(matched.length, 3, 'expected 3 routes from project (not external)');
    assert.ok(matched.some(r => r.framework === 'gin' && r.path === '/gin/health'), 'expected gin route');
    assert.ok(matched.some(r => r.framework === 'echo' && r.path === '/echo/data'), 'expected echo route');
    assert.ok(matched.some(r => r.framework === 'chi' && r.path === '/chi/resource'), 'expected chi route');
    assert.ok(!matched.some(r => r.path === '/outside'), 'expected no external routes');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});
