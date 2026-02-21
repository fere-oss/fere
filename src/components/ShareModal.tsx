import { useState, useEffect, useRef } from "react";
import type { GraphNode, GraphEdge } from "../types/electron";

interface Props {
  onClose: () => void;
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  activeTabLabel: string;
}

type ModalState = "setup" | "idle" | "busy" | "done" | "error";

function timeAgo(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins === 1) return "1 minute ago";
  if (mins < 60) return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs === 1) return "1 hour ago";
  if (hrs < 24) return `${hrs} hours ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

export function ShareModal({ onClose, graphNodes, graphEdges, activeTabLabel }: Props) {
  const [modalState, setModalState] = useState<ModalState>("idle");
  const [tokenInput, setTokenInput] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [hasToken, setHasToken] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [publishedAt, setPublishedAt] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [copied, setCopied] = useState(false);
  const tokenRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    window.electronAPI?.getShareSettings?.().then((settings) => {
      setHasToken(settings.hasToken);
      if (settings.shareUrl) setShareUrl(settings.shareUrl);
      if (settings.publishedAt) setPublishedAt(settings.publishedAt);

      if (!settings.hasToken) {
        setModalState("setup");
      } else if (settings.shareUrl) {
        setModalState("done");
      }
    });
  }, []);

  async function handleSaveToken() {
    const trimmed = tokenInput.trim();
    if (!trimmed) return;
    try {
      await window.electronAPI.saveGithubToken(trimmed);
      setHasToken(true);
      setTokenInput("");
      setModalState("idle");
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to save token");
      setModalState("error");
    }
  }

  async function handlePublish(isUpdate: boolean) {
    setModalState("busy");
    setErrorMsg("");
    try {
      const options = {
        graphData: { nodes: graphNodes, edges: graphEdges },
        metadata: {
          tabName: activeTabLabel,
          timestamp: Date.now(),
          nodeCount: graphNodes.length,
          edgeCount: graphEdges.length,
        },
      };
      const result = isUpdate
        ? await window.electronAPI.updateSharedGraph(options)
        : await window.electronAPI.publishGraph(options);

      if (result.error) throw new Error(result.error);
      setShareUrl(result.url ?? null);
      setPublishedAt(result.publishedAt ?? null);
      setModalState("done");
    } catch (e: any) {
      setErrorMsg(e?.message || "Failed to publish graph");
      setModalState("error");
    }
  }

  async function handleCopy() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  }

  function handleOpenUrl() {
    if (shareUrl) window.electronAPI?.openUrl(shareUrl);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content share-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-labelledby="share-modal-title"
        aria-modal="true"
      >
        {/* Header */}
        <div className="modal-header">
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="#171717" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="14" cy="4" r="2" />
              <circle cx="4" cy="9" r="2" />
              <circle cx="14" cy="14" r="2" />
              <line x1="6" y1="8" x2="12" y2="5" />
              <line x1="6" y1="10" x2="12" y2="13" />
            </svg>
            <span className="modal-title" id="share-modal-title">Share Service Map</span>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <line x1="12" y1="4" x2="4" y2="12" />
              <line x1="4" y1="4" x2="12" y2="12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="modal-body">

          {/* SETUP — no token yet */}
          {modalState === "setup" && (
            <div className="share-setup">
              <p className="share-desc">
                To publish your service map, enter a GitHub Personal Access Token with <strong>gist</strong> scope.
                Stored locally in <code>~/.fere/settings.json</code> — never sent anywhere except the GitHub API.
              </p>
              <a
                className="share-link"
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  window.electronAPI?.openUrl("https://github.com/settings/tokens/new?scopes=gist&description=Fere+Share");
                }}
              >
                Create a token on GitHub →
              </a>
              <div className="share-token-row">
                <div className="share-token-input-wrap">
                  <input
                    ref={tokenRef}
                    type={showToken ? "text" : "password"}
                    className="share-token-input"
                    placeholder="ghp_..."
                    value={tokenInput}
                    onChange={(e) => setTokenInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSaveToken()}
                    autoFocus
                  />
                  <button
                    className="share-token-eye"
                    onClick={() => setShowToken(!showToken)}
                    tabIndex={-1}
                    aria-label={showToken ? "Hide token" : "Show token"}
                  >
                    {showToken ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <path d="M1 7s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" />
                        <circle cx="7" cy="7" r="1.5" />
                        <line x1="2" y1="2" x2="12" y2="12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
                        <path d="M1 7s2-4 6-4 6 4 6 4-2 4-6 4-6-4-6-4z" />
                        <circle cx="7" cy="7" r="1.5" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* IDLE — ready to publish */}
          {modalState === "idle" && (
            <div className="share-idle">
              <p className="share-desc">
                Publish an interactive snapshot of your <strong>{activeTabLabel}</strong> service map.
                Anyone with the link can zoom, pan, and explore the graph in their browser.
              </p>
              <div className="share-stats">
                <span className="share-stat">{graphNodes.length} services</span>
                <span className="share-stat-sep">·</span>
                <span className="share-stat">{graphEdges.length} connections</span>
              </div>
            </div>
          )}

          {/* BUSY */}
          {modalState === "busy" && (
            <div className="share-busy">
              <div className="share-spinner" />
              <span className="share-busy-text">Publishing to GitHub Gist…</span>
            </div>
          )}

          {/* DONE */}
          {modalState === "done" && shareUrl && (
            <div className="share-done">
              <div className="share-success-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              </div>
              <p className="share-desc share-desc-center">
                Your service map is live — share this link:
              </p>
              <div className="share-url-row">
                <input
                  type="text"
                  className="share-url-input"
                  value={shareUrl}
                  readOnly
                  onClick={(e) => (e.target as HTMLInputElement).select()}
                />
                <button
                  className={`share-copy-btn${copied ? " share-copy-btn-copied" : ""}`}
                  onClick={handleCopy}
                  title="Copy link"
                >
                  {copied ? (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <path d="M2 7l3 3 7-7" />
                    </svg>
                  ) : (
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="5" y="5" width="7" height="7" rx="1" />
                      <path d="M9 5V3a1 1 0 00-1-1H3a1 1 0 00-1 1v5a1 1 0 001 1h2" />
                    </svg>
                  )}
                </button>
              </div>
              {publishedAt && (
                <p className="share-published-meta">Published {timeAgo(publishedAt)}</p>
              )}
            </div>
          )}

          {/* ERROR */}
          {modalState === "error" && (
            <div className="share-error">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="#ef4444" strokeWidth="1.5" strokeLinecap="round">
                <circle cx="10" cy="10" r="8" />
                <line x1="10" y1="6" x2="10" y2="10" />
                <circle cx="10" cy="14" r="0.5" fill="#ef4444" />
              </svg>
              <p className="share-error-text">{errorMsg}</p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="modal-actions">
          {modalState === "setup" && (
            <>
              <button className="modal-btn modal-btn-secondary" onClick={onClose}>Cancel</button>
              <button
                className="modal-btn modal-btn-primary"
                onClick={handleSaveToken}
                disabled={!tokenInput.trim()}
              >
                Save Token
              </button>
            </>
          )}

          {modalState === "idle" && (
            <>
              <button className="modal-btn modal-btn-secondary" onClick={onClose}>Cancel</button>
              <button className="modal-btn modal-btn-primary" onClick={() => handlePublish(false)}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 1v8M4 5l3-4 3 4" />
                  <path d="M2 10v2a1 1 0 001 1h8a1 1 0 001-1v-2" />
                </svg>
                Publish
              </button>
            </>
          )}

          {modalState === "busy" && (
            <button className="modal-btn modal-btn-secondary" disabled>Publishing…</button>
          )}

          {modalState === "done" && (
            <>
              <button className="modal-btn modal-btn-secondary" onClick={() => setModalState("idle")}>
                Change Token
              </button>
              <button className="modal-btn modal-btn-secondary" onClick={handleOpenUrl}>Open</button>
              <button className="modal-btn modal-btn-primary" onClick={() => handlePublish(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="23 4 23 10 17 10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Update
              </button>
            </>
          )}

          {modalState === "error" && (
            <>
              <button className="modal-btn modal-btn-secondary" onClick={onClose}>Close</button>
              <button className="modal-btn modal-btn-primary" onClick={() => setModalState(hasToken ? "idle" : "setup")}>
                Try Again
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
