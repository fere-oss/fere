# Request Flow Tracing — Feature Specification

## 1. Overview

Request Flow Tracing transforms Fere's service topology graph from a static dependency map into a live request visualization. When a user fires an HTTP request, they watch it ripple through the graph in real time — edges light up in sequence, latency badges appear at each hop, and a waterfall timeline pinpoints exactly where time is spent.

**Zero configuration. Zero code instrumentation. Works with any local service stack.**

### Problem

When a multi-service request is slow or failing, developers currently have no way to see where the bottleneck is without either:
- Adding `console.log` timestamps to every service (tedious, temporary)
- Setting up OpenTelemetry/Jaeger/Zipkin (hours of setup, requires code changes per service)
- Using a paid APM like Datadog (expensive, designed for production, still requires instrumentation)

### Solution

Fere already knows the full service topology — which processes exist, which ports they listen on, which TCP connections they maintain, and which external APIs they call. Request Flow Tracing leverages this existing knowledge to detect and visualize request flow automatically by diffing TCP connection state before and after a request.

### Current Implementation Notes (March 2026)

The implementation in this branch is intentionally **approximate-only** (connection-level), with several UX/style updates from the original spec:

- **Approximate mode only**: no Accuracy Mode toggle, no OTel/Jaeger ingestion path.
- **Trace confidence messaging**: header includes an `Approximate` badge to clarify inferred behavior.
- **Node highlight style**: trace nodes use a **thin black outline** (no blue ring/glow, no pulse animation).
- **Trace edges style**: trace edges now match hover-edge style (dark, dotted, streaming), without arrowhead glow styling.
- **Latency badges**: edge latency badges use a black background with light text for visual consistency.
- **Entry/overlay pill styling**: request pills are monochrome (dark background, light text/icons).
- **Waterfall panel placement**: panel is a **left-bottom floating panel**, not a full-width bottom drawer.
- **Waterfall sizing**: panel height auto-sizes based on hop count (with min/max clamp); no drag-resize handle.
- **Waterfall controls**: supports minimize (`-`) to a bottom-left chip and close (`x`).
- **Waterfall readability**:
  - service logos shown in rows (same brand icon inference used by graph nodes),
  - fast traces use fractional axis labels,
  - sub-millisecond hop labels render as `<1ms`,
  - truncated names expose full values via tooltip.
- **Failure visualization**:
  - response row is color-coded by HTTP status (existing behavior),
  - one **best-effort** intermediate hop is flagged as `likely error` on 5xx/timeout traces.
- **Send split button polish**: trace toggle is static in active state (no glow), and split-button hover no longer causes pop-out/bulge.

---

## 2. User Journey

### 2.1 Starting a Trace

Three entry points, ordered by expected usage frequency:

#### A. CurlBuilder Trace Toggle (Primary)

The existing Send button in the Requests tab becomes a split button with a trace toggle:

```
┌─────────────────┬───┐
│  ▶  Send Request │ ⟡ │   ← trace toggle (off = outline, on = filled + pulse)
└─────────────────┴───┘
```

When trace is enabled and the user clicks Send:
1. Request fires normally (same execution path as today)
2. App auto-switches to the Service Map tab
3. Graph enters trace mode with overlay active
4. Waterfall panel slides up from bottom on completion

This is the primary entry point because users already build requests here. The toggle is persistent within a session — once enabled, every Send is a traced send until toggled off.

#### B. Graph Context Menu

Right-clicking a service node that has ports AND discovered routes shows a new menu item:

```
  Open in Browser
  Open in Terminal
  Trace Request →     ← new, with route picker submenu
  ─────────────────
  Kill Process
```

The submenu shows discovered routes (same list rendered in ServiceNodes). Selecting a route fires a trace immediately with defaults (GET, no body, no custom headers). For non-GET routes, a compact inline builder appears for method/body input.

Visibility condition: `hasPort && node.routes?.length > 0 && !isNotRunning`

#### C. Node Detail Panel Route Icons

The routes section in NodeDetailPanel already displays routes like `GET /api/users`. Each route gains a small trace icon (⟡) to its right. Clicking it fires a one-click trace for that specific route with default settings.

