# Fere — Architecture

Fere is a macOS Electron desktop app that maps and monitors local development environments in real time. It collects live data from the OS (processes, ports, TCP connections) and Docker to render a topology graph, track health, discover API routes, and surface runtime issues through the Sentinel engine.

---

## Runtime layers

### Renderer (React + TypeScript)

Sandboxed browser context. Never accesses OS APIs directly.

- Receives system snapshots and deltas through the preload bridge (`window.electronAPI`)
- Owns all UI composition: topology graph, Sentinel panel, Requests tab, Database tab, Containers tab
- Entry: `src/index.tsx` → `src/App.tsx`

### Main process (Electron/Node)

Owns all privileged operations — process enumeration, port scanning, Docker CLI, DB clients, HTTP execution.

- Exposes IPC handlers for every privileged action
- Runs the snapshot scheduler and graph builder worker
- Entry: `electron/main.js`

### Worker thread

`electron/workers/graphBuilder.worker.js` offloads CPU-heavy graph node and edge computation off the main thread. Receives raw snapshots, returns structured graph data with cached topology.

### Preload bridge

`electron/preload.js` exposes `window.electronAPI` to the renderer via Electron's `contextBridge`. This is the only communication channel between renderer and main process. Its shape is defined as a TypeScript contract in `src/types/electron.d.ts`.

---

## Core data flow

```
┌─────────────────────────────────────────────────────────┐
│                     Main Process                         │
│                                                          │
│  OS commands  ──►  systemSnapshot  ──►  snapshotScheduler│
│  (ps, lsof)         (parallel          (tiered cadence)  │
│  Docker CLI          collection)              │          │
│                                               ▼          │
│                                       graphBuilder.worker│
│                                       (structure + delta)│
│                                               │          │
│                                               ▼          │
│                              emit: snapshot-delta event  │
└───────────────────────────────────────────┬─────────────┘
                                            │ IPC / preload bridge
                                            ▼
┌─────────────────────────────────────────────────────────┐
│                      Renderer                            │
│                                                          │
│  useSystemMonitor  ──►  apply delta  ──►  React state   │
│  (onSnapshotDelta)       (topology          │            │
│                           or metrics)       ▼            │
│                                        GraphView         │
│                                        AgentPanel        │
│                                        CurlBuilder       │
│                                        ContainerLogsTab  │
│                                        DatabasePage      │
└─────────────────────────────────────────────────────────┘
```

**Snapshot cadence (tiered):**

| Tier | Interval | Trigger |
|------|----------|---------|
| Fast probe | ~1.5 s | PID/port change detection |
| Metrics overlay | ~5 s | Frequent updates when topology is stable |
| Full structure rebuild | ~10 s | Forced, or on topology change |

On-demand scans (route discovery, external API detection) enrich the graph independently.

---

## Frontend structure

### Navigation (`src/App.tsx`)

Four top-level modes:

| Mode | Description |
|------|-------------|
| Service Map | Live topology graph with project tabs |
| Containers | Docker container graph + unified log streaming |
| Requests | API tester with cURL builder, execution, and history |
| Database | Container DB explorer + remote MongoDB/PostgreSQL URI mode |

The Service Map additionally has per-project tabs: a system tab (`__system__`) and one tab per discovered `projectPath`.

### Graph (`src/components/GraphView.tsx`, `src/components/graph/*`)

- Hierarchical layered layout with stable ordering across refreshes
- Node grouping, edge bundling, viewport culling, `onlyRenderVisibleElements`
- Push-based delta updates — not full-redraw polling
- Topology-aware layout cache
- Hover-highlight of immediate downstream dependencies
- Context menu actions (kill, open in browser, open terminal, trace request)

### Sentinel panel (`src/components/AgentPanel.tsx`)

See [Sentinel capabilities](./AI_AGENT_CAPABILITIES.md) for behavioral detail.

- Findings-first layout: issues ranked by severity and blast radius
- Background rescans on topology change and on interval
- Executable fix actions (kill-port, restart-container) and copy-only guidance
- No chat history as primary UX

### API tester (`src/components/CurlBuilder.tsx`)

- Service and route selection from the live graph
- Method, path, headers, body composition
- Raw cURL generation and syntax-highlighted display
- In-app request execution with response panel
- Request history with load/replay

### Container logs (`src/components/ContainerLogsTab.tsx`)

- Multi-container selection, per-container color coding
- Unified timeline with log-level detection
- Search filter (regex), level filter, pause/resume, follow mode
- Buffering and periodic flush for rendering performance

### Database (`src/components/database/*`, `DatabaseListView`, `DatabasePage`)

- Container DB list with tables/collections and data preview
- Multi-tab query editor with keyboard execution shortcut
- Table/collection creation and deletion
- Remote URI mode: MongoDB, PostgreSQL

---

## Main process architecture

### Security bootstrapping (`electron/main.js`, `electron/security.js`)

`BrowserWindow` is created with hardened `webPreferences`:

