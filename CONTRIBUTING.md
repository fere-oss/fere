# Contributing to Fere

Thanks for taking the time to contribute. This document covers setup, conventions, and the PR process.

## Local setup

### Prerequisites

- macOS (the app uses `lsof` and `ps` in macOS-specific output formats)
- Node 20+
- npm 10+
- Docker Desktop (optional — needed for container, log, and database features)

### Steps

```bash
git clone https://github.com/your-org/fere.git
cd fere
npm install
cp .env.example .env                          # fill in keys you need (all optional)
cp electron/runtime-config.example.json electron/runtime-config.json
npm run electron:dev                          # React dev server + Electron
```

The app opens automatically. Hot-reload is enabled for the renderer; restart Electron after changing main-process files.

## Running tests

```bash
npm run test:node        # Node-side service tests (Jest, no Electron)
npm test                 # React/renderer tests
npm run typecheck        # TypeScript — run after every change
```

Integration tests (require Docker):

```bash
sh test/start-all.sh
# or
cd test/docker-test && sh start.sh
```

## Code conventions

### TypeScript strictness

All renderer code is strict TypeScript. Avoid `any` casts. Add types to `src/types/electron.d.ts` for anything crossing the IPC bridge.

### IPC contract is frozen

`electron/preload.js` exposes `window.electronAPI`. **Do not rename or remove existing channels.** Adding new channels is fine; changing existing ones breaks the renderer without a coordinated update to `src/types/electron.d.ts`.

### No empty `catch {}` blocks

Every catch block must have either a `console.warn` call or a short comment explaining why the error is safe to swallow. See `electron/constants.js` for the policy examples.

### Performance

- Wrap heavy graph derivations in `useMemo`/`useCallback`.
- Do not force `GraphView` remounts on tab switch (`key={selectedTab}` is banned).
- Clear hover timers when the hover effect is disabled.

### Feature boundary

Core monitoring features belong in the root `src/` and `electron/` trees.

Team and Org tier features must live under:

- `src/team/` (renderer)
- `electron/team/` (main process)

Both directories have a `README.md` explaining the boundary.

## Architecture overview

```
electron/main.js          — main process entry, IPC registration
electron/preload.js       — contextBridge (frozen IPC contract)
electron/handlers/        — IPC handler groups (one file per domain)
electron/services/        — monitoring, discovery, docker, graph, ai, …
electron/workers/         — Worker thread (graph computation)
src/App.tsx               — renderer entry, view routing
src/components/           — React components
src/hooks/                — React hooks (useSystemMonitor, etc.)
src/types/electron.d.ts   — shared IPC type contracts (frozen)
```

See `docs/architecture.md` for the full data-flow description.

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b fix/my-thing`
2. Make your changes, keeping commits focused.
3. Run `npm run typecheck` and `npm run test:node` — both must pass.
4. Open a PR against `main`. The PR template will prompt you for the required checklist.
5. A maintainer will review and merge. We aim for a 48-hour first response.

## Issue triage

- **Bug** — reproducible crash or wrong behaviour. Include macOS version, Fere version, and console logs.
- **Enhancement** — new feature for the core (free) app. Describe the problem, not just the solution.
- **Team/Org** — cloud-tier features are tracked separately and not accepted as community PRs at this time.