Best for: quick GET endpoint tracing without leaving the graph view.

---

### 2.2 During the Trace (Graph Visualization)

The trace has four visual phases that the graph transitions through:

#### Phase 1: Idle

Graph renders exactly as it does today. No trace-related UI is visible.

#### Phase 2: Capturing (request in flight)

Triggered the moment the traced request is fired:

1. **Non-participating nodes dim.** Reuses the existing `rf-node-dimmed` CSS class (opacity 0.18, grayscale 50%). Every node not yet identified as part of the trace path is dimmed. The initial target node gets a blue pulsing ring via a new `rf-node-trace-active` class.

2. **Request origin pill appears.** A floating pill anchored above the target service node:
   ```
   ┌───────────────────────────┐
   │  ▶  POST /api/checkout    │
   └───────────────────────────┘
   ```
   Styled as a rounded rect with the app's monospace font (JetBrains Mono), background `rgba(59, 130, 246, 0.12)`, border `1px solid #3B82F6`. Not a graph node — an absolutely positioned overlay so it doesn't affect layout.

3. **Edges activate in sequence.** As each downstream hop is detected by the backend polling:
   - The edge from source → target gets a **draw-on animation**: the dashed stroke pattern is replaced with a solid blue stroke that grows from source to target via `stroke-dashoffset` CSS transition. Minimum draw duration: 300ms. For hops with known latency, draw duration scales proportionally (capped at 2s for very slow hops).
   - Edge color: `#3B82F6` (blue) with glow via `filter: drop-shadow(0 0 3px rgba(59, 130, 246, 0.5))`.
   - A **latency badge** appears at the edge midpoint once the hop completes. Reuses the same SVG structure as the existing `bundleCount` badge in ArrowEdge.tsx (rounded rect with centered text). Displays milliseconds (e.g., `12ms`, `825ms`). Background color coded by latency:

     | Latency     | Badge Color | Hex       |
     |-------------|-------------|-----------|
     | < 100ms     | Green       | `#22C55E` |
     | 100–300ms   | Blue        | `#3B82F6` |
     | 300–1000ms  | Yellow      | `#EAB308` |
     | > 1000ms    | Red         | `#EF4444` |

4. **Nodes activate on reach.** When a hop's target node is reached:
   - Brief scale pulse: 1.0 → 1.03 → 1.0 over 200ms (CSS `transform` transition)
   - Blue ring: `box-shadow: 0 0 0 2px #3B82F6, 0 0 8px rgba(59, 130, 246, 0.3)`
   - Health dot temporarily overridden to blue
   - The node is removed from the dimmed set

5. **Sequential playback.** Edges animate one at a time in detection order. A fast hop (12ms) draws quickly; a slow hop (825ms) draws slowly. This makes latency distribution visible without reading numbers — the user can see time being "spent" on each edge.

#### Phase 3: Complete (response received)

1. All trace edges remain highlighted with latency badges visible.
2. The origin pill updates to show total round-trip time:
   ```
   ┌─────────────────────────────────────┐
   │  ▶  POST /api/checkout  —  863ms    │
   └─────────────────────────────────────┘
   ```
3. The waterfall timeline panel slides up from the bottom (see Section 2.3).
4. **Bottleneck highlighting**: The edge with the highest latency gets a warning accent — yellow badge if >300ms, red if >1000ms — with a subtle pulsing glow to draw the eye.

#### Phase 4: Dismiss

Triggered by any of:
- Pressing **Escape** (consistent with existing panel dismiss behavior)
- Clicking the **✕** button on the waterfall panel
- Clicking the dimmed graph background

On dismiss:
- All trace visuals fade out over 300ms (opacity transition)
- Graph returns to normal rendering
- Trace result is retained in trace history for replay

---

### 2.3 Waterfall Timeline Panel

#### Position

Slides up from the bottom of the GraphView container, overlaying the lower portion of the graph. Same animation approach as NodeDetailPanel (which slides in from the right) but vertical: `translateY(100%) → translateY(0)` over 200ms ease-out.

#### Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  ⟡ Trace: POST /api/checkout                           863ms total      ✕  │
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

