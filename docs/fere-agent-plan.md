# Fere Agent — Feature Plan

## Overview

A unified **Fere Agent** that replaces the old Ask Fere and Cross-Service Debugger panels. It watches the live topology, runs deterministic checks every scan cycle, and surfaces structured findings with severity, category, impact context, and one-click fixes. The current product direction is findings-first: scan, explain, fix, and focus the relevant service in the graph.

---

## Status: Shipped

The findings engine and fix actions are implemented and live in the app. The open-ended chat path has been removed in favor of a tighter findings-first workflow.

---

## Architecture

### Runtime layers

```
Renderer (React + TypeScript)
  └── AgentPanel.tsx           UI — findings-first scan panel
  └── types/electron.d.ts      Shared type contracts

Main process (Electron/Node)
  └── electron/main.js         IPC handlers: agent:scan, agent:apply-fix
  └── electron/services/fereAgent.js
        ├── runScan()           Deterministic findings engine
        ├── executeAction()     Apply approved deterministic fixes
        └── executeTool()       Live topology + file access tools for scan checks
```

### IPC handlers

| Channel | Direction | Description |
|---|---|---|
| `agent:scan` | renderer → main | Run deterministic scan for given nodeIds, returns `AgentFinding[]` |
| `agent:apply-fix` | renderer → main | Execute a typed `AgentFixAction` (kill-port, restart-container, write-file) |

---

## Findings Engine

File: `electron/services/fereAgent.js` → `runScan(snapshot, nodeIds)`

Runs deterministic checks against the live snapshot. No AI, no API calls, no latency. Results include severity, category, human-readable detail, blast-radius impact, and an optional executable fix.

### Detection checks (10 total)

| Check | Function | Severity | Category | What it finds |
|---|---|---|---|---|
| Port conflict | `detectPortConflicts` | critical | connectivity | A port needed by a service is held by a foreign PID |
| Service down | `detectDownServices` | critical | health | Service was active but is no longer responding; includes downstream dependents |
| Cascade impact | `detectCascadeImpact` | critical | connectivity | Down service has 2+ dependents — shows full blast radius |
| Stopped container | `detectStoppedContainers` | warning | health | Docker container in exited/dead state |
| Unhealthy container | `detectUnhealthyContainers` | critical | health | Running container with failing Docker health checks; shows streak + last output |
| Crash-looping container | `detectRestartingContainers` | critical | health | Container stuck in restart loop |
| Disconnected service | `detectDisconnectedServices` | warning | connectivity | Running service with no edges in the topology graph |
| Missing dependency | `detectAdvisory` (dep check) | suggestion | dependency | `package.json` imports a service (Redis, Postgres, etc.) but nothing is on its default port |
| Missing health checks | `detectAdvisory` (compose check) | suggestion | config | `docker-compose.yml` services without a `healthcheck:` block |
| Env var mismatch | `detectEnvMismatches` | warning | config | `.env` / `.env.local` sets `DATABASE_URL`, `REDIS_URL`, etc. pointing to a port with nothing listening |

### Finding shape

```typescript
interface AgentFinding {
  id: string;
  severity: 'critical' | 'warning' | 'suggestion';
  category: 'health' | 'connectivity' | 'config' | 'security' | 'dependency';
  service: string;               // display name of the affected service
  summary: string;               // one-line headline shown in collapsed card
  detail: string;                // full explanation shown when expanded
  impact: string | null;         // blast-radius line, e.g. "Blast radius: cart, checkout"
  affectedServices: string[];    // service names downstream of this finding
  fix: AgentFixAction | null;    // executable or copy-only fix
}
```

### Fix action types

```typescript
type AgentFixAction =
  | { type: 'kill-port'; port: number; pid: number; preview: string; label: string }
  | { type: 'restart-container'; containerId: string; preview: string; label: string }
  | { type: 'write-file'; filePath: string; content: string; label: string }
  | { type: 'copy-only'; preview: string; label: string }   // user copies, no auto-execute
```

`executeAction()` validates all payloads before execution. `write-file` is restricted to paths under `/Users/` or `/home/`. `kill-port` requires integer port + pid. `restart-container` sanitizes the ID.

---

## Panel UI

File: `src/components/AgentPanel.tsx`

Floating built-in panel anchored to the header trigger. Opens from the Sentinel button in the top bar. Closes on Escape.

### Findings surface

The panel is findings-first and intentionally minimal. It runs a deterministic runtime scan when opened, then presents:

- Header status summary (`Scanning`, `All clear`, `N actionable issues`)
- Health score bar
- Grouped findings in `Issues` and `Suggestions`
- One-click actions per finding

**Health score bar** — computed from finding counts: 100 − (critical × 15) − (warning × 5) − (suggestion × 1). Shows percentage, grade label (Excellent/Good/Fair/Poor/Critical), animated fill bar, and count chips.

**Finding cards** — each card shows:
- Severity dot (red/amber/gray)
- Summary headline
- Service name in monospace + category badge (color-coded by category) + "N affected" chip
- Expand → full detail paragraph + impact line + command preview + action buttons

**Action buttons per card:**
- `Apply Fix` — for kill-port and restart-container (inline confirm flow)
- `Copy` — copies fix preview to clipboard
- `Focus Service` — centers the relevant node in the graph
- `Dismiss` — removes from list

**All-clear state** — green circle checkmark icon, "All systems nominal" heading, descriptive subtext.

---

## Key Implementation Details

### Connections bug fix

`get_running_services` and `detectDisconnectedServices` previously used `node.incomingEdges` / `node.outgoingEdges` (fields that don't exist on `GraphNode`). Fixed to build connection arrays from `snapshot.graph.edges`:

```javascript
const edges = snapshot.graph?.edges ?? [];
const nodeById = new Map(nodes.map((n) => [n.id, n.name]));
const incoming = edges.filter((e) => e.target === n.id).map((e) => nodeById.get(e.source));
const outgoing = edges.filter((e) => e.source === n.id).map((e) => nodeById.get(e.target));
```

### File access security

- `write-file` validates absolute path within home directory before writing
- scan-side file reads stay constrained to project paths discovered from the live snapshot

---

## CSS classes (agent panel)

| Class | Purpose |
|---|---|
| `.agp-popup` | Floating built-in panel anchored under the header trigger |
| `.agp-score-bar` | Health score card with track + fill bar |
| `.agp-cat-badge` | Category pill (color + bg from `CATEGORY_META`) |
| `.agp-impact-chip` | "N affected" purple chip in collapsed card header |
| `.agp-row-impact` | Impact box in expanded card body |
| `.agp-all-clear` | All-clear empty state with green circle |
| `.agp-code-block` | Fenced code block (light gray, GitHub style, language badge) |
| `.agp-action-filepath` | Filepath badge in write-file action row |

---

## Environment setup

No API key is required for the shipped Sentinel panel. The current workflow is deterministic and local-first.
