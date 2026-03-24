import { useState, useEffect, useCallback } from "react";

const DISCOVERY_HINT_KEY = "fere.hasSeenDiscoveryHint";
const NODE_CLICK_HINT_KEY = "fere.hasSeenNodeClickHint";

/**
 * Inline card shown the first time services appear in the graph.
 * Auto-dismisses after 10 seconds or on click.
 */
export function DiscoveryHint({ onDismiss }: { onDismiss?: () => void }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setVisible(true));
    const timer = setTimeout(() => {
      setVisible(false);
      setTimeout(() => {
        try { localStorage.setItem(DISCOVERY_HINT_KEY, "true"); } catch {}
        onDismiss?.();
      }, 300);
    }, 10000);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
    };
  }, [onDismiss]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    setTimeout(() => {
      try { localStorage.setItem(DISCOVERY_HINT_KEY, "true"); } catch {}
      onDismiss?.();
    }, 300);
  }, [onDismiss]);

  return (
    <div
      className={`onboarding-hint discovery-hint${visible ? " visible" : ""}`}
      onClick={handleDismiss}
    >
      <div className="onboarding-hint-content">
        <span className="onboarding-hint-title">This is your service map</span>
        <span className="onboarding-hint-body">
          Every box is a running service Fere found on your machine — servers,
          databases, containers. Lines show how they connect. Click any service
          to learn more about it.
        </span>
      </div>
      <button className="onboarding-hint-dismiss" onClick={handleDismiss}>
        Got it
      </button>
    </div>
  );
}

/**
 * One-line hint shown at the top of the node detail panel on first click.
 */
export function NodeClickHint() {
  const [dismissed, setDismissed] = useState(false);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem(NODE_CLICK_HINT_KEY, "true"); } catch {}
  }, []);

  if (dismissed) return null;

  return (
    <div className="onboarding-hint node-click-hint">
      <span className="onboarding-hint-body">
        This is everything Fere knows about this service. It updates in real time.
      </span>
      <button className="onboarding-hint-dismiss-small" onClick={handleDismiss}>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 4L12 12M12 4L4 12" />
        </svg>
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
