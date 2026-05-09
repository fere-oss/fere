import { useEffect, useState } from "react";
import type { McpClientConfig } from "../types/electron";

interface Props {
  onClose: () => void;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      scriptPath: string;
      scriptExists: boolean;
      clients: McpClientConfig[];
    };

export function ConnectAiModal({ onClose }: Props) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [activeId, setActiveId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI
      .getMcpConfig()
      .then((res) => {
        if (cancelled) return;
        if (!res.success || !res.clients || !res.scriptPath) {
          setState({
            status: "error",
            message: res.error || "Could not load MCP config",
          });
          return;
        }
        setState({
          status: "ready",
          scriptPath: res.scriptPath,
          scriptExists: !!res.scriptExists,
          clients: res.clients,
        });
        setActiveId(res.clients[0]?.id ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: err instanceof Error ? err.message : "Could not load MCP config",
        });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose]);

  const handleCopy = async (clientId: string, snippet: string) => {
    try {
      if (window.electronAPI?.copyText) {
        const res = await window.electronAPI.copyText(snippet);
        if (!res.success) throw new Error(res.error || "Copy failed");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(snippet);
      } else {
        throw new Error("Clipboard unavailable");
      }
      setCopiedId(clientId);
      window.setTimeout(() => {
        setCopiedId((prev) => (prev === clientId ? null : prev));
      }, 1800);
    } catch {
      // Best-effort copy — silently ignore
    }
  };

  const handleReveal = (configPath: string) => {
    void window.electronAPI?.revealMcpConfigPath?.(configPath);
  };

  const active =
    state.status === "ready"
      ? state.clients.find((c) => c.id === activeId) ?? state.clients[0]
      : null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content connect-ai-modal"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2 className="modal-title">Connect AI to Fere</h2>
          <button className="modal-close" onClick={onClose} type="button">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="connect-ai-body">
          <p className="connect-ai-intro">
            Paste this config into your AI client so it can read your live runtime via the
            Fere MCP server. Fere must be running for the connection to work.
          </p>

          {state.status === "loading" && (
            <div className="connect-ai-loading">Loading config…</div>
          )}

          {state.status === "error" && (
            <div className="connect-ai-error">{state.message}</div>
          )}

          {state.status === "ready" && active && (
            <>
              <div className="connect-ai-script-row">
                <span className="connect-ai-script-label">Server script</span>
                <code className="connect-ai-script-path" title={state.scriptPath}>
                  {state.scriptPath}
                </code>
                {!state.scriptExists && (
                  <span className="connect-ai-script-warn" title="Script not found at expected path">
                    not found
                  </span>
                )}
              </div>

              <div className="connect-ai-tabs" role="tablist">
                {state.clients.map((c) => (
                  <button
                    key={c.id}
                    role="tab"
                    type="button"
                    className={`connect-ai-tab ${
                      c.id === active.id ? "connect-ai-tab-active" : ""
                    }`}
                    onClick={() => setActiveId(c.id)}
                  >
                    {c.label}
                  </button>
                ))}
              </div>

              <div className="connect-ai-target">
                <div className="connect-ai-target-label">Paste into</div>
                <div className="connect-ai-target-row">
                  <code className="connect-ai-target-path" title={active.configPath}>
                    {active.configPath}
                  </code>
                  {active.configPath.startsWith("/") && (
                    <button
                      type="button"
                      className="connect-ai-reveal-btn"
                      onClick={() => handleReveal(active.configPath)}
                      title="Reveal in Finder"
                    >
                      Reveal
                    </button>
                  )}
                </div>
                {active.notes && (
                  <div className="connect-ai-notes">{active.notes}</div>
                )}
              </div>

              <div className="connect-ai-snippet-wrap">
                <pre className="connect-ai-snippet">{active.snippet}</pre>
                <button
                  type="button"
                  className="connect-ai-copy-btn"
                  onClick={() => handleCopy(active.id, active.snippet)}
                >
                  {copiedId === active.id ? "Copied" : "Copy"}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
