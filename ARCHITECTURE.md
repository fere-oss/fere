# Architecture overview

Fere is a macOS Electron application. The two sides — renderer and main process — communicate exclusively through a typed IPC bridge. This document explains the runtime layers, the IPC bridge pattern, and where to find things in the source tree.

## Runtime layers

```
┌────────────────────────────────────────────────────────────────────┐
│  Renderer (React + TypeScript)                                     │
│  - sandboxed browser context (nodeIntegration: false)             │
│  - all state lives in React hooks                                  │
│  - calls OS APIs only via window.electronAPI                       │
└───────────────────┬────────────────────────────────────────────────┘
                    │  contextBridge (window.electronAPI)
                    │  electron/preload.js
                    │
┌───────────────────▼────────────────────────────────────────────────┐
│  Main process (Electron / Node.js)                                 │
│  - owns all privileged OS operations                               │
│  - ps, lsof, Docker CLI, pg client, fs                            │
│  - registers ipcMain.handle() for every channel                   │
│  - emits snapshot events to renderer via mainWindow.webContents   │
└───────────────────────────────────────────────────────────────────┘
```

## IPC bridge contract

The bridge is frozen. Channel names and argument shapes must not change without a coordinated update to all three files listed below.

| File | Role |
|------|------|
| `electron/preload.js` | Exposes `window.electronAPI` via `contextBridge`. Translates renderer calls into `ipcRenderer.invoke()` / `ipcRenderer.on()`. |
| `electron/main.js` | Bootstraps the app; registers all `ipcMain.handle()` listeners by calling each handler group from `electron/handlers/`. |
| `src/types/electron.d.ts` | TypeScript declaration for `window.electronAPI` — the shared type contract. |

### Adding a new IPC channel

1. Add the handler in the appropriate file under `electron/handlers/`
2. Expose it in `electron/preload.js` under `window.electronAPI`
3. Declare it in `src/types/electron.d.ts`
4. Run `npm run typecheck` — must exit 0 before merging

## Data flow

```
Main process
  1. ps + lsof run in parallel (processMonitor, portMonitor)
  2. Docker snapshot (dockerMonitor)
  3. snapshotScheduler coordinates tiered refresh:
       - fast probe every ~1.5s   (PID/port enumeration only)
       - metrics overlay every 5s (cpu/mem overlay on existing nodes)
       - full rebuild every 10s   (or on topology change)
  4. graphBuilder.worker.js (Worker thread) builds/diffs graph nodes + edges
  5. main emits { type: 'full' | 'delta' | 'metrics', ... } to renderer

Renderer
  6. useSystemMonitor.ts applies delta patches to local state
  7. React re-renders only on topology or metric change
  8. On-demand scans (routes, external APIs) enrich individual nodes
```

## Source map

| Area | Path |
|------|------|
| App shell, view modes | `src/App.tsx` |
| IPC bridge | `electron/preload.js`, `src/types/electron.d.ts` |
| IPC handlers | `electron/handlers/` |
| Snapshot scheduling | `electron/services/system/snapshotScheduler.js` |
| OS data collection | `electron/services/monitoring/`, `electron/services/system/systemSnapshot.js` |
| Graph construction | `electron/services/graph/` |
| Sentinel (runtime scan) | `electron/services/ai/sentinelEngine.js` |
| Route discovery | `electron/services/discovery/routeScanner.js` |
| Docker monitoring | `electron/services/docker/dockerMonitor.js` |
| Database queries | `electron/services/database/databaseQuery.js` |
| Security + CSP | `electron/security.js` |
| Worker thread | `electron/workers/graphBuilder.worker.js` |
| Graph rendering | `src/components/GraphView.tsx`, `src/components/graph/` |
| Sentinel panel | `src/components/AgentPanel.tsx`, `src/components/agent/` |

## Feature boundaries

Core features (service map, Sentinel, Docker, database, API tester) are free and open. Team/Org collaboration features live in isolated subdirectories and require a cloud backend:

- `src/team/` — renderer-side Team tier features
- `electron/team/` — main-process Team tier handlers and cloud sync

Both directories are stubs in this release. They activate only when `FERE_TEAM_MODE=true` or `FERE_ORG_MODE=true` is set in the environment.

## Security model

- Renderer is sandboxed: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
- All external HTTP requests from the renderer go through `electron/security.js` (SSRF protection, private-host blocking, response size caps)
- The IPC bridge validates inputs before executing any privileged action (kill-port, restart-container, write-file)

See `electron/security.js` and `docs/architecture.md` for full details.
