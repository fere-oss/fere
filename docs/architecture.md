# Fere Architecture and Feature Breakdown

## 1. Product Scope (Current)
Fere is a macOS Electron desktop app that maps and monitors local development environments in near real time.

Primary capabilities currently in the product:
- Service topology graph from live process/port/connection data
- Health status tracking per service (`active`, `idle`, `down`)
- API route discovery from project source trees
- External API/provider detection from source + env files
- Multi-project tabbing (`macOS`/system + per-project views)
- Docker container visibility (containers, networks, health)
- Unified multi-container log streaming view
- In-app API testing with cURL builder and persisted request history
- Database tooling for containerized DBs + remote URI mode (MongoDB/PostgreSQL)

---

## 2. High-Level Architecture

### 2.1 Runtime Layers
- Renderer (`React`):
  - UI composition, graph rendering, feature tabs, request builder, DB views
  - Receives system snapshots and deltas via preload API
- Main process (`Electron`):
  - Owns all OS-level and privileged operations
  - Exposes IPC handlers for monitoring, control actions, Docker, DB, logs
- Worker thread (`worker_threads`):
  - Offloads CPU-heavy graph structure/metrics computation
- Host tools/services:
  - `ps`, `lsof`, Docker CLI, DB clients

### 2.2 Core Data Flow
1. Main process collects raw runtime data (processes, listening ports, established TCP connections, Docker snapshot).
2. Snapshot scheduler decides full structure rebuild vs metrics-only overlay.
3. Worker computes/updates graph nodes + edges.
4. Main process emits full/delta snapshot events to renderer.
5. Renderer applies deltas and updates graph + side panels.
6. On-demand scans (routes, external APIs) enrich displayed services.

---

## 3. Frontend Architecture (Renderer)

## 3.1 Top-level Navigation (`src/App.tsx`)
Fere currently has four main modes:
- `Service Map`
- `Containers`
  - `Overview` sub-tab
  - `Logs` sub-tab
- `Requests`
- `Database`

The graph mode additionally has project tabs:
- `macOS` system tab (`__system__`)
- One tab per discovered `projectPath`

Tab metadata includes:
- Service count
- Inferred stack summary (e.g., Next + backend framework + DB/cache/broker labels)

### 3.2 Graph Experience (`src/components/GraphView.tsx` + `src/components/graph/*`)
Current behavior:
- Hierarchical layered layout with stable ordering across refreshes
- Grouping of related nodes
- Standalone service section
- Node detail panel with process/service metadata
- Edge bundling for readability
- Hover-highlight of immediate downstream dependencies
- Context menu actions
- Data freshness indicator (snapshot age by source)

Performance-oriented behavior currently implemented:
- Push-based delta updates (not full redraw polling only)
- Topology-aware layout caching
- Node measurement locking/unlocking strategy
- Viewport-based node culling
- `onlyRenderVisibleElements` for React Flow
- Reduced zoom-time rerender pressure in node rendering

### 3.3 Node Cards / Details
Service cards include:
- Health state
- Type badge
- Name + brand icon (Logo.dev-backed)
- Port(s)
- Optional project label
- Optional API routes (capped preview)
- Optional external APIs (capped preview)

Node detail drawer includes:
- Health and last seen
- Process details (PID, user, CPU/memory, command)
- Project metadata/path
- Database inline viewer for DB nodes
- Container health checks (when available)
- External APIs list (provider/host entries)

### 3.4 Sidebar (`src/components/ServiceSidebar.tsx`)
- Service list with quick actions
- Open service URL / open project terminal
- Kill process action
- Service metadata quick view (PID/command/etc.)

### 3.5 Requests / cURL Builder (`src/components/CurlBuilder.tsx`)
Current feature set:
- Service and route selection from discovered graph services
- Method/path/header/body composition
- Raw cURL generation + syntax-highlighted display
- Edit mode for manual cURL, parse back into UI model
- Execute request in-app via main-process HTTP handler
- Response panel with status, duration, size, headers, body
- JSON-aware response formatting
- Request history (load/replay/clear)

### 3.6 Containers View
- Overview graph scoped to running Docker containers
- Logs sub-tab using unified multi-container stream

### 3.7 Container Logs (`src/components/ContainerLogsTab.tsx`)
Current behavior:
- Select one/many containers to stream
- Start/stop streams per container
- Unified timeline with per-container color coding
- Log level detection (`error`, `warn`, `info`, `debug`)
- Search filter (regex-capable)
- Level filter dropdown
- Pause/resume, follow mode, copy, clear
- Buffering + periodic flush for rendering performance
- Stream lifecycle handling (data/error/close)

