# Request flow tracing — Feature specification

## Summary

Request Flow Tracing transforms the Fere service topology graph from a static dependency map into a live request visualization. When a user fires an HTTP request, it ripples through the graph in real time — edges animate in sequence, latency badges appear at each hop, and a waterfall timeline pinpoints where time is spent.

Zero configuration. Zero code instrumentation. Works with any local service stack.

---

## Motivation

When a multi-service request is slow or failing, developers currently have no way to see where the bottleneck is without:

- Adding `console.log` timestamps to every service (tedious, temporary)
- Setting up OpenTelemetry/Jaeger/Zipkin (hours of setup, requires code changes)
- Using a paid APM like Datadog (expensive, designed for production)

Fere already knows the full service topology — processes, ports, TCP connections, and external APIs. Request Flow Tracing leverages this existing knowledge to detect and visualize request flow automatically by diffing TCP connection state before and after a request.

---

## Implementation notes (current shipped state, March 2026)

The current implementation is **approximate-only** (connection-level inference). Specific deviations from the original spec:

- **Approximate mode only.** No Accuracy Mode toggle, no OTel/Jaeger ingestion path.
- **Trace confidence indicator.** Header shows an `Approximate` badge.
- **Node highlight style.** Trace nodes use a thin black outline — no blue ring, no pulse animation.
- **Trace edge style.** Matches hover-edge style (dark, dotted, streaming); no arrowhead glow.
- **Latency badges.** Black background with light text.
- **Entry and overlay pills.** Monochrome (dark background, light text).
- **Waterfall panel placement.** Left-bottom floating panel, not a full-width bottom drawer.
- **Waterfall sizing.** Auto-sizes by hop count (min/max clamped); no drag-resize handle.
- **Waterfall controls.** Minimize (`−`) to a bottom-left chip; close (`×`).
- **Send split button.** Trace toggle is static in active state; split-button hover does not pop out.

---

## Design

### Entry points

**Primary — CurlBuilder trace toggle**

The Send button becomes a split button with a persistent trace toggle:

```
┌─────────────────┬───┐
│  ▶  Send Request │ ⟡ │   ← trace toggle (off = outline, on = filled)
└─────────────────┴───┘
```

When trace is enabled and the user clicks Send:
1. Request fires normally
2. App auto-switches to the Service Map tab
3. Graph enters trace mode
4. Waterfall panel appears on completion

**Secondary — Graph context menu**

Right-click on a service node with ports and discovered routes:

```
  Open in Browser
  Open in Terminal
  Trace Request →     ← new; opens route picker submenu
  ─────────────────
  Kill Process
```

Visible when: `hasPort && node.routes?.length > 0 && !isNotRunning`

**Tertiary — Node detail panel route icons**

Each route in the detail panel gets a trace icon (⟡) for one-click tracing with default settings.

---

### Graph visualization phases

#### Idle

Normal graph rendering. No trace UI visible.

#### Capturing (request in flight)

- Non-participating nodes dim (`rf-node-dimmed` class: opacity 0.18, grayscale 50%)
- Origin pill appears above the target node showing method and path
- Edges activate in detection order with draw-on animation and latency badges

Latency badge color coding:

| Latency | Color | Hex |
|---------|-------|-----|
| < 100 ms | Green | `#22C55E` |
| 100–300 ms | Blue | `#3B82F6` |
| 300–1000 ms | Yellow | `#EAB308` |
| > 1000 ms | Red | `#EF4444` |

#### Complete (response received)

- All trace edges remain highlighted with latency badges
- Origin pill updates to show total round-trip time
- Waterfall panel slides up from the bottom
- Highest-latency edge gets a warning accent

#### Dismiss

Triggered by: Escape, the `×` button on the waterfall panel, or clicking the dimmed graph background.

On dismiss: trace visuals fade out (300 ms opacity transition), graph returns to normal rendering.

---