#### Visual Specification

| Property | Value |
|----------|-------|
| Default height | 200px |
| Resizable | Yes, via drag handle on top border |
| Background | `var(--bg-primary)` with `1px solid var(--border-color)` top border |
| Font (labels) | JetBrains Mono, 12px |
| Font (header) | Instrument Sans, 13px, weight 500 |
| Row height | 28px |
| Indentation | 16px per nesting level |
| Arrow prefix | `→` for outgoing hops, `←` for response |
| Timeline axis | Top of panel, tick marks at even intervals |
| Bar corner radius | 3px |

#### Bar Colors

Bars use the same latency color scale as edge badges:
- Green (`#22C55E`): < 100ms
- Blue (`#3B82F6`): 100–300ms
- Yellow (`#EAB308`): 300–1000ms
- Red (`#EF4444`): > 1000ms

The slowest bar gets a subtle pulsing glow animation (`box-shadow` pulse, 1.5s ease-in-out infinite) to immediately identify the bottleneck.

#### Interactions

| Action | Behavior |
|--------|----------|
| Hover waterfall row | Corresponding edge and source/target nodes highlight on graph (bidirectional) |
| Click waterfall row | Graph pans to center the target node via `reactFlowInstance.setCenter()` and opens its NodeDetailPanel |
| Drag top border | Resize panel height (min 120px, max 50% of graph height) |
| Click header | Toggle between expanded panel and collapsed single-row summary (`⟡ POST /api/checkout — 863ms`) |
| Click ✕ | Dismiss trace entirely |

---

## 3. Trace Data Collection

### 3.1 Architecture

New backend service: `electron/services/traceCapture.js`
New IPC handler: `execute-traced-request`

The trace capture uses a **connection-diff** approach that leverages Fere's existing TCP connection monitoring:

```
                     Main Process
                    ┌──────────────────────────────────────┐
                    │                                      │
  Renderer ────────►│  1. Snapshot TCP connections (before) │
  (trace request)   │  2. Fire HTTP request                │
                    │  3. Poll connections every ~200ms     │
                    │  4. Snapshot TCP connections (after)  │
                    │  5. Diff → new connections = hops     │
                    │  6. Map to graph nodes via port       │
                    │  7. Return TraceResult                │
                    │                                      │
                    └──────────────────────────────────────┘
```

### 3.2 Capture Algorithm

```
function executeTracedRequest(requestConfig, graphNodes):
  1. beforeConns = getEstablishedConnections()  // existing function
  2. knownPids = Set of all PIDs from graphNodes
  3. timeline = []

  4. Start connection poller (every 200ms):
     - currentConns = getEstablishedConnections()
     - newConns = currentConns - beforeConns (filtered to knownPids)
     - For each new connection:
       - Resolve source PID → graph node
       - Resolve target port/host → graph node or external API
       - Record { sourceNode, targetNode, detectedAt: Date.now() }
       - Add to timeline

  5. Fire HTTP request (reuse existing execute-http-request logic)

  6. On response (or timeout after 30s):
     - Stop poller
     - afterConns = getEstablishedConnections()
     - Capture any final new connections

  7. Build TraceResult:
     - Order timeline entries by detectedAt
     - Calculate latency per hop (time between detection and next hop)
     - Infer missed hops from topology (known edges where target showed activity)
     - Return { hops, response, totalTime }
```

### 3.3 Data Types

```typescript
interface TraceHop {
  sourceNodeId: string;          // graph node ID of the caller
  targetNodeId: string;          // graph node ID of the callee
  startTime: number;             // milliseconds from trace start
  endTime: number;               // milliseconds from trace start
  latency: number;               // endTime - startTime
  connectionType: 'tcp' | 'external';
  inferred: boolean;             // true if detected via topology rather than connection diff
}

interface TraceResult {
  id: string;                    // unique trace ID (uuid)
  timestamp: number;             // when trace was initiated
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
  };
  response: {
    status: number;
    statusText: string;
    time: number;                // total response time in ms
  } | null;                      // null if timed out
  hops: TraceHop[];
  totalTime: number;
  timedOut: boolean;
}
```