```js
contextIsolation: true
nodeIntegration: false
sandbox: true
webSecurity: true
```

- Navigation to non-`file://` origins is blocked
- `window.open` is intercepted and denied
- Dangerous protocols (`file:`, `javascript:`, `data:`, `vbscript:`) are blocked for external opens
- CSP applied via session-level `webRequest` hook (separate policies for dev and production)
- SSRF protection in the HTTP request handler — private/loopback IPs blocked unless explicitly allowed

### IPC surface

Handlers are registered in `electron/main.js`. The full surface is typed in `src/types/electron.d.ts` and exposed through `electron/preload.js`.

**Handler groups:**

| Group | Channels |
|-------|----------|
| Monitoring | `get-system-snapshot`, `start-snapshot-stream`, `stop-snapshot-stream`, `get-dev-processes`, `get-listening-ports`, `get-connections`, `get-connection-graph`, `get-environment-summary` |
| Discovery | `rescan-routes`, `get-external-apis`, `get-external-api-providers` |
| Process control | `kill-process`, `stop-container`, `start-container`, `restart-container`, `start-compose-project` |
| HTTP requests | `execute-http-request`, `execute-traced-request`, `load-request-history`, `save-request-history`, `clear-request-history` |
| Docker | `is-docker-available`, `get-docker-containers`, `get-docker-networks`, `get-docker-snapshot` |
| Container logs | `start-container-logs`, `stop-container-logs`, `stop-all-container-logs`, `get-container-log-tail` |
| Database | `get-database-tables`, `get-table-data`, `execute-database-query`, `create-database-table`, `connect-mongo-uri`, `connect-postgres-uri`, `connect-elasticsearch-uri` |
| Sentinel | `agent:scan`, `agent:apply-fix`, `agent:chat`, `agent:usage` |
| Auth | `auth:sign-in-github`, `auth:sign-in-google`, `auth:get-session`, `auth:sign-out` |
| Blueprint | `blueprint:save`, `blueprint:load`, `blueprint:check`, `blueprint:delete` |
| Settings | `get-network-policy`, `set-network-policy`, `get-alert-preferences`, `set-alert-preferences` |
| Sharing | `export-graph-file`, `publish-graph`, `update-shared-graph` |

---

## Monitoring and graph pipeline

### Snapshot collection (`electron/services/systemSnapshot.js`)

Per snapshot, collected in parallel:

- Dev processes via `ps`
- Listening ports via `lsof -i -P -n`
- Established TCP connections via `lsof -i -n`
- Docker snapshot via Docker CLI

### Snapshot scheduler (`electron/services/snapshotScheduler.js`)

Event-driven push model. Manages tiered cadence, worker restart on crash (max 5 attempts), delta generation, sequence tracking for gap detection in the renderer, and battery-state-aware interval multipliers.

### Graph builder (`electron/services/connectionGraph.js`, `electron/services/graphFunctions.js`)

Runs in the worker thread. Responsibilities:

- Process categorization (frontend, backend, db, cache, broker, etc.)
- Known service naming and brand icon inference
- Project path inference from process cwd and command args
- Docker container merge into the graph model
- Edge inference from TCP connections
- CPU/memory metrics overlay on existing nodes

### Health tracking (`electron/services/healthTracker.js`)

Derives `active` / `idle` / `down` health state from process, listener, and connection activity. Health state transitions fire `fere:health-degraded` CustomEvents consumed by the Sentinel engine.

---

## Discovery engines

### Route scanner (`electron/services/routeScanner.js`)

Recursively scans project source trees and extracts HTTP routes. Framework support:

- FastAPI, Flask
- Express, Koa, Hono, plain Node HTTP
- Next.js (file-based API routing)

Results are cached with TTL and matched to graph nodes by service type.

### External API scanner (`electron/services/externalApiScanner.js`)

Detects third-party API usage from:

- Source files (URL extraction, SDK pattern matching)
- `.env*` files (env var pattern matching)
- Provider catalog: `config/api-providers.json` and optional user overrides at `~/.fere/api-providers.json`

Noise controls skip local/private/test hosts, malformed patterns, and weak single-signal matches.

---

## Sentinel engine (`electron/services/sentinelEngine.js`)

Sentinel is Fere's deterministic runtime operator. It runs structured checks against the live snapshot and returns ranked `AgentFinding` objects.

For behavioral detail, check types, and UX contract, see [Sentinel capabilities](./AI_AGENT_CAPABILITIES.md).

**Scan output types:**

```typescript
AgentFinding {
  id: string
  severity: 'critical' | 'warning' | 'suggestion'
  category: 'health' | 'connectivity' | 'config' | 'security' | 'dependency'
  service: string
  summary: string
  detail: string
  impact: string | null
  affectedServices: string[]
  fix: AgentFixAction | null
}

AgentFixAction {
  type: 'kill-port' | 'restart-container' | 'copy-only' | 'write-file'
  // ...action-specific fields
}
```

---

## Docker and logs