### 3.8 Database UX (`src/components/database/*`, `DatabaseListView`, `DatabasePage`)
Current feature set:
- Database list from running DB containers
- Data tab: tables/collections + preview
- Query tab: multi-query tabs, keyboard execution shortcut
- Table creation flow
- Row deletion and table/collection deletion flows
- DB-specific placeholders and formatting
- Local storage for recent remote URIs

Remote URI mode currently supports:
- MongoDB URI connect/test/query/read
- PostgreSQL URI connect/test/query/read
- URI status feedback (`idle/testing/ok/error`)

---

## 4. Main Process Architecture (`electron/main.js`)

### 4.1 Window + Security Bootstrapping
- Creates BrowserWindow with hardened webPreferences:
  - `contextIsolation: true`
  - `nodeIntegration: false`
  - `sandbox: true`
  - `webSecurity: true`
- Applies navigation/window-open restrictions
- Applies CSP policy per env (dev/prod)

### 4.2 IPC Surface (Current)
Main groups of handlers:
- Monitoring:
  - `get-system-snapshot`, `start-snapshot-stream`, `stop-snapshot-stream`
  - `get-dev-processes`, `get-all-processes`, `get-listening-ports`, `get-connections`, `get-connection-graph`
- Graph enrichment:
  - `get-external-apis`
- Service/container control:
  - `kill-process`, `stop-container`
- Quick actions:
  - `open-url`, `open-terminal`
- API testing:
  - `execute-http-request`
- Request history:
  - `load-request-history`, `save-request-history`, `clear-request-history`
- Docker:
  - `is-docker-available`, `get-docker-containers`, `get-docker-networks`, `get-docker-snapshot`
- Database:
  - container DB operations (`get-database-tables`, `get-table-data`, `execute-database-query`, `create-database-table`)
  - remote URI operations for Mongo/Postgres
- Container logs streaming:
  - start/stop per stream, stop per container, stop all
  - emits `container-log-data`, `container-log-error`, `container-log-close`

---

## 5. Monitoring and Graph Pipeline

### 5.1 Snapshot Generation (`electron/services/systemSnapshot.js`)
Per snapshot:
- Gather in parallel:
  - dev processes
  - listening ports
  - established connections
- Build graph structure
- Attach freshness metadata (`collectedAt`, source-age fields)

### 5.2 Scheduler (`electron/services/snapshotScheduler.js`)
Event-driven push model with tiered refresh:
- Fast probe (~1.5s): lightweight PID/port change detection
- Metrics reconcile (~5s): frequent updates when topology unchanged
- Forced/full structure refresh (~10s or topology change)

Includes:
- Worker offload for CPU-heavy graph work
- Pending snapshot buffering/backpressure handling
- Delta generation and sequence tracking

### 5.3 Graph Builder (`connectionGraph.js` + `graphFunctions.js`)
Core responsibilities:
- Process categorization (frontend/backend/db/cache/broker/etc.)
- Known service naming and descriptions
- Project path inference from cwd/commands
- Route matching to service eligibility
- Docker container merge into graph model
- Overlay resource/health metrics

### 5.4 Health Tracking (`healthTracker.js`)
- Derives service health from process/listener/connection activity
- Feeds node status (`green/yellow/red` style mapping)

---

## 6. Discovery Engines

### 6.1 API Route Scanner (`electron/services/routeScanner.js`)
Framework detection and route extraction currently covers:
- FastAPI
- Flask
- Express
- Next.js (file-based API routing)
- Koa
- Hono
- Plain Node HTTP servers

Behavior:
- Recursive scan with extension + directory filters
- Route cache (TTL)
- Framework-aware matching to services
- Service-type guardrails (only API-capable node types)

### 6.2 External API Scanner (`electron/services/externalApiScanner.js`)
Detection inputs:
- Source files across multiple languages
- `.env*` files
- Provider catalog (`config/api-providers.json`) + optional user overrides (`~/.fere/api-providers.json`)

Matching signals:
- URL host extraction
- Provider domain matching
- SDK pattern matching
- Env var pattern matching

Current noise controls:
- Skip local/private/test hosts
- Skip malformed/template hosts
- Ignore blocked hosts (e.g., `example.com`, fonts hosts)
- Skip system package-manager roots (`/opt/homebrew`, etc.)
- Filter env-only/sdk-only weak matches unless corroborated

---