### 3.4 Known Limitations

| Limitation | Cause | Mitigation |
|------------|-------|------------|
| Short-lived connections (< 200ms) may be missed | Connection opens and closes between poll intervals | Show as "inferred" hop (dashed edge) using known topology edges |
| Connection reuse (keep-alive) produces no new TCP connection | HTTP keep-alive pools reuse sockets | Infer from topology: if A is known to connect to B, and B had activity during trace window, include as inferred hop |
| External API call timing is approximate | Can only detect new outbound connections to non-local IPs | Match against existing external API provider catalog for identification |
| Cannot see HTTP-level detail (headers, body) at each hop | Only observing TCP layer, not HTTP layer | Show connection-level data only; HTTP detail is available for the initial request via normal response |
| Parallel downstream calls appear as simultaneous | Cannot determine causal ordering of parallel calls | Show as parallel branches in waterfall (bars at same timeline position) |

---

## 4. Frontend State Management

### 4.1 TraceContext

New React context following the same pattern as the existing `HoverContext` in `src/components/graph/hoverContext.ts`:

```typescript
// src/components/graph/traceContext.ts

interface TraceState {
  phase: 'idle' | 'capturing' | 'animating' | 'complete';
  activeHopIndex: number;        // which hop is currently animating (-1 if none)
  traceNodeIds: Set<string>;     // nodes participating in the trace
  traceEdgeIds: Set<string>;     // edges participating in the trace
  result: TraceResult | null;    // full trace data once complete
}
```

**Provider placement**: At the App level (above both GraphView and CurlBuilder) so trace state is shared when auto-switching from Requests tab to Service Map tab.

**Priority over HoverContext**: In `FlowServiceNodeInner`, when `traceState.phase !== 'idle'`, trace dimming/highlighting takes precedence over hover dimming/highlighting. When trace is idle, hover behavior is unchanged.

### 4.2 Trace Animation Sequencing

When a `TraceResult` arrives from the backend, the frontend plays it back as an animation:

1. Set `phase = 'animating'`, `activeHopIndex = 0`
2. For each hop in order:
   - Add hop's source and target to `traceNodeIds`
   - Add corresponding edge to `traceEdgeIds`
   - The TraceEdge component renders the draw-on animation
   - Wait for `max(300ms, hop.latency * animationScale)` before advancing
3. After all hops played: set `phase = 'complete'`, show waterfall panel

`animationScale` compresses real latency into animation time: e.g., 825ms real → ~1.2s animation. This keeps total animation under 5 seconds for typical traces while preserving relative proportions.

### 4.3 Trace History

Completed traces are stored in an array (max 20 entries, FIFO eviction). Users can replay a previous trace from:
- The waterfall panel's history button
- The CurlBuilder history tab (traces are marked with a ⟡ icon)

Replay re-runs the animation sequence on the graph without re-firing the request.

---

## 5. Edge Rendering

### 5.1 New Edge Types

Two new edge types added to `flowEdgeTypes` in `ArrowEdge.tsx`:

| Type | Usage |
|------|-------|
| `traceBezier` | Vertical trace edges (same path computation as `arrowBezier`) |
| `traceStep` | Horizontal same-layer trace edges (same as `arrowStep`) |

### 5.2 Trace Edge Visual

Extends the existing `EdgePath` component pattern:

```
Base stroke:   #3B82F6 at 0.3 opacity, 3px width (blue glow)
Top stroke:    #3B82F6 at 1.0 opacity, 2px width, solid (not dashed)
Animation:     stroke-dasharray = pathLength, stroke-dashoffset transitions from pathLength → 0
Glow:          filter: drop-shadow(0 0 3px rgba(59, 130, 246, 0.5))
```

The draw-on effect uses the SVG path's total length:
- Initially: `stroke-dasharray: <pathLength>; stroke-dashoffset: <pathLength>` (invisible)
- Animate to: `stroke-dashoffset: 0` (fully drawn)
- Duration: proportional to hop latency (see Section 4.2)

### 5.3 Latency Badge

Same SVG structure as the existing bundle count badge:

