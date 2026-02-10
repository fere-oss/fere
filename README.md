# Fere

fere helps you to visualize your development environment in real time.

## Highlights
- Live service graph with CPU/memory, ports, and real-time connections
- Health tracking per service (`active`, `idle`, `down`)
- API route discovery (FastAPI, Flask, Express, Next.js, Koa, Hono)
- External API usage detection from code and environment files
- Project-aware grouping (multi-repo tabs + system view)
- API Tester with cURL builder, request execution, and history
- Docker visibility for running containers and network links
- Container log streaming (single and multi-container)
- Database tools for containerized DBs (tables, preview, query, create table)

## Requirements
- macOS
- Node.js + npm
- System tools available on macOS: `lsof`, `ps`
- Optional: Docker Desktop (for container and DB features)

## Quick Start
```bash
npm install
npm run electron:dev
```

## Scripts
```bash
npm run start            # React dev server only
npm run electron:dev     # React + Electron app (recommended)
npm run build            # Renderer production build
npm run electron:build   # Build desktop app
npm run electron:build:mac
npm run test:node        # Node/Electron service tests
```

## Testing
```bash
npm run test:node
```

Integration test utilities:
```bash
cd test
sh start-all.sh
```

```bash
cd test
cd docker-test
sh start.sh
```

## Project Structure
```text
src/                    React UI (graph, API tester, DB views)
electron/               Main process, IPC handlers, monitoring services
config/                 API provider detection config
docs/                   Architecture notes
```

## Security Model
- Renderer runs sandboxed with `contextIsolation` enabled
- System access is restricted to Electron main process IPC handlers
- URL validation and request safeguards are enforced in `electron/security.js`
- Response size caps are applied for in-app HTTP testing

## API Tester
- Build from discovered service routes or edit raw cURL directly
- Execute requests in-app and inspect status, headers, body, and timing
- Save and replay request history locally

## External API Detection
- Base provider catalog: `config/api-providers.json`
- Optional per-user overrides: `~/.fere/api-providers.json`
- Detection scans source and env files for SDK imports, hosts, and env var patterns

## Notes
- Process/port parsing relies on OS command output and may vary slightly by macOS version
- Fere is optimized for local development environments rather than production observability

## Architecture
For deeper internals, see `docs/architecture.md`.
