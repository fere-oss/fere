import { useState, useEffect, useCallback } from "react";

const DISCOVERY_HINT_KEY = "fere.hasSeenDiscoveryHint";
const NODE_CLICK_HINT_KEY = "fere.hasSeenNodeClickHint";

/**
 * Prominent card shown the first time services appear in the graph.
 * User must actively dismiss — no auto-timeout.
 */
export function DiscoveryHint({ onDismiss }: { onDismiss?: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      try { localStorage.setItem(DISCOVERY_HINT_KEY, "true"); } catch {}
      onDismiss?.();
    }, 300);
  }, [onDismiss]);

  return (
    <div className={`discovery-hint${visible ? " visible" : ""}`}>
      <div className="discovery-hint-icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <circle cx="4" cy="6" r="2" />
          <circle cx="20" cy="6" r="2" />
          <circle cx="4" cy="18" r="2" />
          <circle cx="20" cy="18" r="2" />
          <line x1="9.5" y1="10.5" x2="5.5" y2="7.5" />
          <line x1="14.5" y1="10.5" x2="18.5" y2="7.5" />
          <line x1="9.5" y1="13.5" x2="5.5" y2="16.5" />
          <line x1="14.5" y1="13.5" x2="18.5" y2="16.5" />
        </svg>
      </div>
      <div className="discovery-hint-content">
        <span className="discovery-hint-title">This is your service map</span>
        <span className="discovery-hint-body">
          Every box is a running service Fere found on your machine — servers,
          databases, containers. Lines show how they connect. Click any service
          to see its routes, health, and connections.
        </span>
      </div>
      <button className="discovery-hint-dismiss" onClick={handleDismiss}>
        Got it
      </button>
    </div>
  );
}

/**
 * Hint banner shown at the top of the node detail panel on first click.
 */
export function NodeClickHint() {
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(NODE_CLICK_HINT_KEY, "true"); } catch {}
  }, []);

  if (dismissed) return null;

  return (
    <div className="node-click-hint" onClick={(e) => e.stopPropagation()}>
      <span className="node-click-hint-text">
        This is everything Fere knows about this service. It updates in real time.
      </span>
      <button className="node-click-hint-dismiss" onClick={handleDismiss}>
        Got it
      </button>
    </div>
  );
}

export function hasSeenDiscoveryHint(): boolean {
  try { return !!localStorage.getItem(DISCOVERY_HINT_KEY); } catch { return true; }
}

export function hasSeenNodeClickHint(): boolean {
  try { return !!localStorage.getItem(NODE_CLICK_HINT_KEY); } catch { return true; }
}
