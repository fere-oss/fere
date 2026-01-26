# fere

fere is a native-feeling macOS Electron app that visualizes your local development environment in real time. It discovers dev processes, maps listening ports, and infers service connections to help you answer "what is running where" at a glance.

## Current features
- Live graph of local services with CPU/memory, ports, and connections
- Health status tracking (active/idle/down) per service
- Listening ports with process/user metadata
- Connection graph model (nodes + edges) in the main process
- API route discovery per service (framework-aware: FastAPI, Flask, Express, Next.js, Koa, Hono)
- External API usage detection from code/env (configurable providers list)
- Project mapping from process command/CWD to repo root
- Quick actions: open service URL, open terminal at project path, kill dev processes
- Real-time connection arrows with port labels

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
