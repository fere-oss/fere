# Fere

Fere is a macOS desktop app that gives you a live, interactive map of your local development environment. It watches your processes, ports, Docker containers, and network connections and renders them as a real-time service topology graph — so you always know what's running, how it's connected, and whether it's healthy.

## Features

### Service Map
- **Live topology graph** — processes, containers, and their TCP connections rendered as an interactive node-edge diagram with CPU/memory overlays
- **Health tracking** — each service is classified as `active`, `idle`, or `down` based on real-time probes
- **Project-aware tabs** — services are grouped by project directory, with a system-wide view available alongside per-project tabs
- **API route discovery** — automatically scans source trees for route definitions across FastAPI, Flask, Express, Next.js, Koa, and Hono
- **External API detection** — identifies third-party API usage from source code, SDK imports, and `.env` files, matched against a provider catalog

### Request Tracing
- **Approximate request flow tracing** — fire a request and watch it propagate across services on the graph with a waterfall timeline
- **Entry point markers and direction arrows** — clearly shows where a request enters the topology and how it flows downstream
- **Automatic project switching** — clicking a trace automatically focuses the relevant project tab

### API Tester
- **cURL builder** — construct requests from discovered service routes or write raw cURL commands
- **In-app execution** — send requests and inspect status codes, headers, response body, and timing
- **Request history** — save and replay previous requests

### Docker & Containers
- **Container graph** — Docker containers and their network links visualized alongside native processes
- **Log streaming** — stream logs from individual or multiple containers simultaneously
- **Container database explorer** — browse tables, preview data, run queries, and create tables for databases running in containers

### Database Tools
- **Containerized DB support** — auto-detected PostgreSQL and MongoDB instances running in Docker
- **Remote URI mode** — connect to remote MongoDB and PostgreSQL databases by URI
- **Query interface** — run SQL or MongoDB queries with tabular result display

### Config Drift Detection
- **Declared vs. running comparison** — compares docker-compose files, Procfiles, and package.json scripts against what's actually running to surface mismatches
- **Environment variable checks** — flags infrastructure references in `.env.example` that don't have corresponding live services
- **Config file viewer** — view project configuration files directly within Fere

### Sharing
- **Snapshot export** — export your current service map as a self-contained interactive HTML file that replicates the exact Fere graph layout
- **Gist publishing** — publish snapshots as GitHub Gists for sharing with teammates

### Ask Fere (AI)
- **Natural language queries** — ask questions about your running stack in plain English (e.g., "what's connected to my API server?" or "why is my checkout service slow?")
- **Topology-aware answers** — responses are grounded in the live graph, referencing specific services, ports, routes, and connections
- **Optimization hints** — proactive suggestions surfaced based on detected patterns in your service topology
- **Service-scoped context** — ask questions scoped to a specific service directly from its node detail panel

### Cross-Service Debugger (AI)
- **Autonomous investigation** — describe a bug in natural language and an AI agent investigates across your entire stack, reading logs, firing test requests, inspecting source code, and analyzing the topology
- **Real-time progress** — watch the investigation unfold step-by-step as the agent orchestrates Fere's infrastructure
- **Structured diagnosis** — presents a final root cause report with supporting evidence from logs, responses, and code

## Requirements
- macOS
- Node.js + npm
- System tools available on macOS: `lsof`, `ps`
- Optional: Docker Desktop (for container, log, and DB features)
- Optional: OpenAI API key (for Ask Fere and Cross-Service Debugger)

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
cd test && sh start-all.sh
```

```bash
cd test/docker-test && sh start.sh
```

## Project Structure
```text
src/                    React UI (graph, API tester, DB views, AI panels)
electron/               Main process, IPC handlers, monitoring + AI services
config/                 API provider detection catalog
docs/                   Architecture and spec documents
```

## Security Model
- Renderer runs sandboxed with `contextIsolation` enabled
- System access is restricted to Electron main process IPC handlers
- URL validation and SSRF safeguards enforced in `electron/security.js`
- Response size caps applied for in-app HTTP testing
- Remote DB URIs validated against private IP ranges

## Notes
- Process/port parsing relies on macOS-specific `lsof` and `ps` output formats
- Fere is optimized for local development environments rather than production observability
- AI features (Ask Fere, Cross-Service Debugger) require an OpenAI API key and are rate-limited to 5 queries/day on the free tier

## Architecture
For deeper internals, see [docs/architecture.md](docs/architecture.md).