```svg
<g transform="translate(labelX, labelY)">
  <rect x="-20" y="-10" width="40" height="20" rx="10" fill="{latencyColor}" />
  <text x="0" y="1" text-anchor="middle" dominant-baseline="middle"
        fill="white" font-size="10" font-weight="600" font-family="JetBrains Mono">
    {latency}ms
  </text>
</g>
```

Badge width adjusts to text content (measured or estimated from character count).

### 5.4 Non-participating Edges

During an active trace, edges not in `traceEdgeIds` get dimmed: `opacity: 0.08`. This focuses attention on the trace path.

---

## 6. Error & Edge Case Handling

| Scenario | Before Trace | During Trace | After Trace |
|----------|--------------|--------------|-------------|
| **Target service is down** | Show warning toast: "{service}:{port} appears to be down. Trace anyway?" with Proceed/Cancel | N/A | N/A |
| **Request returns 4xx/5xx** | N/A | Trace continues normally (errors still flow through services) | Response row in waterfall shows red status badge; origin pill shows status code in red |
| **Request times out (30s)** | N/A | Edges animate up to last detected hop; final pending edge turns red | Waterfall shows partial bars; last row: "Timed out after 30s"; origin pill shows timeout indicator |
| **No downstream hops detected** | N/A | Single node highlights (target only) | Waterfall shows single row: the target service handling the request alone. Valid outcome, not an error. |
| **Ambiguous hop ordering** | N/A | Parallel hops animate simultaneously | Waterfall shows overlapping bars at the same timeline position |
| **Inferred hops (missed by polling)** | N/A | Edge draws as dashed blue line instead of solid | Waterfall bar has dashed border; "(inferred)" label |
| **Service crashes during trace** | N/A | Node flashes red, edge to it turns red | Waterfall row shows red bar with "Service exited" label |

---

## 7. Integration Points

### 7.1 Existing UI Coexistence

| System | Integration |
|--------|-------------|
| **HoverContext** | TraceContext takes priority when `phase !== 'idle'`. Hover still works during traces but only affects non-trace nodes. |
| **NodeDetailPanel** | When a node is part of an active trace, the detail panel gains a "Trace Info" section showing: hop index, latency to/from this node, upstream/downstream nodes in the trace. |
| **Edge rendering** | During a trace, participating edges swap from `arrowBezier`/`arrowStep` to `traceBezier`/`traceStep` type. On dismiss, they revert. |
| **Tab bar** | When a trace is active and the user is on a different tab (Containers, Requests, Database), a small blue pulsing dot appears on the "Service Map" tab label. |
| **Escape key** | Pressing Escape while a trace is active dismisses the trace (consistent with existing panel dismiss behavior). If both a trace and NodeDetailPanel are open, Escape closes the detail panel first, then the trace on second press. |

### 7.2 Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Escape` | Dismiss active trace (or close detail panel first if open) |

No other new keyboard shortcuts. The feature is primarily mouse-driven.

---

## 8. Files

### 8.1 New Files

| File | Purpose |
|------|---------|
| `src/components/graph/traceContext.ts` | `TraceContext` React context, `TraceState` type, `useTraceState()` hook, context provider |
| `src/components/graph/TraceEdge.tsx` | `TraceBezierEdge` and `TraceStepEdge` components with draw-on animation and latency badge |
| `src/components/graph/TraceWaterfall.tsx` | Bottom panel component: waterfall timeline, hop rows, resize handle, collapse toggle |
| `src/components/graph/TraceOverlay.tsx` | Origin pill overlay, positioned relative to target node |
| `electron/services/traceCapture.js` | Backend service: connection-diff capture, polling loop, hop resolution, TraceResult construction |

### 8.2 Modified Files

