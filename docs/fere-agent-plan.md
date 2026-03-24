# Fere Agent — Feature Plan

## Overview

A unified **Fere Agent** that replaces the old Ask Fere and Cross-Service Debugger panels. It watches the live topology, runs deterministic checks every scan cycle, and surfaces structured findings with severity, category, impact context, and one-click fixes. A second mode provides an AI-powered chat backed by OpenAI GPT-4o-mini with live topology tools and project file access.

---

## Status: Shipped

Both the Findings engine and AI Chat are fully implemented. The panel is live in the app.

---

## Architecture

### Runtime layers

```
Renderer (React + TypeScript)
  └── AgentPanel.tsx           UI — findings tab + chat tab
  └── types/electron.d.ts      Shared type contracts

Main process (Electron/Node)
  └── electron/main.js         IPC handlers: agent:scan, agent:chat, agent:apply-fix, agent:stop
  └── electron/services/fereAgent.js
        ├── runScan()           Deterministic findings engine
        ├── runChatAgent()      OpenAI streaming async generator
        ├── executeTool()       Live topology + file access tools
        └── executeAction()     Safe action executor (kill-port, restart-container, write-file)
```

### IPC handlers

| Channel | Direction | Description |
|---|---|---|
| `agent:scan` | renderer → main | Run deterministic scan for given nodeIds, returns `AgentFinding[]` |
| `agent:chat` | renderer → main | Start streaming chat with message history + nodeIds |
| `agent:stream` | main → renderer | Stream events (text_delta, tool_call, tool_result, action, done, error) |
| `agent:apply-fix` | renderer → main | Execute a typed `AgentFixAction` (kill-port, restart-container, write-file) |
| `agent:stop` | renderer → main | Abort the current streaming chat |

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

## AI Chat Agent

File: `electron/services/fereAgent.js` → `runChatAgent(messages, snapshot, nodeIds)`

OpenAI GPT-4o-mini with function calling, streamed over IPC. The agent has access to 6 live tools and a system prompt built from the real snapshot state.

### Model

- Model: `gpt-4o-mini`
- Temperature: 0.3
- Max iterations: 10 (prevents runaway tool loops)
- Streaming: `stream: true` with SSE-style delta events forwarded over IPC

### Live tools

| Tool | Description |
|---|---|
| `get_running_services` | Returns all nodes with name, type, health, ports, PID, incoming/outgoing connections (built from `snapshot.graph.edges`) |
| `check_port` | Runs `lsof -i :PORT` to check what's holding a port right now |
| `get_container_logs` | Fetches recent Docker container logs via `docker logs --tail N` |
| `list_project_files` | Walks a project directory (up to depth 4, skips node_modules/.git/dist/etc.), returns absolute paths |
| `read_project_file` | Reads any file up to 8KB; strips secret values from `.env` files |
| `propose_fix` | Emits a typed `AgentFixAction` for the user to review and confirm in the UI |

### Streaming events

```typescript
type AgentStreamEvent =
  | { type: 'text_delta'; text: string }       // chunk of assistant text
  | { type: 'tool_call'; name: string; label: string }   // tool started
  | { type: 'tool_result'; name: string; summary: string }  // tool finished
  | { type: 'action'; action: AgentFixAction } // proposed fix for user approval
  | { type: 'done' }
  | { type: 'error'; error: string }
```

---

## Panel UI

File: `src/components/AgentPanel.tsx`

Right-side sliding panel (380px wide, full height below header). Opens from the Fere logo button in the top bar. Closes on Escape.

### Findings tab

**Health score bar** — computed from finding counts: 100 − (critical × 15) − (warning × 5) − (suggestion × 1). Shows percentage, grade label (Excellent/Good/Fair/Poor/Critical), animated fill bar, and count chips.

**Finding cards** — grouped into Issues and Suggestions sections. Each card shows:
- Severity dot (red/amber/gray)
- Summary headline
- Service name in monospace + category badge (color-coded by category) + "N affected" chip
- Expand → full detail paragraph + impact line (purple box with blast-radius text) + command preview + action buttons

