# Fere Agent — Feature Plan

## Overview

Replace the reactive Ask Fere and Cross-Service Debugger with a unified **Fere Agent** — a proactive system that watches the topology, auto-detects issues, and surfaces structured findings with one-click fixes.

---

## What Gets Removed

- Ask Fere (floating chat panel)
- Cross-Service Debugger (streaming debug panel)
- "Ask Fere" and "Diagnose Service" action buttons in the node detail panel

---

## What Gets Added

### 1. Fere Agent — Finding Engine (electron/main process)

Runs alongside the existing snapshot cycle. On topology change or anomaly, the agent scopes to affected services, evaluates findings, and emits structured results over IPC.

**Spawn triggers:**

- Service goes down (PID disappears from snapshot)
- Port conflict detected (port occupied by unexpected PID)
- Container stops or crashes
- New service added with no connections (topology gap)
- Manual trigger ("Run Scan" button)

**Phase 1 scope — structural issues only** (works with current snapshot data):

- Service down / process missing
- Port conflict (stale process holding a port)
- Container stopped / crashed
- Disconnected service after topology change

**Phase 2 scope — anomaly detection** (requires metrics history layer):

- CPU spike sustained over rolling window
- Memory growth trend
- Repeated crash/restart loop
- Latency increase (if latency data added)

> Phase 2 requires a lightweight circular buffer (~5 min rolling window of CPU/memory per PID) added to the snapshot cycle. Not in Phase 1.

---

### 2. Agent Sidebar Panel (renderer)

Replaces both floating panels. Fixed right side, same position and card style as the node detail panel.

**Structure:**

- Header: "Fere Agent" title + "Run Scan" button + dismiss X
- Finding cards (newest on top), each containing:
  - Severity badge: `CRITICAL` / `WARNING` / `INFO` / `SUGGESTION`
  - Affected service name (clicking highlights that node on graph)
  - One-line summary
  - Expandable detail: what was detected + suggested fix
  - `[Apply Fix]` button (safe actions only) with inline confirm step
  - `[Copy Fix]` button (always present)
- Empty state: "No issues detected"

**Apply Fix is available on all findings** — command actions get a one-liner inline confirm, file write actions get an inline diff preview. No modals, always inline. One extra click prevents misfire.

---

### 3. Node-Level Indicator (graph layer)

When a finding exists for a service, a small pulsing badge appears on the node's top-right corner.

- Red badge → CRITICAL finding
- Amber badge → WARNING finding
- Clicking the badge opens the agent sidebar scoped to that service

Disappears automatically when the finding resolves.

---

### 4. Node Detail Panel Update

Remove the "Ask Fere" and "Diagnose Service" button grid. Replace with a single **"View Agent Findings"** button. If an active finding exists for that service, the button pulses.

---

### 5. Apply Fix — Safe Action Registry

The renderer never passes raw shell strings to the main process. It passes a typed action payload. Main validates against a pre-approved safe action list before executing.

**Payload shape:**

```json
{ "type": "kill-port", "port": 4000, "pid": 8823 }
{ "type": "restart-container", "containerId": "abc123" }
{ "type": "pull-image", "image": "postgres:15" }
```

**Apply Fix has two confirmation flows:**

1. **Command actions** — inline one-liner confirm before executing:

   ```
   Kill PID 8823 on port 4000?   [Confirm]  [Cancel]
   ```

2. **File write actions** — inline diff preview before writing:
   ```diff
   + healthcheck:
   +   test: ["CMD", "pg_isready"]
   +   interval: 10s
   [Confirm Write]   [Cancel]
   ```
   Renderer sends a typed patch payload — `{ type: "write-docker-compose", patch: {...} }` — main applies it. Never a raw string.

**Safe action types (Phase 1):**
| Action | Eligible for Apply Fix | Confirmation Flow |
|---|---|---|
| Kill stale port process | Yes | Inline confirm |
| Restart stopped container | Yes | Inline confirm |
| Pull missing image | Yes | Inline confirm |
| Single-file patch (docker-compose, Dockerfile) | Yes | Diff preview + confirm |
| Env var changes (ambiguous file scope) | No — Copy Fix only | — |
| Multi-file changes | No — Copy Fix only | — |

IPC handler: `agent:apply-fix` in `electron/main.js`

---

### 6. Advisory Suggestions

A second mode alongside diagnostics. The agent reads your project statically and surfaces recommendations — not just "something broke" but "here's what you're missing."

**What it reads:**
- `package.json` / `requirements.txt` — dependencies declared vs. services actually running
- `docker-compose.yml` — missing health checks, restart policies, volume mounts
- `.env` files — vars referenced but not set, or set but unused
- Route scan results — auth routes present but no session/JWT service running

**Finding type: `SUGGESTION`** (blue badge, lower priority than errors, shown below diagnostics in sidebar)

Example findings:
```
● SUGGESTION   express-backend
Redis not running
You're importing ioredis but nothing is active on port 6379.

[Apply Fix — Add Redis to docker-compose]   [Dismiss]
```
```
● SUGGESTION   docker-compose.yml
3 services missing health checks
postgres, redis, and worker have no healthcheck defined.

[Apply Fix — Add health checks]   [Copy Fix]   [Dismiss]
```

**Apply Fix for suggestions** uses the diff preview flow — shows exact YAML/config change inline before writing. Same typed payload to main, never a raw string.

**Dismiss behavior:** Per-suggestion "don't show again" persisted locally. Dismissed suggestions don't respawn unless the underlying condition changes (e.g. new dependency added).

**Trigger:** Runs once on startup + after each full structure rebuild (~10s cycle). Not re-evaluated on every fast probe.

---

## UI Summary

| Before                                   | After                                          |
| ---------------------------------------- | ---------------------------------------------- |
| Ask Fere panel (floating, 420px)         | Removed                                        |
| Cross-Service Debugger panel (streaming) | Removed                                        |
| Node detail: Ask Fere + Diagnose buttons | Replaced with "View Agent Findings"            |
| No ambient signal on graph               | Node badge (pulsing dot) on affected services  |
| Manual trigger only                      | Auto-spawn on topology change + manual trigger |

---

## Build Phases

### Phase 1 — Structural agent + UI

1. Build finding engine in `electron/services/` — structural issue detection only
2. Build project reader service — reads `package.json`, `docker-compose.yml`, `.env`, route scan results
3. Build suggestion rules library — pattern-matched rules against project + topology data
4. Add `agent:apply-fix` IPC handler with safe action registry (command + file write flows)
5. Build agent sidebar panel component (diagnostics + suggestions sections)
6. Add node badge layer to graph nodes
7. Update node detail panel (remove old buttons, add findings button)
8. Remove Ask Fere + Debugger components and dead code

### Phase 2 — Metrics history + anomaly triggers

1. Add circular buffer to snapshot cycle (5 min rolling window, CPU/memory per PID)
2. Extend finding engine with anomaly detection rules
3. Expose trend data in finding card detail view

---

## Constraints

- Renderer never executes shell commands or passes raw strings to main
- Apply Fix only available for pre-approved action types
- Agent must not spawn on every minor blip — noise threshold required from day one
- macOS only (relies on `lsof`, `ps` output formats)
