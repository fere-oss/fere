# Fere — Product Spec

## What It Is

Fere is a macOS Electron desktop app that visualizes local development environments in real time. It monitors processes, ports, TCP connections, and Docker containers to render a live service topology graph with health tracking, API route discovery, and database tooling.

Zero-config automatic service discovery. Start a server, Fere finds it. No YAML, no manifests, no setup.

## Four Modes

1. **Service Map** — Live topology graph showing how your local services connect. Grouped by project with health indicators. Updates in real time as services start, stop, or change.
2. **Containers** — Docker container visualization with unified log streaming. See your containers as a graph, tail logs across all of them in one place.
3. **API Tester** — Built-in API tester with cURL builder, execution, and history. Test your endpoints without leaving the tool.
4. **Database** — Container database explorer plus remote MongoDB/PostgreSQL URI mode. Browse and query your databases directly.

## Key Features

- **AI Debug Agent** — Powered by GPT-4o with 11 tools. Investigates issues across your local stack — reads logs, checks health, queries databases, traces connections.
- **Request Tracing** — Waterfall diagram showing how a request flows through your local services. See latency at each hop.
- **Route Discovery** — Automatically scans source code for API routes. Supports FastAPI, Flask, Express, Next.js, Koa, Hono.
- **External API Detection** — Detects external API usage from source and .env files. Matched against a catalog of known API providers.
- **Shareable Snapshots** — Export your service map as an interactive HTML snapshot or GitHub Gist. Anyone can open it in a browser, no install needed.

## Tech Stack

- React 19 + TypeScript (renderer)
- Electron 40 (main process)
- ReactFlow (graph visualization)
- electron-builder (packaging)

## Platform

macOS only. Depends on Darwin-specific `lsof` and `ps` output formats.
