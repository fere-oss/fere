# Fere Architecture Notes

## Phase 0 kickoff: data model
The core model is a "service" that represents a dev process and its runtime context.

### Service
- id: stable ID (pid + start time when available)
- pid: number
- name: display name
- command: full command line
- type: category used for UI grouping
- owner: user name
- tty: terminal identifier (when available)
- ports: array of { port, host, protocol, description }
- resources: { cpu, memory, rss, vsz }
- project: inferred project name or repo root

### Connection
- sourceId: service id
- targetId: service id
- sourcePort: number
- targetPort: number
- protocol: tcp/udp
- confidence: 0..1 for inferred links

### System snapshot
- processes: raw `ps` data
- ports: parsed listening ports
- connections: parsed established connections
- graph: nodes + edges derived from the above

## Phase 1 kickoff: monitoring core
- Collect `ps` and `lsof` once per tick in the main process.
- Cache the latest snapshot and serve via IPC without duplicate OS calls.
- Harden parsing for common `lsof` formats (IPv6, extra tokens).
- Emit errors to the renderer for visibility.
