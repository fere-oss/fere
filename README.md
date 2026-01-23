# fere

fere is a native-feeling macOS Electron app that visualizes your local development environment in real time. It discovers dev processes, maps listening ports, and infers service connections to help you answer "what is running where" at a glance.

## Current features
- Live service list with CPU/memory, ports, and inferred connections
- Listening ports view with process metadata
- Process termination for dev-related processes only
- Connection graph model (nodes + edges) in the main process
- API route discovery per service (framework-aware)
- Project mapping from process CWD to repo root
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

## Build (macOS)
```bash
npm run electron:build:mac
```

## Notes
- Process discovery uses `ps` and `lsof`; output formats can vary across OS versions.
- The renderer is sandboxed; all system calls occur in the Electron main process.
