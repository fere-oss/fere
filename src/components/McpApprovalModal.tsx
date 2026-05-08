import { useEffect, useState } from "react";
import type {
  AgentFinding,
  AgentFixAction,
  McpApprovalRequest,
} from "../types/electron";
import "./McpApprovalModal.css";

function describeAction(action: AgentFixAction): string {
  switch (action.type) {
    case "kill-port":
      return action.port
        ? `Kill the process listening on port ${action.port}${action.pid ? ` (PID ${action.pid})` : ""}`
        : `Kill process${action.pid ? ` (PID ${action.pid})` : ""}`;
    case "restart-container":
      return action.containerId
        ? `Restart container ${action.containerId}`
        : "Restart container";
    case "write-file":
      return action.filePath
        ? `Write file ${action.filePath}`
        : "Write file";
    case "copy-only":
      return action.preview || "Copy guidance only";
    default:
      return action.label || (action as AgentFixAction).type;
  }
}

interface PendingApproval {
  requestId: string;
  finding: AgentFinding;
  action: AgentFixAction;
  expiresAt: number;
}

export function McpApprovalModal() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!window.electronAPI?.onMcpApprovalRequest) return;
    window.electronAPI.onMcpApprovalRequest((payload: McpApprovalRequest) => {
      setPending({
        requestId: payload.requestId,
        finding: payload.finding,
        action: payload.action,
        expiresAt: Date.now() + (payload.timeoutMs || 60_000),
      });
    });
    return () => window.electronAPI?.offMcpApprovalRequest?.();
  }, []);

  // Tick countdown + auto-close when expired (main process times out independently)
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      const next = Date.now();
      if (next >= pending.expiresAt) {
        setPending(null);
      } else {
        setNow(next);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [pending]);

  if (!pending) return null;

  const respond = (approved: boolean) => {
    window.electronAPI?.respondMcpApproval?.(
      pending.requestId,
      approved,
      approved ? undefined : "denied by user",
    );
    setPending(null);
  };

  const remaining = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));
  const { finding, action } = pending;

  return (
    <div
      className="mcp-approval-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="mcp-approval-title"
    >
      <div className="mcp-approval-modal">
        <div className="mcp-approval-header">
          <div id="mcp-approval-title" className="mcp-approval-title">
            AI client wants to apply a fix
          </div>
          <div className="mcp-approval-countdown">{remaining}s</div>
        </div>

        <div className="mcp-approval-body">
          <div className="mcp-approval-source">
            Requested via MCP — review before approving.
          </div>

          <div className="mcp-approval-finding">
            <div className="mcp-approval-row">
              <span
                className="mcp-approval-severity"
                data-sev={finding.severity}
              >
                {finding.severity}
              </span>
              <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                {finding.service}
              </span>
            </div>
            <div className="mcp-approval-summary">{finding.summary}</div>
            {finding.detail ? (
              <div className="mcp-approval-detail">{finding.detail}</div>
            ) : null}
            {finding.affectedServices?.length ? (
              <div className="mcp-approval-detail">
                Downstream affected: {finding.affectedServices.join(", ")}
              </div>
            ) : null}
          </div>

          <div className="mcp-approval-action">
            <div className="mcp-approval-action-label">Proposed action</div>
            <div className="mcp-approval-action-text">
              {action.label || describeAction(action)}
            </div>
            {action.label && action.label !== describeAction(action) ? (
              <div
                className="mcp-approval-action-text"
                style={{ color: "var(--text-secondary)" }}
              >
                {describeAction(action)}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mcp-approval-footer">
          <button
            className="mcp-approval-btn"
            onClick={() => respond(false)}
            type="button"
          >
            Deny
          </button>
          <button
            className="mcp-approval-btn mcp-approval-btn-primary"
            onClick={() => respond(true)}
            type="button"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  );
}