### Waterfall timeline panel

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⟡ Trace: POST /api/checkout                           863ms total      ×  │
│─────────────────────────────────────────────────────────────────────────────│
│                              0ms     200ms     400ms     600ms     863ms    │
│                               │        │         │         │         │     │
│  → express:3001         ██████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   12ms    │
│    → redis:6379         ░░████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    6ms    │
│    → payment:8000       ░░░░░░██████████████████████████████░░░░  832ms    │
│      → api.stripe.com   ░░░░░░░░██████████████████████████░░░░░░  825ms    │
│      → postgres:5432    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██░░░░░    5ms    │
│  ← 200 OK              ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░██  863ms    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Visual spec:**

| Property | Value |
|----------|-------|
| Default height | 200 px |
| Background | `var(--bg-primary)` with `1px solid var(--border-color)` top border |
| Label font | JetBrains Mono, 12 px |
| Header font | Instrument Sans, 13 px, weight 500 |
| Row height | 28 px |
| Indentation | 16 px per nesting level |
| Arrow prefix | `→` outgoing, `←` response |
| Bar corner radius | 3 px |

**Interactions:**

| Action | Behavior |
|--------|----------|
| Hover row | Corresponding graph edge and nodes highlight (bidirectional) |
| Click row | Graph pans to center target node; opens node detail panel |
| Click header | Toggle between expanded panel and collapsed chip (`⟡ POST /api/checkout — 863ms`) |
| Click `×` | Dismiss trace entirely |

---

## API contract

### Backend service

`electron/services/traceCapture.js` — connection-diff capture, polling loop, hop resolution.

IPC channel: `execute-traced-request`

### Trace data types

```typescript
interface TraceHop {
  sourceNodeId: string;
  targetNodeId: string;
  startTime: number;        // ms from trace start
  endTime: number;          // ms from trace start
  latency: number;          // endTime - startTime
  connectionType: 'tcp' | 'external';
  inferred: boolean;        // true if inferred from topology, not observed
}

interface TraceResult {
  id: string;
  timestamp: number;
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  };
  response: {
    status: number;
    statusText: string;
    time: number;
  } | null;
  hops: TraceHop[];
  totalTime: number;
  timedOut: boolean;
}
```

### Capture algorithm

```
executeTracedRequest(requestConfig, graphNodes):
  1. Snapshot established TCP connections (before)
  2. Start connection poller (every 200 ms):
     - diff current vs. before, filtered to known graph PIDs
     - for each new connection: resolve source PID → node, target port → node
     - record { sourceNode, targetNode, detectedAt }
  3. Fire HTTP request (reuses existing execute-http-request logic)
  4. On response (or 30 s timeout): stop poller, capture final new connections
  5. Build TraceResult: order by detectedAt, calculate hop latency, infer missed hops
```

---

## Frontend state management

### TraceContext (`src/components/graph/traceContext.ts`)

```typescript
interface TraceState {
  phase: 'idle' | 'capturing' | 'animating' | 'complete';
  activeHopIndex: number;
  traceNodeIds: Set<string>;
  traceEdgeIds: Set<string>;
  result: TraceResult | null;
}
```

Provided at the App level (above both `GraphView` and `CurlBuilder`) so trace state is shared across the tab switch from Requests to Service Map.

When `traceState.phase !== 'idle'`, trace dimming and highlighting take priority over `HoverContext` behavior.

### Animation sequencing

1. Set `phase = 'animating'`, `activeHopIndex = 0`
2. For each hop: add to `traceNodeIds` and `traceEdgeIds`, render draw-on animation, wait `max(300ms, hop.latency × animationScale)`, advance
3. After all hops: set `phase = 'complete'`, show waterfall panel

`animationScale` compresses real latency so total animation stays under 5 seconds while preserving relative proportions.

### Trace history

Max 20 entries (FIFO eviction). Replay re-runs the animation sequence without re-firing the request.

---

## Files

### New files

