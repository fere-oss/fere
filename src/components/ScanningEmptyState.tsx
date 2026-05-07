import { useState, useEffect } from "react";
import type { ServiceStatuses } from "../types/electron";

interface ScanningEmptyStateProps {
  serviceStatus?: ServiceStatuses;
  monitoringStartedAt?: number;
}

export function ScanningEmptyState({
  serviceStatus,
  monitoringStartedAt,
}: ScanningEmptyStateProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!monitoringStartedAt) return;
    const timer = setInterval(() => {
      setElapsed(Date.now() - monitoringStartedAt);
    }, 1000);
    return () => clearInterval(timer);
  }, [monitoringStartedAt]);

  // State 3: system tools broken
  const portsBroken = serviceStatus && serviceStatus.ports.code !== "ok";
  const processesBroken = serviceStatus && serviceStatus.processes.code !== "ok";

  if (portsBroken || processesBroken) {
    return (
      <div className="scanning-empty-state">
        <div className="scanning-warning-icon">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity="0.5"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <p className="scanning-message">Fere needs access to system tools to detect services</p>
        <p className="scanning-hint">
          Try restarting the app, or check System Settings &gt; Privacy &amp; Security
        </p>
      </div>
    );
  }

  // State 2: still scanning after 15s
  if (elapsed >= 15000) {
    return (
      <div className="scanning-empty-state">
        <div className="scanning-radar">
          <div className="scanning-radar-ring scanning-radar-ring-1" />
          <div className="scanning-radar-ring scanning-radar-ring-2" />
          <div className="scanning-radar-ring scanning-radar-ring-3" />
          <div className="scanning-radar-dot" />
        </div>
        <p className="scanning-message">Still scanning...</p>
        <p className="scanning-hint">Make sure your server is listening on a TCP port</p>
      </div>
    );
  }

  // State 1: normal scanning
  return (
    <div className="scanning-empty-state">
      <div className="scanning-radar">
        <div className="scanning-radar-ring scanning-radar-ring-1" />
        <div className="scanning-radar-ring scanning-radar-ring-2" />
        <div className="scanning-radar-ring scanning-radar-ring-3" />
        <div className="scanning-radar-dot" />
      </div>
      <p className="scanning-message">Start any local server and Fere will find it automatically</p>
      <p className="scanning-hint">
        Try running <code>npm start</code>, <code>python app.py</code>, or{" "}
        <code>docker-compose up</code>
      </p>
    </div>
  );
}
