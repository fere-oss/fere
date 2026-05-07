const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { scanRoutes, matchRoutesToService } = require("./routeScanner");

function makeTempProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fere-routes-"));
  return dir;
}

function writeFile(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, "utf8");
}

test("scanRoutes tags frameworks and matchRoutesToService filters by project path and framework", async () => {
  const projectDir = makeTempProject();
  const externalDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "app.py"),
      [
        "from flask import Flask",
        "app = Flask(__name__)",
        '@app.route("/health", methods=["GET"])',
        "def health():",
        '    return "ok"',
      ].join("\n"),
    );

    writeFile(
      path.join(projectDir, "server.js"),
      [
        "const express = require('express')",
        "const app = express()",
        "app.get('/api/items', (req, res) => res.send('ok'))",
      ].join("\n"),
    );

    writeFile(
      path.join(projectDir, "app/api/users/route.ts"),
      ["export async function GET() {", '  return new Response("ok")', "}"].join("\n"),
    );

    writeFile(
      path.join(externalDir, "external.js"),
      [
        "const express = require('express')",
        "const app = express()",
        "app.get('/outside', (req, res) => res.send('ok'))",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(routes.length >= 3, "expected routes from multiple frameworks");
    assert.ok(
      routes.some((r) => r.framework === "flask"),
      "expected flask routes",
    );
    assert.ok(
      routes.some((r) => r.framework === "express"),
      "expected express routes",
    );
    assert.ok(
      routes.some((r) => r.framework === "nextjs"),
      "expected nextjs routes",
    );

    const externalRoutes = await scanRoutes(externalDir);
    const combined = routes.concat(externalRoutes);

    const flaskService = {
      projectPath: projectDir,
      command: "python -m flask run",
      name: "python",
    };
    const flaskRoutes = matchRoutesToService(combined, flaskService);
    assert.ok(
      flaskRoutes.every((r) => r.path === "/health"),
      "expected only flask routes",
    );

    const expressService = {
      projectPath: projectDir,
      command: "node server.js --express",
      name: "node",
    };
    const expressRoutes = matchRoutesToService(combined, expressService);
    assert.ok(
      expressRoutes.every((r) => r.path === "/api/items"),
      "expected only express routes",
    );

    const expressByFileService = {
      projectPath: projectDir,
      command: "node server.js",
      name: "node",
    };
    const expressByFileRoutes = matchRoutesToService(combined, expressByFileService);
    assert.ok(
      expressByFileRoutes.every((r) => r.path === "/api/items"),
      "expected routes to match by file name",
    );

    const nextService = {
      projectPath: projectDir,
      command: "next dev",
      name: "node",
    };
    const nextRoutes = matchRoutesToService(combined, nextService);
    assert.ok(
      nextRoutes.every((r) => r.path === "/api/users"),
      "expected only nextjs routes",
    );

    const noProjectService = {
      projectPath: null,
      command: "python app.py",
      name: "python",
    };
    const emptyRoutes = matchRoutesToService(combined, noProjectService);
    assert.equal(emptyRoutes.length, 0, "expected no routes without projectPath");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Gin routes and matchRoutesToService filters correctly", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "main.go"),
      [
        "package main",
        "",
        'import "github.com/gin-gonic/gin"',
        "",
        "func main() {",
        "  r := gin.Default()",
        '  r.GET("/api/users", getUsers)',
        '  r.POST("/api/users", createUser)',
        '  r.PUT("/api/users/:id", updateUser)',
        '  r.DELETE("/api/users/:id", deleteUser)',
        "}",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(routes.length === 4, `expected 4 gin routes, got ${routes.length}`);
    assert.ok(
      routes.every((r) => r.framework === "gin"),
      "expected all routes tagged as gin",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/api/users"),
      "expected GET /api/users",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/api/users"),
      "expected POST /api/users",
    );
    assert.ok(
      routes.some((r) => r.method === "PUT" && r.path === "/api/users/:id"),
      "expected PUT with param",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/api/users/:id"),
      "expected DELETE with param",
    );

    const goService = {
      projectPath: projectDir,
      command: "go run main.go",
      name: "go",
    };
    const matched = matchRoutesToService(routes, goService);
    assert.equal(matched.length, 4, "expected all 4 gin routes matched to go run service");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Echo routes with dynamic params", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "server.go"),
      [
        "package main",
        "",
        'import "github.com/labstack/echo/v4"',
        "",
        "func main() {",
        "  e := echo.New()",
        '  e.GET("/api/items", listItems)',
        '  e.POST("/api/items", createItem)',
        '  e.DELETE("/api/items/:id", deleteItem)',
        "}",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.equal(routes.length, 3, `expected 3 echo routes, got ${routes.length}`);
    assert.ok(
      routes.every((r) => r.framework === "echo"),
      "expected all routes tagged as echo",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/api/items"),
      "expected GET /api/items",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/api/items/:id"),
      "expected DELETE with :id param",
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects FastAPI routes on custom APIRouter variable names", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "main.py"),
      [
        "from fastapi import FastAPI",
        "from app.routes import users_router",
        "app = FastAPI()",
        'app.include_router(users_router, prefix="/api/v1")',
        '@app.get("/health")',
        "def health():",
        '    return {"status": "ok"}',
      ].join("\n"),
    );

    writeFile(
      path.join(projectDir, "app", "routes.py"),
      [
        "from fastapi import APIRouter",
        'users_router = APIRouter(prefix="/users")',
        '@users_router.get("/")',
        "def list_users():",
        "    return []",
        '@users_router.post("/")',
        "def create_user():",
        '    return {"ok": True}',
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.some((r) => r.framework === "fastapi"),
      "expected fastapi routes",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/health"),
      "expected GET /health",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/"),
      "expected GET / on custom router var",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/"),
      "expected POST / on custom router var",
    );

    const fastapiService = {
      projectPath: projectDir,
      command: "uvicorn main:app --reload",
      name: "python",
    };
    const matched = matchRoutesToService(routes, fastapiService);
    assert.ok(
      matched.some((r) => r.path === "/health"),
      "expected /health matched to uvicorn service",
    );
    assert.ok(
      matched.some((r) => r.method === "POST" && r.path === "/"),
      "expected APIRouter route matched",
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Chi routes including MethodFunc", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "routes.go"),
      [
        "package main",
        "",
        'import "github.com/go-chi/chi/v5"',
        "",
        "func main() {",
        "  r := chi.NewRouter()",
        '  r.Get("/api/posts", listPosts)',
        '  r.Post("/api/posts", createPost)',
        '  r.Put("/api/posts/{id}", updatePost)',
        '  r.Patch("/api/posts/{id}", patchPost)',
        '  r.MethodFunc("DELETE", "/api/posts/{id}", deletePost)',
        "}",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.equal(routes.length, 5, `expected 5 chi routes, got ${routes.length}`);
    assert.ok(
      routes.every((r) => r.framework === "chi"),
      "expected all routes tagged as chi",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/api/posts"),
      "expected GET /api/posts",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/api/posts"),
      "expected POST /api/posts",
    );
    assert.ok(
      routes.some((r) => r.method === "PUT" && r.path === "/api/posts/{id}"),
      "expected PUT with {id}",
    );
    assert.ok(
      routes.some((r) => r.method === "PATCH" && r.path === "/api/posts/{id}"),
      "expected PATCH with {id}",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/api/posts/{id}"),
      "expected DELETE via MethodFunc",
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Go frameworks are isolated per file and go run matches all Go frameworks", async () => {
  const projectDir = makeTempProject();
  const externalDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "gin_api.go"),
      [
        "package main",
        'import "github.com/gin-gonic/gin"',
        "func setupGin(r *gin.Engine) {",
        '  r.GET("/gin/health", health)',
        "}",
      ].join("\n"),
    );

    writeFile(
      path.join(projectDir, "echo_api.go"),
      [
        "package handlers",
        'import "github.com/labstack/echo/v4"',
        "func setupEcho(e *echo.Echo) {",
        '  e.POST("/echo/data", postData)',
        "}",
      ].join("\n"),
    );

    writeFile(
      path.join(projectDir, "chi_api.go"),
      [
        "package handlers",
        'import "github.com/go-chi/chi/v5"',
        "func setupChi(r chi.Router) {",
        '  r.Put("/chi/resource", putResource)',
        "}",
      ].join("\n"),
    );

    writeFile(
      path.join(externalDir, "outside.go"),
      [
        "package main",
        'import "github.com/gin-gonic/gin"',
        "func main() {",
        "  r := gin.Default()",
        '  r.GET("/outside", handler)',
        "}",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.some((r) => r.framework === "gin"),
      "expected gin routes",
    );
    assert.ok(
      routes.some((r) => r.framework === "echo"),
      "expected echo routes",
    );
    assert.ok(
      routes.some((r) => r.framework === "chi"),
      "expected chi routes",
    );

    const externalRoutes = await scanRoutes(externalDir);
    const combined = routes.concat(externalRoutes);

    const goService = {
      projectPath: projectDir,
      command: "go run .",
      name: "go",
    };
    const matched = matchRoutesToService(combined, goService);
    assert.equal(matched.length, 3, "expected 3 routes from project (not external)");
    assert.ok(
      matched.some((r) => r.framework === "gin" && r.path === "/gin/health"),
      "expected gin route",
    );
    assert.ok(
      matched.some((r) => r.framework === "echo" && r.path === "/echo/data"),
      "expected echo route",
    );
    assert.ok(
      matched.some((r) => r.framework === "chi" && r.path === "/chi/resource"),
      "expected chi route",
    );
    assert.ok(!matched.some((r) => r.path === "/outside"), "expected no external routes");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(externalDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Rails explicit routes, root, and resources", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "config", "routes.rb"),
      [
        "Rails.application.routes.draw do",
        "  root 'home#index'",
        "  get '/health', to: 'health#show'",
        "  post '/api/login', to: 'sessions#create'",
        "  delete '/api/logout', to: 'sessions#destroy'",
        "  resources :users",
        "  resources :posts, only: [:index, :show, :create]",
        "  resource :profile, only: [:show, :update]",
        "end",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.every((r) => r.framework === "rails"),
      "expected all routes tagged as rails",
    );

    // Explicit routes
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/"),
      "expected root GET /",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/health"),
      "expected GET /health",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/api/login"),
      "expected POST /api/login",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/api/logout"),
      "expected DELETE /api/logout",
    );

    // resources :users (full CRUD = 5 routes)
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/users"),
      "expected GET /users (index)",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/users/:id"),
      "expected GET /users/:id (show)",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/users"),
      "expected POST /users (create)",
    );
    assert.ok(
      routes.some((r) => r.method === "PATCH" && r.path === "/users/:id"),
      "expected PATCH /users/:id (update)",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/users/:id"),
      "expected DELETE /users/:id (destroy)",
    );

    // resources :posts, only: [:index, :show, :create]
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/posts"),
      "expected GET /posts (index)",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/posts/:id"),
      "expected GET /posts/:id (show)",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/posts"),
      "expected POST /posts (create)",
    );
    assert.ok(
      !routes.some((r) => r.method === "PATCH" && r.path === "/posts/:id"),
      "expected no PATCH /posts/:id",
    );
    assert.ok(
      !routes.some((r) => r.method === "DELETE" && r.path === "/posts/:id"),
      "expected no DELETE /posts/:id",
    );

    // resource :profile, only: [:show, :update] (singular — no :id)
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/profile"),
      "expected GET /profile (show)",
    );
    assert.ok(
      routes.some((r) => r.method === "PATCH" && r.path === "/profile"),
      "expected PATCH /profile (update)",
    );
    assert.ok(
      !routes.some((r) => r.method === "DELETE" && r.path === "/profile"),
      "expected no DELETE /profile",
    );

    // Service matching
    const railsService = {
      projectPath: projectDir,
      command: "rails server -p 3000",
      name: "ruby",
    };
    const matched = matchRoutesToService(routes, railsService);
    assert.ok(matched.length > 0, "expected rails routes matched to rails service");
    assert.ok(
      matched.every((r) => r.framework === "rails"),
      "expected all matched routes to be rails",
    );

    const pumaService = {
      projectPath: projectDir,
      command: "puma -C config/puma.rb",
      name: "ruby",
    };
    const pumaMatched = matchRoutesToService(routes, pumaService);
    assert.ok(pumaMatched.length > 0, "expected rails routes matched to puma service");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Django path() and re_path() URL patterns", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "urls.py"),
      [
        "from django.urls import path, re_path",
        "from . import views",
        "",
        "urlpatterns = [",
        "    path('api/users/', views.user_list),",
        "    path('api/users/<int:pk>/', views.user_detail),",
        "    path('', views.index),",
        "    re_path(r'^articles/(?P<year>[0-9]{4})/$', views.year_archive),",
        "]",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.every((r) => r.framework === "django"),
      "expected all routes tagged as django",
    );
    assert.ok(
      routes.every((r) => r.method === "ALL"),
      "expected all django routes to have method ALL",
    );

    assert.ok(
      routes.some((r) => r.path === "/api/users/"),
      "expected /api/users/",
    );
    assert.ok(
      routes.some((r) => r.path === "/api/users/<int:pk>/"),
      "expected /api/users/<int:pk>/",
    );
    assert.ok(
      routes.some((r) => r.path === "/"),
      "expected root path /",
    );
    assert.ok(
      routes.some((r) => r.path === "/articles/(?P<year>[0-9]{4})/"),
      "expected re_path with regex",
    );

    // Service matching
    const djangoService = {
      projectPath: projectDir,
      command: "python manage.py runserver 0.0.0.0:8000",
      name: "python",
    };
    const matched = matchRoutesToService(routes, djangoService);
    assert.ok(matched.length > 0, "expected django routes matched to manage.py service");
    assert.ok(
      matched.every((r) => r.framework === "django"),
      "expected all matched routes to be django",
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("Django and Flask routes are isolated in mixed Python projects", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "flask_app.py"),
      [
        "from flask import Flask",
        "app = Flask(__name__)",
        '@app.get("/flask/health")',
        "def health():",
        '    return "ok"',
      ].join("\n"),
    );

    writeFile(
      path.join(projectDir, "django_urls.py"),
      [
        "from django.urls import path",
        "urlpatterns = [",
        "    path('django/health/', views.health),",
        "]",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.some((r) => r.framework === "flask" && r.path === "/flask/health"),
      "expected flask route",
    );
    assert.ok(
      routes.some((r) => r.framework === "django" && r.path === "/django/health/"),
      "expected django route",
    );

    const flaskService = {
      projectPath: projectDir,
      command: "flask run",
      name: "python",
    };
    const flaskRoutes = matchRoutesToService(routes, flaskService);
    assert.ok(
      flaskRoutes.every((r) => r.framework === "flask"),
      "expected flask service to only get flask routes",
    );

    const djangoService = {
      projectPath: projectDir,
      command: "python manage.py runserver",
      name: "python",
    };
    const djangoRoutes = matchRoutesToService(routes, djangoService);
    assert.ok(
      djangoRoutes.every((r) => r.framework === "django"),
      "expected django service to only get django routes",
    );
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Spring Boot annotations including @RequestMapping", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "UserController.java"),
      [
        "package com.example.demo;",
        "import org.springframework.web.bind.annotation.*;",
        "",
        "@RestController",
        '@RequestMapping("/api")',
        "public class UserController {",
        '    @GetMapping("/users")',
        "    public List<User> getUsers() { return users; }",
        "",
        '    @PostMapping("/users")',
        "    public User createUser() { return user; }",
        "",
        '    @PutMapping("/users/{id}")',
        "    public User updateUser() { return user; }",
        "",
        '    @DeleteMapping("/users/{id}")',
        "    public void deleteUser() {}",
        "",
        '    @RequestMapping(value = "/health", method = RequestMethod.GET)',
        '    public String health() { return "ok"; }',
        "",
        '    @RequestMapping("/status")',
        '    public String status() { return "ok"; }',
        "}",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.every((r) => r.framework === "spring"),
      "expected all routes tagged as spring",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/users"),
      "expected GET /users",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/users"),
      "expected POST /users",
    );
    assert.ok(
      routes.some((r) => r.method === "PUT" && r.path === "/users/{id}"),
      "expected PUT /users/{id}",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/users/{id}"),
      "expected DELETE /users/{id}",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/health"),
      "expected GET /health via @RequestMapping",
    );
    assert.ok(
      routes.some((r) => r.method === "ALL" && r.path === "/status"),
      "expected ALL /status via @RequestMapping without method",
    );

    const springService = {
      projectPath: projectDir,
      command: "java -jar app.jar",
      name: "java",
    };
    const matched = matchRoutesToService(routes, springService);
    assert.ok(matched.length > 0, "expected spring routes matched to java service");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Laravel routes and resources", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "routes", "api.php"),
      [
        "<?php",
        "use Illuminate\\Support\\Facades\\Route;",
        "",
        "Route::get('/health', [HealthController::class, 'index']);",
        "Route::post('/auth/login', [AuthController::class, 'login']);",
        "Route::delete('/auth/logout', [AuthController::class, 'logout']);",
        "Route::apiResource('posts', PostController::class);",
        "Route::resource('photos', PhotoController::class);",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.ok(
      routes.every((r) => r.framework === "laravel"),
      "expected all routes tagged as laravel",
    );

    // Explicit routes
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/health"),
      "expected GET /health",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/auth/login"),
      "expected POST /auth/login",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/auth/logout"),
      "expected DELETE /auth/logout",
    );

    // apiResource (5 routes, no create/edit)
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/posts"),
      "expected GET /posts (index)",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/posts"),
      "expected POST /posts (store)",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/posts/{id}"),
      "expected GET /posts/{id} (show)",
    );
    assert.ok(
      routes.some((r) => r.method === "PUT" && r.path === "/posts/{id}"),
      "expected PUT /posts/{id} (update)",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/posts/{id}"),
      "expected DELETE /posts/{id} (destroy)",
    );

    // resource (7 routes, includes create/edit)
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/photos/create"),
      "expected GET /photos/create",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/photos/{id}/edit"),
      "expected GET /photos/{id}/edit",
    );

    const laravelService = {
      projectPath: projectDir,
      command: "php artisan serve",
      name: "php",
    };
    const matched = matchRoutesToService(routes, laravelService);
    assert.ok(matched.length > 0, "expected laravel routes matched to artisan service");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});

test("scanRoutes detects Fiber routes and matches via go run", async () => {
  const projectDir = makeTempProject();

  try {
    writeFile(
      path.join(projectDir, "main.go"),
      [
        "package main",
        "",
        'import "github.com/gofiber/fiber/v2"',
        "",
        "func main() {",
        "  app := fiber.New()",
        '  app.Get("/api/users", getUsers)',
        '  app.Post("/api/users", createUser)',
        '  app.Delete("/api/users/:id", deleteUser)',
        "}",
      ].join("\n"),
    );

    const routes = await scanRoutes(projectDir);
    assert.equal(routes.length, 3, `expected 3 fiber routes, got ${routes.length}`);
    assert.ok(
      routes.every((r) => r.framework === "fiber"),
      "expected all routes tagged as fiber",
    );
    assert.ok(
      routes.some((r) => r.method === "GET" && r.path === "/api/users"),
      "expected GET /api/users",
    );
    assert.ok(
      routes.some((r) => r.method === "POST" && r.path === "/api/users"),
      "expected POST /api/users",
    );
    assert.ok(
      routes.some((r) => r.method === "DELETE" && r.path === "/api/users/:id"),
      "expected DELETE with :id",
    );

    const goService = {
      projectPath: projectDir,
      command: "go run main.go",
      name: "go",
    };
    const matched = matchRoutesToService(routes, goService);
    assert.equal(matched.length, 3, "expected all 3 fiber routes matched");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