### Docker monitor (`electron/services/dockerMonitor.js`)

- Availability check via Docker CLI
- Container enumeration (`docker ps -a` JSON)
- Inspect-based enrichment: networks, mounts, health state, mapped ports
- Container start/stop operations
- Short-lived TTL caching for expensive CLI calls

### Container log streaming (`electron/services/containerLogs.js`)

- Starts `docker logs --follow` streams per container
- Emits normalized `container-log-data` events to the renderer
- Manages stream lifecycle: start, stop per container, stop all

---

## Database subsystem

### `electron/services/databaseQuery.js`

Supports containerized databases (detected from Docker image name) and remote URI mode.

**Containerized operations:** list databases, list tables/collections, fetch data (with limits), execute queries, create tables.

**Remote URI mode:**

| Type | URI format |
|------|-----------|
| MongoDB | `mongodb://...` or `mongodb+srv://...` |
| PostgreSQL | `postgresql://...` or `postgres://...` |
| Elasticsearch | `http://...` or `https://...` (ES endpoint) |

---

## Request flow tracing

The trace feature fires an HTTP request and visualizes how it propagates through the local service graph by diffing TCP connections before and after. See [request-flow-tracing-spec.md](./request-flow-tracing-spec.md) for the full specification.

Backend service: `electron/services/traceCapture.js`

---

## Data contracts and types

`src/types/electron.d.ts` is the canonical type contract shared between the renderer and main process. It defines:

- `GraphNode`, `GraphEdge`, `SystemSnapshot`, `SnapshotDelta`
- `Process`, `ListeningPort`, `Connection`
- `DockerContainer`, `DockerNetwork`
- `AgentFinding`, `AgentFixAction`, `FixProposal`
- `TraceHop`, `TraceResult`
- `DatabaseTable`, `QueryResult`
- `ElectronAPI` — the full shape of `window.electronAPI`

**This contract is frozen during refactoring.** Channel names and method signatures must not change without coordinating both sides of the bridge.

---

## State and persistence

**Renderer state (in-memory):**

- View mode and selected tab
- Selected service, database, container context
- Container log filters and stream selection
- Request composition and output tabs

**Persisted state:**

| Data | Storage |
|------|---------|
| Request history | Main process (`electron/services/requestHistory.js`, disk JSON) |
| Alert preferences | `~/.fere/alert-preferences.json` |
| Recent remote DB URIs | Renderer `localStorage` |
| Blueprint | `.fere/blueprint.json` in project root (committable) |
| Activity log | `~/.fere/activity-log.json` |
| Metric history | In-memory ring buffer (`electron/services/metricHistory.js`) |

---

## Performance characteristics

| Optimization | Location |
|-------------|----------|
| Push-based snapshot deltas | `snapshotScheduler.js` + `useSystemMonitor.ts` |
| Worker-thread graph computation | `graphBuilder.worker.js` |
| Tiered refresh cadence | `snapshotScheduler.js` |
| Topology-aware layout cache | `src/components/graph/` |
| Batched CWD lookups with TTL | `graphFunctions.js` |
| Route and API scan caching | `routeScanner.js`, `externalApiScanner.js` |
| Viewport culling + visible-element rendering | `GraphView.tsx`, `graph/viewportCulling.ts` |
| Log buffering with capped retention | `ContainerLogsTab.tsx` |
| Adaptive snapshot interval (visibility + battery) | `snapshotScheduler.js` |

---

## Source map

| Area | Files |
|------|-------|
| App shell, view modes, tabs | `src/App.tsx` |
| Snapshot delta patching | `src/hooks/useSystemMonitor.ts` |
| Graph rendering + layout | `src/components/GraphView.tsx`, `src/components/graph/*` |
| Sentinel panel | `src/components/AgentPanel.tsx` |
| API tester / cURL builder | `src/components/CurlBuilder.tsx` |
| Container logs UI | `src/components/ContainerLogsTab.tsx` |
| Database UI | `src/components/DatabaseListView.tsx`, `src/components/DatabasePage.tsx`, `src/components/database/*` |
| Main process + IPC handlers | `electron/main.js` |
| Preload bridge | `electron/preload.js` |
| Security + SSRF protection | `electron/security.js` |
| Snapshot collection | `electron/services/systemSnapshot.js` |
| Snapshot scheduler | `electron/services/snapshotScheduler.js` |
| Graph construction | `electron/services/connectionGraph.js`, `electron/services/graphFunctions.js` |
| Sentinel engine | `electron/services/sentinelEngine.js` |
| Route discovery | `electron/services/routeScanner.js` |
| External API detection | `electron/services/externalApiScanner.js` |
| Docker monitoring | `electron/services/dockerMonitor.js` |
| Container log streaming | `electron/services/containerLogs.js` |
| Database queries | `electron/services/databaseQuery.js` |
| Request flow tracing | `electron/services/traceCapture.js` |
| Type contracts | `src/types/electron.d.ts` |
| API provider catalog | `config/api-providers.json` |