## 7. Docker and Logs

### 7.1 Docker Monitor (`electron/services/dockerMonitor.js`)
Current behavior:
- Availability check via Docker CLI
- Container enumeration (`docker ps -a` JSON format)
- Inspect-based enrichment:
  - networks
  - mounts
  - health state/check history
  - mapped/exposed ports
- Network snapshot support
- Container stop operation
- Short-lived caching for expensive Docker calls

### 7.2 Container Log Streaming (`electron/services/containerLogs.js`)
- Starts `docker logs` streams per container
- Emits normalized log events to renderer
- Supports stopping individual streams, per-container streams, or all streams

---

## 8. Database Subsystem (`electron/services/databaseQuery.js` + renderer DB pages)

Containerized DB operations:
- Detect DB type from image
- List tables/collections
- Fetch table/collection data (with limits)
- Execute queries/commands
- Create tables (where supported)

Remote URI mode:
- MongoDB URI connect/read/query
- PostgreSQL URI connect/read/query
- URI-mode state handling in renderer (connect/disconnect/test/recent URIs)

---

## 9. Security Model (Current)

### 9.1 Electron Hardening
- `contextIsolation` enabled
- Renderer sandboxed
- No Node integration in renderer
- New windows denied by default
- Disallowed navigation blocked

### 9.2 URL / Request Validation (`electron/security.js`)
- External URL open restricted to `http/https`
- Dangerous protocols blocked (`file:`, `javascript:`, `data:`, etc.)
- HTTP request validation with SSRF protections available
- Localhost/private access intentionally allowed for API tester local-dev use case
- Response size cap on in-app HTTP tester (`MAX_RESPONSE_SIZE`)

### 9.3 CSP
- Session-level CSP applied in dev/prod
- Explicit allowances for app needs (fonts, localhost dev, Logo.dev image host)

---

## 10. Data Contracts and Types
`src/types/electron.d.ts` defines shared contracts for:
- Process, port, connection, graph node/edge
- Snapshot + delta payloads
- Docker data models
- External API entities
- Database query/table results
- Container logs payloads
- Preload API surface (`window.electronAPI`)

---

## 11. State and Persistence

Renderer state:
- View mode and selected tab
- Selected service/database/container context
- Container logs UI filters and stream selection
- cURL/request composition and output tabs

Persistence currently used:
- Request history persisted via main process service
- Recent remote DB URIs in localStorage

---

## 12. Performance Characteristics (Current)

Implemented optimizations include:
- Push-based snapshot deltas
- Worker-thread offload for graph computation
- Tiered refresh (fast probe/metrics/structure)
- Topology-aware layout cache
- Batched CWD lookups and TTL caches
- Route/API scan caching
- Graph virtualization and visible-element rendering
- Log buffering and capped log retention

---

## 13. Current Feature Checklist
- Service map with dependency edges
- Health indicators and freshness metadata
- Process/port/command metadata views
- Project-based graph tabs + system tab
- API route discovery and per-service display
- External API/provider detection
- Logo-driven brand icons for services/APIs
- Container graph, details, and stop action
- Unified live container logs
- API tester + cURL editor + history
- Database explorer/query/create/delete for container DBs
- Remote MongoDB/PostgreSQL URI mode
- Open in browser, open terminal, kill process quick actions

---

## 14. Source Map (Where Features Live)
- App shell and tab orchestration: `src/App.tsx`
- System snapshot hook + delta patching: `src/hooks/useSystemMonitor.ts`
- Graph rendering/layout: `src/components/GraphView.tsx`, `src/components/graph/*`
- Sidebar actions: `src/components/ServiceSidebar.tsx`
- Requests/cURL: `src/components/CurlBuilder.tsx`
- Container logs UI: `src/components/ContainerLogsTab.tsx`
- Database UI/state: `src/components/DatabaseListView.tsx`, `src/components/DatabasePage.tsx`, `src/components/database/*`
- Main process + IPC: `electron/main.js`
- Preload bridge: `electron/preload.js`
- Security layer: `electron/security.js`
- Monitoring services: `electron/services/systemSnapshot.js`, `electron/services/snapshotScheduler.js`, `electron/services/connectionGraph.js`, `electron/services/graphFunctions.js`
- Discovery services: `electron/services/routeScanner.js`, `electron/services/externalApiScanner.js`
- Docker/log/db services: `electron/services/dockerMonitor.js`, `electron/services/containerLogs.js`, `electron/services/databaseQuery.js`
- API provider config: `config/api-providers.json`
