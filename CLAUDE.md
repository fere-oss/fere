# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Fere?

Fere is a macOS Electron desktop app that visualizes local development environments in real time. It monitors processes, ports, TCP connections, and Docker containers to render a live service topology graph with health tracking, API route discovery, database tooling, and AI-powered investigation agents.

## Development Commands

```bash
npm install                  # Install dependencies
npm run electron:dev         # Run React + Electron concurrently (primary dev workflow, port 3001)
npm run start                # React dev server only (port 3000)
npm run build                # React production build
npm run typecheck            # TypeScript type checking (tsc --noEmit)
npm run test                 # React/Jest unit tests (interactive watch mode)
npm run test:node            # Node-side service tests (electron/services/*.test.js, electron/security.test.js)
npm run release:check        # Pre-release gate: typecheck + test:node + build
npm run electron:build:mac   # Build macOS DMG installer
```

Run a single Jest test: `npm run test -- --testPathPattern=MyComponent`

Node tests use Node's built-in test runner: `node --test electron/services/someService.test.js`

Integration tests live in `test/` — run `sh test/start-all.sh` or `cd test/docker-test && sh start.sh`.

## Architecture

### Runtime Layers

**Renderer (React + TypeScript)** — Sandboxed browser context (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`). Communicates with main process exclusively through the preload bridge (`window.electronAPI`). Entry: `src/index.tsx` → `src/App.tsx`.

**Main Process (Electron/Node)** — Owns all privileged OS operations (`ps`, `lsof`, Docker CLI, DB clients, AI agents). Exposes IPC handlers for monitoring, control actions, HTTP requests, Docker, database, log streaming, and AI investigation. Entry: `electron/main.js`.

**Worker Thread** — `electron/workers/graphBuilder.worker.js` offloads CPU-heavy graph node/edge computation from the main thread.

### Core Data Flow

1. Main process collects raw data in parallel (processes via `ps`, ports/connections via `lsof`, Docker snapshot)
2. `snapshotScheduler.js` runs tiered refresh: fast probe (~1.5s) → metrics overlay (~5s) → full structure rebuild (~10s or on topology change)
3. Worker thread builds/updates graph nodes and edges
4. Main emits full or delta snapshots to renderer via push events
5. `useSystemMonitor.ts` hook applies deltas and triggers React re-renders only on topology changes
6. On-demand scans (routes, external APIs) enrich displayed services

### IPC Communication Pattern

The renderer never accesses Node/OS APIs directly. All privileged operations go through:

- `electron/preload.js` — exposes `window.electronAPI` via Electron's contextBridge (~50 IPC channels)
- `electron/main.js` — registers `ipcMain.handle()` handlers for each operation
- `src/types/electron.d.ts` — single source of truth for TypeScript contracts (~738 lines)

IPC channels are organized by feature: system monitoring (6), Docker/containers (9), database operations (11), control actions (4), API testing (5), preferences (6), snapshot streaming (3), and AI agents (9).

### Key Source Locations

| Area                                 | Files                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| App shell, view modes, tabs          | `src/App.tsx`                                                                                         |
| Snapshot delta patching              | `src/hooks/useSystemMonitor.ts`                                                                       |
| Graph rendering + layout             | `src/components/GraphView.tsx`, `src/components/graph/*`                                              |
| API tester / cURL builder            | `src/components/CurlBuilder.tsx`                                                                      |
| Container logs UI                    | `src/components/ContainerLogsTab.tsx`                                                                 |
| Database UI                          | `src/components/DatabaseListView.tsx`, `src/components/DatabasePage.tsx`, `src/components/database/*` |
| AI investigation UI                  | `src/components/DebugPanel.tsx`                                                                       |
| Service checklist/tracking           | `src/components/checklist/*`                                                                          |
| Main process + IPC handlers          | `electron/main.js`                                                                                    |
| Preload bridge (renderer API)        | `electron/preload.js`                                                                                 |
| Security (URL validation, CSP, SSRF) | `electron/security.js`                                                                                |
| Snapshot collection                  | `electron/services/systemSnapshot.js`                                                                 |
| Event-driven scheduler               | `electron/services/snapshotScheduler.js`                                                              |
| Graph construction                   | `electron/services/connectionGraph.js`, `electron/services/graphFunctions.js`                         |
| Route discovery                      | `electron/services/routeScanner.js`                                                                   |
| External API detection               | `electron/services/externalApiScanner.js`                                                             |
| Docker monitoring                    | `electron/services/dockerMonitor.js`                                                                  |
| Container log streaming              | `electron/services/containerLogs.js`                                                                  |
| Database queries                     | `electron/services/databaseQuery.js` (PostgreSQL, MySQL, MongoDB, Elasticsearch)                      |
| AI agents                            | `electron/services/debugAgent.js`, `electron/services/queryAgent.js`, `electron/services/explainAgent.js` |
| Request tracing                      | `electron/services/traceCapture.js`                                                                   |
| Shared type contracts                | `src/types/electron.d.ts`                                                                             |
| API provider catalog                 | `config/api-providers.json`                                                                           |

### Monitoring Services

Each service in `electron/services/` has a focused responsibility with TTL caching:

- `portMonitor.js` / `processMonitor.js` — enumerate ports and processes via OS commands
- `healthTracker.js` — derive service health states (active/idle/down → green/yellow/red)
- `routeScanner.js` — scan source trees for API routes (FastAPI, Flask, Express, Next.js, Koa, Hono)
- `externalApiScanner.js` — detect external API usage from source + `.env` files, matched against `config/api-providers.json`

### AI Agent Architecture

Three OpenAI-powered agents provide investigation capabilities:

- **debugAgent** (gpt-4o, max 20 iterations) — Investigates runtime issues with tools: `fire_request`, `read_source_file`, `grep_source`, `get_container_logs`, `run_database_query`, etc. Streams progress events (thinking → tool_call → tool_result → diagnosis_delta → complete).
- **queryAgent** (gpt-4.1) — Answers topology questions about the current service graph. Returns structured results with references and optimization signals.
- **explainAgent** (gpt-4.1) — Quick one-shot service role explanation.

All agents receive the current graph snapshot as context. IPC channels: `debugStart`/`debugStop`/`debugFollowUp`, `queryStart`/`queryStop`, `explainService`. Progress streams via `onDebugProgress`/`onQueryProgress` event channels.

Requires `OPENAI_API_KEY` in `.env` (managed via `debugSetApiKey`/`debugGetApiKeyStatus` IPC channels).

### Four UI Modes

1. **Service Map** — live topology graph with project tabs (system + per-project)
2. **Containers** — Docker container graph + unified log streaming
3. **Requests** — API tester with cURL builder, execution, and history
4. **Database** — container DB explorer + remote MongoDB/PostgreSQL URI mode

## Environment Variables

The `.env` file in the project root:

| Variable                     | Purpose                                    |
| ---------------------------- | ------------------------------------------ |
| `BROWSER=none` | Prevents auto-opening browser in dev mode |
| `REACT_APP_SENTRY_DSN` | Sentry error tracking DSN |
| `REACT_APP_LOGO_DEV_TOKEN` | Logo.dev API for service icons |
| `OPENAI_API_KEY` | Required for AI investigation agents |

## Platform Constraints

- **macOS only** — relies on `lsof` and `ps` output formats specific to macOS
- **Docker optional** — container, log, and DB features require Docker Desktop
- Electron renderer is sandboxed; all OS access goes through IPC

## Tech Stack

- React 19 + TypeScript (renderer), strict mode tsconfig targeting ES5
- Electron 40 (main process, plain JS)
- React Flow (graph visualization)
- react-window (list virtualization)
- react-markdown + rehype-highlight (AI agent output rendering)
- `pg` (PostgreSQL client for remote DB)
- @sentry/electron (error tracking)
- posthog-js / posthog-node (analytics)
- react-scripts / CRA (build tooling)
- electron-builder (app packaging)
- ESLint via react-app preset (configured in package.json)
