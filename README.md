# fere

fere is a native-feeling macOS Electron app that visualizes your local development environment in real time. It discovers dev processes, maps listening ports, and infers service connections to help you answer "what is running where" at a glance.

## Current features
- Live service map with CPU/memory, ports, and real-time connections
- Health status tracking (active/idle/down) per service
- Listening ports with process/user metadata
- Connection graph model (nodes + edges) in the main process
- API route discovery per service (framework-aware: FastAPI, Flask, Express, Next.js, Koa, Hono)
- External API usage detection from code/env (configurable providers list)
- Project mapping from process command/CWD to repo root
- Project tabs + System tab grouping for multi-repo setups
- Quick actions: open service URL, open terminal at project path, kill dev processes
- Real-time connection arrows with port labels
- API Tester tab with curl builder, in-app request execution, and history
- Docker containers view (running containers only)
- Container logs streaming (single container + multi-container)
- Database tools for containerized DBs (table list, data preview, query, create table)

## Requirements
- macOS with `lsof` and `ps` available (default)
- Node.js and npm

## Development
```bash
npm install
npm run electron:dev
```

## Tests
```bash
npm run test:node
```
```bash
cd test
sh start-all.sh
```

## Build (macOS)
```bash
npm run electron:build:mac
```

## Notes
- Process discovery uses `ps` and `lsof`; output formats can vary across OS versions.
- The renderer is sandboxed; all system calls occur in the Electron main process.

## External API detection
- Provider list lives in `config/api-providers.json`.
- Optional per-user overrides in `~/.fere/api-providers.json` (same schema, overrides by name).
- Detection scans code + env files for SDK imports, domains, and env var names.

## API Tester
- Switch to the API Tester tab to build curl requests against detected services.
- Select a service + route, edit headers/body, and run requests from the app.
- Request history is stored locally for quick recall.

## Containers
- Container view shows running Docker containers, ports, and connections.
- Logs tab supports streaming logs from one or many containers.
- Database view supports browsing tables, previewing data, and running queries for DB containers.
