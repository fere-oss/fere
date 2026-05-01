# Sentinel — Capabilities and Product Direction

Sentinel is Fere's deterministic runtime operator. It watches the live local stack, surfaces concrete failures and drift, ranks findings by blast radius, and offers focused fix actions.

Sentinel is not a general coding assistant. It wins by being grounded in live runtime state — something Codex and Claude cannot replicate without instrumentation.

---

## What Sentinel does

- Watches the running stack for health failures, config drift, and dependency problems
- Rescans automatically when topology changes and on a background interval
- Presents ranked findings with severity, affected services, and a direct next action
- Executes safe typed fixes (kill port, restart container) or provides copy-only guidance
- Surfaces new findings visually when the panel was closed during a scan

## What Sentinel does not do

- Long-form prompt box or freeform chat as the primary interaction
- Generic code assistance or explanation unrelated to the running stack
- Prose summaries that restate what the user already sees on screen
- Chat history as the primary panel layout

---

## Why this beats general AI assistants for this use case

Codex and Claude are strong when the user already knows what to ask and can provide the right context. Sentinel operates differently:

- It sees the live topology, not just the codebase
- It knows what is running, unhealthy, stopped, disconnected, or missing
- It ranks blast radius from the real process/connection graph
- It keeps watching without the user writing a prompt
- It offers focused runtime fixes rather than broad generic advice

The value is not "better answers." The value is better grounding.

---

## Shipped checks

Sentinel's scan engine (`electron/services/sentinelEngine.js`) runs the following deterministic checks against the live snapshot:

| Check | Description |
|-------|-------------|
| High resource usage | CPU > 80% or memory > 512 MB per process |
| Port conflict | Stale process holding a port, blocking a newer service |
| Down service | Node with health status `red` |
| Cascade impact | Multi-service failure — downstream services affected by an upstream down node |
| Stopped container | Container in `exited` or `dead` state |
| Unhealthy container | Docker health check returning `unhealthy` |
| Restarting container | Container in a crash-restart loop |
| Disconnected service | Process is running but has no graph edges (isolated) |
| Env-var mismatch | Env var points to a port or host not currently listening (PostgreSQL, Redis, MongoDB, RabbitMQ, Kafka, Elasticsearch) |
| Missing dependency | `package.json` references a service (Redis, Postgres, etc.) but its port is not active |
| Custom rules | User-defined checks loaded from `~/.fere/custom-rules.json` |

---

## Finding structure

Each finding is a typed `AgentFinding` object:

```typescript
interface AgentFinding {
  id: string;
  severity: 'critical' | 'warning' | 'suggestion';
  category: 'health' | 'connectivity' | 'config' | 'security' | 'dependency';
  service: string;
  summary: string;
  detail: string;
  impact: string | null;
  affectedServices: string[];
  fix: AgentFixAction | null;
}
```

Findings are sorted by severity and blast radius before display.

---

## Fix actions

```typescript
interface AgentFixAction {
  type: 'kill-port' | 'restart-container' | 'copy-only' | 'write-file';
  label: string;
  // type-specific fields (port number, container id, command text, file path + content)
}
```

| Type | Behavior |
|------|---------|
| `kill-port` | Kills the process holding the target port |
| `restart-container` | Restarts the named Docker container |
| `copy-only` | Copies a shell command or template to clipboard; no automation |
| `write-file` | Writes a config patch to disk (user confirms before apply) |

---

## UX contract

The Sentinel panel must remain:

- **Findings-first:** Issues → Suggestions, sorted by severity
- **Minimal:** No chat transcript, no prompt box as the primary surface
- **Action-oriented:** Every finding points to a concrete next step
- **Visually consistent:** Matches the app shell — no AI-brand gradients or distinctive styling

---

## Known gaps

### No incident state transitions yet

Sentinel does not track whether a finding is `new`, `worsened`, or `resolved` across scans. Every scan currently treats findings as fresh.

### No post-fix verification loop

Sentinel can apply a fix, but it does not yet re-scan and verify the finding is cleared before marking it resolved.

### No proactive escalation for critical findings

New findings are marked visually in the UI, but there is no stronger notification path for critical-severity incidents discovered while the panel is closed.

### No deep-investigation handoff

Sentinel can focus a service in the graph, but it does not yet open a scoped investigation path when deterministic checks find evidence but cannot conclude root cause.

---

## Planned next steps

1. Add incident state transitions (`new`, `worsened`, `resolved`) across scan cycles
2. Add stronger proactive escalation for critical background findings
3. Add post-fix verification — re-scan before clearing an issue
4. Add a narrow AI-assisted deep-investigation path — only for findings where deterministic evidence is insufficient

---

## Guardrails for future AI integration

If AI is reintroduced as a secondary path, it should only be used where deterministic checks are insufficient:

- Explaining why a multi-service failure pattern is occurring
- Proposing a fix plan after evidence has already been collected by deterministic checks
- Generating a targeted verification checklist from a finding

AI must not be the default surface. The deterministic engine runs first, always.