**Action buttons per card:**
- `Apply Fix` — for kill-port and restart-container (inline confirm flow)
- `Copy` — copies fix preview to clipboard
- `Ask AI` — pre-fills chat with an investigate prompt for that finding
- `Dismiss` — removes from list

**All-clear state** — green circle checkmark icon, "All systems nominal" heading, descriptive subtext.

### Chat tab

**Input features:**
- `@servicename` autocomplete — dropdown with health dot, name, type; selecting injects `[Service context: name | type | health | ports | path]` into the message so the agent skips redundant tool calls
- Stop button to abort streaming mid-response
- Enter to send, Escape to close mention dropdown

**Message rendering:**
- Full markdown: fenced code blocks (syntax-highlighted, language badge), `##`/`###` headings, numbered + bullet lists, **bold**, `inline code`
- Service names become clickable blue pills → fires `fere:focus-node` CustomEvent → `GraphView.tsx` zooms to the node
- Syntax highlighting for Python, JS/TS/JSX/TSX, YAML, JSON, Bash/Shell
- RAF-batched streaming text (accumulates deltas in a ref, flushes via `requestAnimationFrame` to avoid re-rendering on every byte)

**Tool call rows** — spinner while running → green checkmark when done (opacity dimmed). Prevents "spinner never stops" issue by handling `tool_result` events to mark the last unfinished call as done.

**Action rows** — for `propose_fix` actions from AI. Shows filepath badge + syntax-highlighted code preview for write-file actions. Same confirm/cancel flow as findings.

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

### OOM / V8 heap fix

Running `renderMarkdown()` on every streaming text delta caused hundreds of React renders/sec with large regex matches → V8 out-of-memory. Fixed by:
1. `requestAnimationFrame` batching: accumulate deltas in `streamBufRef`, flush at ~60fps
2. `useMemo` for `nameToId` map and compiled regex (only recomputes when `nodes` changes)
3. Markdown renders live during streaming — RAF batching keeps frame rate manageable

### `renderInline` infinite loop fix

Unclosed backtick or `**` in streaming text caused `renderInline` to match `next === 0` infinitely. Fixed by advancing 1 or 2 chars when the pattern doesn't match at position 0:

```typescript
const advance = rem.startsWith("**") ? 2 : 1;
result.push(...renderPlain(rem.slice(0, advance)));
rem = rem.slice(advance);
```

### OpenAI streaming tool_calls fix

OpenAI streams tool calls across multiple chunks with `tc.index`. Each slot must be initialized with `type: "function"` or the API returns a 400. Fixed by initializing:

```javascript
toolCalls[tc.index] = { id: "", type: "function", function: { name: "", arguments: "" } }
```

### File access security

- `list_project_files` and `read_project_file` only allow paths under `/Users/` or `/home/`
- `read_project_file` strips actual values from `.env` files (returns `KEY=[redacted]`)
- `write-file` validates absolute path within home directory before writing
- System prompt injects real `projectPaths` from the snapshot so AI never uses placeholder paths

---

## CSS classes (agent panel)

| Class | Purpose |
|---|---|
| `.agp-popup` | Right-side panel (top:52px, right:0, bottom:0, width:380px, slide-in animation) |
| `.agp-score-bar` | Health score card with track + fill bar |
| `.agp-cat-badge` | Category pill (color + bg from `CATEGORY_META`) |
| `.agp-impact-chip` | "N affected" purple chip in collapsed card header |
| `.agp-row-impact` | Purple impact box in expanded card body |
| `.agp-all-clear` | All-clear empty state with green circle |
| `.agp-code-block` | Fenced code block (light gray, GitHub style, language badge) |
| `.agp-service-pill` | Clickable blue service name pill in chat |
| `.agp-mention-list` | `@` autocomplete dropdown |
| `.agp-tool-call-done` | Completed tool call row (opacity 0.55, green checkmark) |
| `.agp-action-filepath` | Filepath badge in write-file action row |

---

## Environment setup

Requires `OPENAI_API_KEY` in `.env` at the project root. Loaded via `require("dotenv").config()` at the top of `electron/main.js`. Chat tab is non-functional without it; findings tab works without any API key.
