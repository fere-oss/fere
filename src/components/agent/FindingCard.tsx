import React from "react";
import type { AgentFixAction } from "../../types/electron";
import type { FeedFinding, IncidentStage } from "./types";

export function FindingCard({
  item,
  onFix,
  onExplain,
  onDismiss,
  onOpenInClaudeCode,
  isStreaming,
}: {
  item: FeedFinding;
  onFix: (id: string) => void;
  onExplain: (finding: FeedFinding) => void;
  onDismiss: (id: string) => void;
  onOpenInClaudeCode: (finding: FeedFinding) => void;
  isStreaming: boolean;
}) {
  const canDismiss: boolean =
    item.stage === "detected" ||
    item.stage === "verified" ||
    item.stage === "escalated";

  return (
    <div className={`agp-finding-card agp-finding-stage-${item.stage}`}>
      <div className="agp-finding-card-header">
        <span className={`agp-finding-dot agp-finding-dot-${item.severity}`} />
        <span className="agp-finding-service">{item.service}</span>
        {canDismiss && (
          <button
            className="agp-finding-dismiss"
            onClick={() => onDismiss(item.id)}
            title="Dismiss"
          >
            ×
          </button>
        )}
      </div>
      <div className="agp-finding-summary">{item.summary}</div>

      {item.stage === "detected" && (
        <div className="agp-finding-actions">
          {item.fix &&
            (item.fix.type === "restart-container" ||
              item.fix.type === "kill-port") && (
              <button
                className="agp-finding-fix-btn"
                onClick={() => onFix(item.id)}
                disabled={isStreaming}
              >
                {item.fix.type === "restart-container"
                  ? "Restart container"
                  : `Kill :${(item.fix as AgentFixAction & { port: number }).port}`}
              </button>
            )}
          <button
            className="agp-finding-explain-btn"
            onClick={() => onExplain(item)}
            disabled={isStreaming}
          >
            Explain
          </button>
          <button
            className="agp-finding-claudecode-btn"
            onClick={() => onOpenInClaudeCode(item)}
            disabled={isStreaming}
            title="Open investigation brief in Claude Code"
          >
            Open in Claude Code
          </button>
        </div>
      )}

      {(item.stage === "fixing" || item.stage === "fixed") && (
        <div className="agp-finding-status">
          <span className="agp-step-spinner" />
          {item.stage === "fixing" ? "Applying fix…" : "Verifying…"}
        </div>
      )}

      {item.stage === "verified" && (
        <div className="agp-finding-status agp-finding-status-verified">
          Fixed
        </div>
      )}

      {item.stage === "escalated" && (
        <div className="agp-finding-escalated">
          <div className="agp-finding-status agp-finding-status-escalated">
            {item.error ?? "Needs manual review"}
          </div>
          <div className="agp-finding-actions">
            <button
              className="agp-finding-explain-btn"
              onClick={() => onExplain(item)}
              disabled={isStreaming}
            >
              Explain
            </button>
            <button
              className="agp-finding-claudecode-btn"
              onClick={() => onOpenInClaudeCode(item)}
              disabled={isStreaming}
              title="Open investigation brief in Claude Code"
            >
              Open in Claude Code
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