| File | Changes |
|------|---------|
| `src/types/electron.d.ts` | Add `TraceHop`, `TraceResult` types; add `executeTracedRequest` to `ElectronAPI` interface |
| `electron/preload.js` | Expose `executeTracedRequest` via `contextBridge` |
| `electron/main.js` | Register `ipcMain.handle('execute-traced-request', ...)` handler |
| `src/App.tsx` | Wrap app with `TraceContext.Provider`; add blue dot indicator on Service Map tab when trace is active |
| `src/components/GraphView.tsx` | Consume `TraceContext`; render `TraceWaterfall` and `TraceOverlay` when active; handle trace-related viewport adjustments |
| `src/components/CurlBuilder.tsx` | Add trace toggle to Send button (split button UI); add `"trace"` to `OutputTab` union; handle trace-enabled send flow |
| `src/components/graph/flowNodes.tsx` | Import `useTraceState()`; add `rf-node-trace-active` class when node is in `traceNodeIds`; trace dimming takes priority over hover dimming |
| `src/components/graph/ArrowEdge.tsx` | Register `traceBezier` and `traceStep` in `flowEdgeTypes`; add dimming for non-trace edges during active trace |
| `src/components/graph/ContextMenu.tsx` | Add "Trace Request" menu item with route picker submenu; visibility gated on `hasPort && hasRoutes && !isNotRunning` |
| `src/components/graph/NodeDetailPanel.tsx` | Add trace icon (⟡) next to each route in the routes section; add "Trace Info" section when node is part of active trace |
| `src/App.css` (or graph CSS module) | New CSS classes: `rf-node-trace-active`, trace edge animations (`@keyframes traceEdgeDraw`), waterfall styles, origin pill styles, latency badge glow |

---

## 9. Implementation Order

| Phase | Scope | Depends On |
|-------|-------|------------|
| 1 | Types and context: `TraceHop`, `TraceResult` in `electron.d.ts`, `TraceContext` in `traceContext.ts` | Nothing |
| 2 | Backend trace capture: `traceCapture.js`, IPC handler in `main.js`, preload bridge in `preload.js` | Phase 1 |
| 3 | Trace edge rendering: `TraceEdge.tsx` with draw-on animation and latency badge; register in `flowEdgeTypes` | Phase 1 |
| 4 | Node trace integration: `useTraceState()` in `flowNodes.tsx` for dimming and `rf-node-trace-active` class | Phase 1 |
| 5 | Waterfall panel: `TraceWaterfall.tsx` with timeline, hop rows, resize, collapse, hover sync | Phases 1, 3 |
| 6 | CurlBuilder integration: trace toggle on Send button, auto-switch to Service Map, trigger trace flow | Phases 1, 2 |
| 7 | Graph orchestration: `TraceOverlay.tsx` (origin pill), `TraceContext.Provider` in App, animation sequencing in GraphView | Phases 2, 3, 4, 5 |
| 8 | Context menu + detail panel: "Trace Request" menu item, route trace icons, "Trace Info" section | Phases 1, 2, 7 |
| 9 | Polish: animation tuning, error states, tab indicator, keyboard shortcuts, trace history/replay | All prior phases |

---

## 10. Verification Plan

### Manual Testing

1. **Basic trace flow**: Start 2+ local services that call each other (e.g., Express on 3001 → FastAPI on 8000 → Postgres on 5432). Fire traced request from CurlBuilder. Verify:
   - Edges light up in correct sequence
   - Latency badges appear with reasonable values
   - Waterfall shows correct hop nesting and timing
   - Bottleneck hop is visually highlighted

2. **Entry points**: Test all three entry points (CurlBuilder toggle, context menu, detail panel route icon) produce the same trace visualization.

3. **Waterfall interactions**: Hover rows → verify graph edge highlights. Click rows → verify graph pans and detail panel opens. Resize panel. Collapse/expand.

4. **Error cases**: Fire request to down service (verify warning). Fire request that times out. Fire request that returns 500. Verify each case renders appropriately.

5. **Dismiss behavior**: Escape key, ✕ button, background click all dismiss cleanly. Graph returns to normal.

6. **Coexistence**: During active trace, hover non-trace nodes (should still dim/highlight within constraints). Open detail panel for a trace node. Switch tabs and verify blue dot indicator.

### Automated Testing

- Run existing test suites to verify no regressions: `npm run test` and `npm run test:node`
- Unit tests for `traceCapture.js`: mock `getEstablishedConnections()`, verify hop detection from connection diffs
- Unit tests for `TraceWaterfall` component: verify row rendering, bar positioning, color coding