| File | Purpose |
|------|---------|
| `src/components/graph/traceContext.ts` | `TraceContext`, `TraceState`, `useTraceState()` |
| `src/components/graph/TraceEdge.tsx` | Draw-on edge animation with latency badge |
| `src/components/graph/TraceWaterfall.tsx` | Waterfall panel: rows, timeline, collapse, resize |
| `src/components/graph/TraceOverlay.tsx` | Origin pill overlay anchored above target node |
| `electron/services/traceCapture.js` | Connection-diff capture, polling, hop resolution |

### Modified files

| File | Change |
|------|--------|
| `src/types/electron.d.ts` | Add `TraceHop`, `TraceResult`; add `executeTracedRequest` to `ElectronAPI` |
| `electron/preload.js` | Expose `executeTracedRequest` |
| `electron/main.js` | Register `execute-traced-request` handler |
| `src/App.tsx` | Wrap with `TraceContext.Provider`; add tab indicator dot when trace is active |
| `src/components/GraphView.tsx` | Consume `TraceContext`; render `TraceWaterfall` and `TraceOverlay` |
| `src/components/CurlBuilder.tsx` | Trace toggle on Send button; handle trace-enabled send flow |
| `src/components/graph/flowNodes.tsx` | Apply `rf-node-trace-active` class; trace dimming overrides hover |
| `src/components/graph/ArrowEdge.tsx` | Register `traceBezier`/`traceStep` types; dim non-trace edges |
| `src/components/graph/ContextMenu.tsx` | Add "Trace Request" menu item with route picker |
| `src/components/graph/NodeDetailPanel.tsx` | Add trace icon per route; add "Trace Info" section for trace nodes |

---

## Edge rendering

### New edge types

| Type | Usage |
|------|-------|
| `traceBezier` | Vertical trace edges |
| `traceStep` | Horizontal same-layer trace edges |

### Trace edge visual

```
Base stroke:  #3B82F6 at 0.3 opacity, 3px width
Top stroke:   #3B82F6 at 1.0 opacity, 2px solid
Animation:    stroke-dashoffset: pathLength → 0 (draw-on)
Glow:         filter: drop-shadow(0 0 3px rgba(59, 130, 246, 0.5))
```

Non-participating edges dim to `opacity: 0.08` during an active trace.

---

## Error and edge cases

| Scenario | Behavior |
|----------|---------|
| Target service is down | Warning toast: "{service}:{port} appears to be down. Trace anyway?" |
| Request returns 4xx/5xx | Trace continues; response row in waterfall shows red status badge |
| Request times out (30 s) | Edges animate up to last detected hop; last row shows "Timed out after 30s" |
| No downstream hops detected | Single node highlights; waterfall shows one row (valid outcome, not an error) |
| Ambiguous hop ordering | Parallel hops animate simultaneously; waterfall shows overlapping bars |
| Inferred hops | Dashed blue edge; waterfall bar has dashed border and "(inferred)" label |
| Service crashes during trace | Node flashes red; edge turns red; waterfall shows "Service exited" |

---

## Known limitations

| Limitation | Cause | Mitigation |
|------------|-------|------------|
| Short-lived connections (< 200 ms) may be missed | Connection opens and closes between poll intervals | Show as inferred hop (dashed edge) using known topology |
| Connection reuse (keep-alive) produces no new TCP connection | HTTP keep-alive pools reuse sockets | Infer from topology: if A connects to B and B had activity, include as inferred |
| External API call timing is approximate | Only TCP layer is observed | Match against provider catalog for identification |
| Cannot see HTTP-level detail at each hop | Only TCP layer, not HTTP layer | HTTP detail available only for the initial request |
| Parallel downstream calls appear simultaneous | Cannot determine causal ordering | Show as parallel branches at the same timeline position |

---

## Open questions

- Should trace history survive app restarts (disk persistence)?
- Should trace results be shareable via the graph share/export flow?
- Is there value in a "replay with live re-fire" mode to check whether a slow path has improved?
