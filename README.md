# Fere

[![CI](https://github.com/RahulThennarasu/fere/actions/workflows/ci.yml/badge.svg)](https://github.com/RahulThennarasu/fere/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/github/v/release/RahulThennarasu/fere?label=version)](https://github.com/RahulThennarasu/fere/releases)

Fere is a desktop app for understanding what is running on your machine right now.

It watches local processes, listening ports, TCP connections, Docker containers, routes, external API usage, logs, databases, and request flow, then turns that into a live, interactive map of your development environment. The goal is simple: make local infrastructure visible enough that you can answer questions like:

- What services are actually running?
- Which project owns this process?
- What ports are exposed?
- What talks to what?
- Which routes does this service expose?
- Which external providers does this project call?
- Why is this request slow or failing?

Fere is built with Electron + React and is primarily aimed at local development workflows.

## What Fere Includes Right Now

### 1. Live service map

Fere continuously builds a topology graph from real process and network state:

- Processes discovered from the host OS
- Listening ports
- Established TCP connections
- Docker containers and Docker networks
- Health/activity overlays
- CPU and memory overlays

The graph is not just a static diagram. It updates over time and tries to preserve layout stability while refreshing metrics and topology changes.

Current graph behavior includes:

- A system-wide tab plus per-project tabs
- Repo and subproject grouping modes
- Stack summary labels on project tabs
- Service counts and running/total counts per tab
- Layered graph layout
- Standalone service grouping
- Data freshness-aware updates
- Viewport-aware rendering for large graphs
- Hover and selection behavior for dependencies
- Brand/provider icon support where applicable

### 2. Service and project discovery

Fere enriches raw processes with project-aware context:

- Infers project paths from commands / cwd
- Groups services into project tabs
- Detects service type categories such as frontend, backend, database, cache, broker, and more
- Surfaces known service labels and descriptions
- Tracks health states like active, idle, and down

### 3. Route discovery

Fere scans source trees and attaches API routes to detected services.

Frameworks currently covered in the codebase include:

- FastAPI
- Flask
- Express
- Next.js API routes
- Koa
- Hono
- plain Node HTTP servers
- additional framework-specific parsing covered by the route scanner tests

The route data feeds both the graph and the request tooling.

### 4. External API and provider detection

Fere scans code and env/config references to detect outbound third-party API usage.

It currently supports:

- host/domain detection from source
- SDK / library usage clues
- `.env` / config-derived hints
- provider matching through the catalog in [`config/api-providers.json`](config/api-providers.json)

This is used in graph enrichment and in the AI assistant experience.

### 5. Request tracing

Fere can execute traced HTTP requests and approximate how a request moves through your local stack.

Current tracing-related behavior includes:

- firing a request against a selected service/route
- marking entry points in the graph
- showing direction arrows / request flow
- switching focus to the relevant project tab automatically
- using trace context in the UI and graph interactions

This is intended for local debugging rather than production-grade distributed tracing.

### 6. Requests / API tester

The Requests view is an in-app HTTP workbench.

Current capabilities include:

- selecting services and discovered routes from the graph
- composing requests with method, URL, headers, and body
- generating cURL from the UI
- pasting/editing raw cURL and parsing it back into the UI model
- shell-style env var substitution support in cURL parsing
- in-app request execution through Electron main-process handlers
- response status, duration, size, headers, and body inspection
- JSON-aware formatting
- request history persistence
- request replay
- traced request execution

Security guardrails are applied to request execution from the main process.

### 7. Containers view

Fere has a dedicated Containers mode with two sub-views:

- Overview
- Logs

The Overview sub-view renders Docker containers in a graph-focused experience.

Current Docker/container coverage includes:

- running container detection
- Docker network detection
- Docker health/state metadata
- container start / stop / restart actions
- compose project start actions
- empty-state handling when Docker is missing or not running

### 8. Unified container logs

The Logs sub-view supports multi-container log streaming.

Current behavior includes:

- selecting one or many containers
- starting and stopping streams per container
- stopping all streams
- unified timeline rendering
- per-container identification
- log level detection
- search filtering
- regex-capable filtering
- level filtering
- pause / resume
- follow mode
- copy / clear actions
- buffered rendering for performance
- lifecycle handling for stream data, error, and close events

### 9. Database tooling

Fere includes a database browser / query workflow for both detected local databases and remote URI mode.

Current capabilities in the codebase include:

- database list view from detected running DB containers
- dedicated database page
- table / collection browsing
- data preview
- query execution
- multiple query tabs
- keyboard execution shortcuts
- create-table flow
- delete row / delete table / delete collection flows
- saved recent URI connections

Container and URI-related support currently includes logic for:

- PostgreSQL
- MongoDB
- MySQL / MariaDB container handling
- Elasticsearch URI mode

Remote URI mode currently has explicit connect/query flows for:

- MongoDB
- PostgreSQL
- Elasticsearch

### 10. Sharing and export

Fere can export and publish snapshots of the current graph.

Current sharing features include:

- export to a self-contained HTML snapshot
- publish a snapshot
- update an existing published snapshot
- copy/open share URLs
- GitHub token storage for publishing flows

The app currently includes IPC handlers for:

- graph file export
- initial publish
- update of an existing shared graph

### 11. Sentinel AI assistant

Fere includes an in-app assistant called Sentinel.

Sentinel is wired into the live topology and local context instead of acting like a generic chat box. It can use the current graph, routes, external provider data, findings, and node-specific details while answering.

Current Sentinel capabilities include:

- natural-language questions about your running stack
- node-scoped investigations
- direct answers for some node questions without a full LLM call
- streamed responses
- markdown rendering
- syntax highlighting
- mention support for services
- provider/logo enrichment in responses
- persisted chat threads
- chat history
- copy actions

### 12. AI auth, limits, and API-key flow

The current product has both a signed-in flow and a direct API-key flow.

Current behavior includes:

- Google sign-in in the UI
- OAuth session tracking in Electron
- free daily AI usage tracking
- optional direct OpenAI API key entry for unlimited calls
- API-key status detection
- API-key removal

Current key-handling UX communicates that keys are:

- encrypted at rest using macOS Keychain
- stored locally
- used for direct OpenAI API calls

The current codebase also contains GitHub auth plumbing in the main process, though Google is the user-facing provider exposed in the current UI.

### 13. Proactive findings and fix workflows

Sentinel is not only chat. The app also contains proactive finding and remediation flows.

Current capabilities include:

- proactive findings emitted from the main process
- finding cards with severity and service context
- finding explain actions
- apply-fix actions
- Claude Code handoff flow for selected findings
- resolution / worsening event handling
- fix proposal streaming from the AI workflow

### 14. Analytics view

Fere includes a dedicated Analytics mode.

Current analytics-related surfaces include:

- stack overview
- repo selector
- service composition summaries
- stack health donut / health-oriented summaries
- resource breakdown views
- activity/event history
- metric history integration
- analytics badge / activity indicators in the top navigation

### 15. Command palette and quick actions

The app includes a command palette for navigating the workspace and triggering actions.

Current palette coverage includes:

- service search
- port search
- action search
- graph navigation shortcuts
- view switching
- node focusing

There are also main-process quick actions for:

- opening URLs externally
- opening a terminal in a project directory
- opening files in the editor
- copying text

### 16. Alerts and operational history

Fere includes notification and activity-tracking infrastructure.

Current alert / activity functionality includes:

- alert preference storage
- per-category alert toggles
- notification enable/disable state
- alert history
- clear alert history
- activity log retrieval
- metric history retrieval
- analytics ID exposure to the renderer

### 17. Service control and orchestration

Fere is not read-only.

Current control actions exposed through IPC include:

- kill process
- start process
- stop container
- start container
- restart container
- start compose project

### 18. Onboarding and product education

The app includes a welcome/onboarding modal with previews for:

- the service map
- container logs
- requests
- sharing

This is part of the current shipped product surface and not just a design stub.

## Headless investigations from Sentinel

Sentinel can drive a headless AI coding CLI on your behalf. Click **Investigate** on any finding and Fere spawns a one-shot session of your chosen agent with the Fere MCP attached, scoped to the affected service's project. The agent investigates, optionally calls `apply_fix` (which still goes through Fere's approval modal), and the result lands inline on the finding card.

Currently supported providers:

| Provider | Install | Notes |
| --- | --- | --- |
| **Claude Code** | `npm i -g @anthropic-ai/claude-code` | Per-invocation MCP via `--mcp-config`. Tool allowlist enforced. |
| **OpenAI Codex** | `npm i -g @openai/codex` | Per-invocation MCP via `-c` config overrides (no global pollution). Sandbox `read-only` enforced. |

Click the caret next to the Investigate button to switch agents. The choice is persisted per-machine. Agents that aren't installed appear greyed out with the install hint. Fere falls back to the **Hand off** button (clipboard + Terminal) for any other agent.

## MCP Server (for Claude Code, Cursor, Windsurf, Zed)

Fere ships an MCP server (`fere-mcp`) so AI coding clients can pull live runtime data from your local stack instead of guessing. While Fere is running, your AI client can call:

- `list_findings` — ranked Sentinel issues (port conflicts, down services, unhealthy containers, env mismatches, etc.)
- `get_service` — health, ports, container, recent logs, and graph edges for a single service
- `get_topology` — full live service graph (nodes + edges)
- `list_routes` — discovered HTTP routes (FastAPI, Flask, Express, Next.js, Koa, Hono)
- `list_external_apis` — third-party providers detected from source/env
- `get_logs` — recent log slice from any Docker container

Architecture: AI clients spawn `fere-mcp` (stdio). The shim talks to a local-loopback HTTP bridge inside the Fere app on every tool call, so responses always reflect the current snapshot. If Fere isn't running, every tool returns a clean "Fere is not running" message.

### Connect an AI client

After `npm install` in this repo:

**Claude Code** (project scope):

```jsonc
// .mcp.json
{
  "mcpServers": {
    "fere": {
      "command": "node",
      "args": ["./bin/fere-mcp.js"]
    }
  }
}
```

Or globally with `claude mcp add fere -- node /path/to/fere/bin/fere-mcp.js`.

**Cursor** (`~/.cursor/mcp.json`):

```jsonc
{
  "mcpServers": {
    "fere": {
      "command": "node",
      "args": ["/path/to/fere/bin/fere-mcp.js"]
    }
  }
}
```

Open the Fere app first; then ask the AI client a question about your stack.

### How it knows where Fere is running

Fere writes `~/.fere/mcp.lock` (mode 0600) on startup containing `{port, token, pid}`. The shim reads that file, authenticates with the token, and connects only on `127.0.0.1`. The lockfile is removed on app quit; if the recorded PID is dead, the shim treats Fere as not running.

## Platform and Scope

Fere is a desktop app focused on local development environments.

Current repo/build reality:

- macOS is the primary target
- Windows packaging targets also exist in `electron-builder`
- platform-specific monitoring implementations exist under [`electron/services/platform`](electron/services/platform)

System tools and external dependencies Fere relies on include:

- `ps`
- `lsof`
- Docker CLI / Docker Desktop for container features
- DB clients used by the database tooling where applicable

## Development Setup

### Requirements

- Node.js
- npm
- macOS for the primary local workflow
- optional Docker Desktop for container, logs, and DB features

### Install

```bash
npm install
```

### Run the desktop app in development

```bash
npm run electron:dev
```

### Renderer only

```bash
npm run start
```

## Configuration

Fere currently reads runtime config from a mix of environment variables and packaged runtime config for production auth flows.

Relevant variables in this repo include:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `OPENAI_API_KEY`
- `REACT_APP_LOGO_DEV_TOKEN`
- `REACT_APP_SENTRY_DSN`

Typical local development flow uses a project-root `.env`.

Important:

- do not ship private secrets in client-readable config
- the Supabase anon key is client-safe
- OpenAI secret keys and service-role keys are not

## OAuth and packaged builds

The current desktop auth flow uses:

- PKCE
- a local callback server on `127.0.0.1`
- a fixed callback path for packaged builds

The codebase currently includes:

- Google sign-in flow
- auth session persistence
- sign-out flow
- packaged-app runtime config support for public auth values

## Packaging

Current build scripts:

```bash
npm run build
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
```

`electron-builder` is configured for:

- macOS DMG + ZIP
- Windows NSIS + portable

## Scripts

```bash
npm run start
npm run start:no-deprecation
npm run build
npm run typecheck
npm run test
npm run electron
npm run electron:dev
npm run electron:dev:win
npm run electron:build
npm run electron:build:mac
npm run electron:build:win
npm run test:node
npm run release:check
```

## Testing

Core checks:

```bash
npm run typecheck
npm run test:node
```

Integration-style local test utilities:

```bash
cd test && sh start-all.sh
```

```bash
cd test/docker-test && sh start.sh
```

The repo also contains targeted tests for:

- security helpers
- route scanning
- container / connection graph behavior
- platform-specific parsing
- request history
- external API scanning

## Project Structure

```text
src/                    React renderer app
src/components/         UI surfaces: graph, requests, database, logs, analytics, Sentinel
src/hooks/              renderer hooks including snapshot stream integration
electron/               Electron main process, preload, security, services
electron/services/      monitoring, Docker, DB, graph, auth, AI, activity, export
config/                 provider catalogs and config assets
docs/                   architecture and specs
supabase/               edge functions and auth/backend-related project code
test/                   local integration helpers and mock services
```

## Security model

Current security controls in the app include:

- `contextIsolation: true`
- `nodeIntegration: false`
- sandboxed renderer
- navigation blocking for untrusted destinations
- external URL validation
- window-open restrictions
- default-deny permission handlers
- CSP setup for dev and production
- SSRF protection for HTTP tools
- private-host blocking by default for remote requests
- response size caps for in-app HTTP execution
- remote DB URI validation

Main code references:

- [`electron/security.js`](electron/security.js)
- [`electron/main.js`](electron/main.js)

## Notes and current limitations

- Fere is optimized for local/dev observability, not production infrastructure monitoring
- a number of features depend on host tool availability and platform-specific parsing
- Docker, database, and AI features degrade gracefully when their dependencies are unavailable
- route and provider discovery are heuristic and source-based, so they are informative rather than perfect

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code conventions, and the PR process.

Quick start:

```bash
git clone https://github.com/RahulThennarasu/fere
cd fere
npm install
npm run electron:dev
```

## Community

- [GitHub Issues](https://github.com/RahulThennarasu/fere/issues) — bug reports and feature requests
- [Code of Conduct](CODE_OF_CONDUCT.md)

## Architecture

For deeper internals, read:

- [`docs/architecture.md`](docs/architecture.md)
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — public IPC bridge overview

