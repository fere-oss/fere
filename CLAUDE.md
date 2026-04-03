# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Fere?

Fere is a macOS Electron desktop app that visualizes local development environments in real time. It monitors processes, ports, TCP connections, and Docker containers to render a live service topology graph with health tracking, API route discovery, and database tooling.

**Current product direction:** Fere has shifted from "AI chat about your app" toward a **local-first runtime operator**. Sentinel scans the live stack, surfaces concrete failures/drift, ranks by impact, and offers focused fix actions. The moat is live runtime grounding — not general chat/code help.

## Development Commands

```bash
npm install                  # Install dependencies
npm run electron:dev         # Run React + Electron concurrently (primary dev workflow)
npm run start                # React dev server only (port 3000)
npm run build                # React production build
npm run test                 # React/Jest unit tests
npm run test:node            # Node-side service tests (electron/services/*.test.js)
npm run electron:build:mac   # Build macOS DMG installer
npm run typecheck            # Run after every change
```

Integration tests live in `test/` — run `sh test/start-all.sh` or `cd test/docker-test && sh start.sh`.

## Architecture

### Runtime Layers

**Renderer (React + TypeScript)** — Sandboxed browser context. Communicates with main process exclusively through the preload bridge (`window.electronAPI`). Entry: `src/index.tsx` → `src/App.tsx`.

**Main Process (Electron/Node)** — Owns all privileged OS operations (`ps`, `lsof`, Docker CLI, DB clients). Exposes IPC handlers for monitoring, control actions, HTTP requests, Docker, database, and log streaming. Entry: `electron/main.js`.

**Worker Thread** — `electron/workers/graphBuilder.worker.js` offloads CPU-heavy graph node/edge computation from the main thread.

### Core Data Flow

1. Main process collects raw data in parallel (processes via `ps`, ports/connections via `lsof`, Docker snapshot)
2. `snapshotScheduler.js` runs tiered refresh: fast probe (~1.5s) → metrics overlay (~5s) → full structure rebuild (~10s or on topology change)
3. Worker thread builds/updates graph nodes and edges
4. Main emits full or delta snapshots to renderer
5. `useSystemMonitor.ts` hook applies deltas and triggers React re-renders only on topology changes
6. On-demand scans (routes, external APIs) enrich displayed services

### Sentinel Architecture

Sentinel is the unified runtime operator surface (replaces the old Ask Fere + debugger split).

**Core abstractions:**

- `AgentFinding` — ranked issue with `severity`, `category`, `detail`, `impact`, `affected services`
- `AgentFixAction` — typed fix: either copy-only (guidance) or executable (safe automation)

**Scan behavior:**

- Full-stack scope (not tab-scoped)
- Background rescans on topology change and on interval
- Unread/new-finding signaling for proactive surface
- Deterministic/local-first checks run before any AI layer

**UI contract:**

- Findings-first layout: Issues → Suggestions
- No transcript, no prompt box, no chat history as primary UX
- CSS prefix: `agp-*`

### Key Source Locations

| Area                                 | Files                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| App shell, view modes, tabs          | `src/App.tsx`                                                                                         |
| Snapshot delta patching              | `src/hooks/useSystemMonitor.ts`                                                                       |
| Graph rendering + layout             | `src/components/GraphView.tsx`, `src/components/graph/*`                                              |
| API tester / cURL builder            | `src/components/CurlBuilder.tsx`                                                                      |
| Container logs UI                    | `src/components/ContainerLogsTab.tsx`                                                                 |
| Database UI                          | `src/components/DatabaseListView.tsx`, `src/components/DatabasePage.tsx`, `src/components/database/*` |
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
| Database queries                     | `electron/services/databaseQuery.js`                                                                  |
| Shared type contracts                | `src/types/electron.d.ts`                                                                             |
| API provider catalog                 | `config/api-providers.json`                                                                           |

### IPC Communication Pattern

The renderer never accesses Node/OS APIs directly. All privileged operations go through:

- `electron/preload.js` — exposes `window.electronAPI` via Electron's contextBridge
- `electron/main.js` — registers `ipcMain.handle()` handlers for each operation
- `src/types/electron.d.ts` — defines the TypeScript contracts shared between both sides

### Monitoring Services

Each service in `electron/services/` has a focused responsibility with TTL caching:

- `portMonitor.js` / `processMonitor.js` — enumerate ports and processes via OS commands
- `healthTracker.js` — derive service health states (active/idle/down)
- `routeScanner.js` — scan source trees for API routes (FastAPI, Flask, Express, Next.js, Koa, Hono)
- `externalApiScanner.js` — detect external API usage from source + `.env` files, matched against `config/api-providers.json`

### Four UI Modes

1. **Service Map** — live topology graph with project tabs (system + per-project)
2. **Containers** — Docker container graph + unified log streaming
3. **Requests** — API tester with cURL builder, execution, and history
4. **Database** — container DB explorer + remote MongoDB/PostgreSQL URI mode

## Platform Constraints

- **macOS only** — relies on `lsof` and `ps` output formats specific to macOS
- **Docker optional** — container, log, and DB features require Docker Desktop
- Electron renderer is sandboxed with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`

## Tech Stack

- React 19 + TypeScript (renderer)
- Electron 40 (main process)
- React Flow (graph visualization)
- `pg` (PostgreSQL client for remote DB)
- react-scripts / CRA (build tooling)
- electron-builder (app packaging)
- `openai` SDK present in deps but **not active** — Sentinel is deterministic/local-first

## Rules

### Always

- Use typed IPC contracts through `preload.js` + `src/types/electron.d.ts`
- Keep Sentinel more useful than Codex/Claude by grounding it in live runtime state
- Sort and surface highest-severity, largest-blast-radius issues first
- Prefer specific evidence, ranked findings, and direct actions over prose summaries
- Make service focus center the graph without opening unrelated overlays
- Use plain surfaces with app-consistent fonts, text sizes, spacing, and color tokens
- Use `useMemo`/`useCallback` around heavy graph derivations and renderer computations
- Use `CustomEvent` bridges for cross-component graph actions (focus/highlight)
- Clean up dead code/docs when product direction changes — mark old specs as historical explicitly
- Run `npm run typecheck` after every change
- Re-read the exact ask before acting; partial compliance is not acceptable
- Give feedback ordered by actual impact; be direct and scoped

### Never

- Build Sentinel as a generic chatbot (no history transcript, no prompt box as primary UX)
- Ship multiple overlapping AI surfaces for the same job
- Expose internal/generated prompts in the UI
- Make the Sentinel panel look stylistically separate from the app shell
- Use gradients or "AI-brand" styling on Sentinel
- Use `disable-frame-rate-limit` — removed due to screenshot/perf concerns
- Force `GraphView` remounts on tab switch via `key={selectedTab}`
- Optimize for "chat feel" — optimize for "operator usefulness"
- Add work for a hidden state that no longer exists in the product
- Leave stale planning docs pretending an old direction is current

### Performance

- Do not enable dense hover adjacency work above node threshold
- Clear hover timers when hover effect is disabled
- Avoid forced GraphView remounts on tab switch

## Current State & Next Steps

**Recently completed:**

- Unified Ask Fere + debugger into single Sentinel surface
- Full-stack scan scope (not tab-scoped)
- Background rescans on topology change and interval
- Unread/new-finding signaling
- Fixed: background notification styling conflicting with unreviewed indicator on Sentinel trigger

**In progress / not yet implemented:**

- Incident-change tracking (new / worsened / resolved state transitions)
- Stronger escalation for critical background findings
- Verify-after-fix loop before clearing an issue
- Durable incident/history memory
- Deeper investigation handoff to AI — only when deterministic checks are insufficient

**Next planned steps:**

1. Add incident state transitions
2. Add higher-signal proactive escalation for critical findings
3. Add verification loops after fix application
4. Narrow evidence-based AI layer — secondary path only, after deterministic findings

> Specs in `specs/` that predate the Sentinel unification should be treated as **historical**, not live product truth.
