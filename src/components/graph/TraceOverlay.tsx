import type { TraceResult } from "../../types/electron";
import type { TracePhase } from "./traceContext";

interface TraceOverlayProps {
  result: TraceResult | null;
  phase: TracePhase;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Floating pill overlay showing the request being traced.
 * Positioned at the top-center of the graph viewport.
 */
export function TraceOverlay({ result, phase }: TraceOverlayProps) {
  if (phase === "idle" || !result) return null;

  const methodColor = "#FFFFFF";

  const url = result.request.url.replace(/^https?:\/\//, "");

  return (
    <div className="trace-overlay-pill">
      <span className="trace-overlay-icon">
        {phase === "capturing" ? (
          <span className="trace-overlay-spinner" />
        ) : (
          "▶"
        )}
      </span>
      <span className="trace-overlay-method" style={{ color: methodColor }}>
        {result.request.method}
      </span>
      <span className="trace-overlay-url">{url}</span>
      {phase === "complete" && (
        <span className="trace-overlay-time">
          — {result.timedOut ? "Timed out" : formatLatency(result.totalTime)}
        </span>
      )}
      {phase === "capturing" && (
        <span className="trace-overlay-time">Tracing...</span>
      )}
    </div>
  );
}
