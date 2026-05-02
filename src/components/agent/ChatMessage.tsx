import React, { useCallback, useState } from "react";
import type { GraphNode } from "../../types/electron";
import { getServiceColor } from "../graph/constants";
import type { ContextSnapshot } from "./types";
import { renderProviderMentionsInChildren } from "./ProviderMention";

export function renderMirrorContent(text: string, nodes: GraphNode[]): React.ReactNode {
  const parts = text.split(/(@[\w\-.:]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const name = part.slice(1);
      const node = nodes.find((n) => n.name === name);
      if (node) {
        const color = getServiceColor(node.type);
        return (
          <span key={i} style={{ background: `${color}35`, borderRadius: "3px" }}>
            {part}
          </span>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
}

export function renderMentions(text: string, nodes: GraphNode[]): React.ReactNode {
  const parts = text.split(/(@[\w\-.:]+)/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) => {
    if (part.startsWith("@")) {
      const name = part.slice(1);
      const node = nodes.find((n) => n.name === name);
      if (node) {
        const color = getServiceColor(node.type);
        return (
          <span
            key={i}
            className="agp-mention-chip"
            style={{
              background: `${color}20`,
              color,
              border: `1px solid ${color}40`,
            }}
          >
            {part}
          </span>
        );
      }
    }
    return part;
  });
}

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      if (window.electronAPI?.copyText) {
        const result = await window.electronAPI.copyText(text);
        if (!result.success) throw new Error(result.error || "Copy failed");
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard API unavailable");
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No-op
    }
  }, [text]);

  return (
    <button className="agp-copy-btn" onClick={() => void handleCopy()}>
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export function ContextBlock({
  snapshot,
  copyText,
}: {
  snapshot: ContextSnapshot;
  copyText: string;
}) {
  const HEALTH_DOT: Record<string, string> = {
    green: "#22C55E",
    yellow: "#EAB308",
    red: "#EF4444",
  };

  return (
    <div className="agp-context-block">
      <div className="agp-context-header">
        <span className="agp-context-title">Runtime Context</span>
        <span className="agp-context-meta">{snapshot.scope} · {snapshot.timestamp}</span>
      </div>

      <div className="agp-context-scrollable">
        {snapshot.services.length > 0 && (
          <div className="agp-context-section">
            <div className="agp-context-section-label">Services ({snapshot.services.length})</div>
            {snapshot.services.map((svc, i) => {
              const color = getServiceColor(svc.type);
              const healthColor = HEALTH_DOT[svc.healthStatus] ?? "#6B7280";
              const ports = svc.ports.length ? svc.ports.join(", ") : "no port";
              const cpu = svc.cpu != null ? `${svc.cpu.toFixed(1)}% CPU` : null;
              const mem = svc.memory != null ? `${svc.memory.toFixed(0)} MB` : null;
              const docker = svc.isDockerContainer
                ? `container · ${svc.containerState ?? "?"}`
                : null;
              return (
                <div key={i} className="agp-context-service">
                  <div className="agp-context-service-row">
                    <span
                      className="agp-context-service-badge"
                      style={{ background: `${color}20`, color, border: `1px solid ${color}40` }}
                    >
                      {svc.type}
                    </span>
                    <span className="agp-context-service-name">{svc.name}</span>
                    <span className="agp-context-service-health" style={{ background: healthColor }} />
                    <span className="agp-context-service-meta">:{ports}</span>
                    {cpu && <span className="agp-context-service-meta">{cpu}</span>}
                    {mem && <span className="agp-context-service-meta">{mem}</span>}
                    {docker && <span className="agp-context-service-meta">{docker}</span>}
                  </div>
                  {svc.externalApis && svc.externalApis.length > 0 && (
                    <div className="agp-context-service-detail">
                      calls: {svc.externalApis.join(", ")}
                    </div>
                  )}
                  {svc.routes && svc.routes.length > 0 && (
                    <div className="agp-context-service-detail">
                      routes: {svc.routes.slice(0, 4).map((r) => `${r.method ?? "?"} ${r.path}`).join(", ")}
                      {svc.routes.length > 4 ? ` +${svc.routes.length - 4} more` : ""}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {(snapshot.connections ?? []).length > 0 && (
          <div className="agp-context-section">
            <div className="agp-context-section-label">Connections ({snapshot.connections.length})</div>
            {snapshot.connections.map((c, i) => (
              <div key={i} className="agp-context-service-detail" style={{ padding: "2px 0" }}>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{c.from}</span>
                <span style={{ margin: "0 4px", color: "var(--text-muted)" }}>→</span>
                <span style={{ fontWeight: 600, color: "var(--text-primary)" }}>{c.to}</span>
                <span className="agp-context-service-meta" style={{ marginLeft: 4 }}>:{c.port}</span>
              </div>
            ))}
          </div>
        )}

        {snapshot.findings.length > 0 && (
          <div className="agp-context-section">
            <div className="agp-context-section-label">Findings ({snapshot.findings.length})</div>
            {snapshot.findings.map((f, i) => {
              const sev = f.severity.toLowerCase();
              const sevColor =
                sev === "critical" ? "#EF4444" : sev === "high" ? "#F97316" : sev === "medium" ? "#EAB308" : "#6B7280";
              return (
                <div key={i} className="agp-context-finding">
                  <span className="agp-context-finding-sev" style={{ color: sevColor }}>
                    [{f.severity.toUpperCase()}]
                  </span>
                  <span className="agp-context-finding-service">{f.service}</span>
                  <span className="agp-context-finding-summary">{f.summary}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <CopyButton text={copyText} />
    </div>
  );
}

// Extract plain text from React children for node name matching.
export function extractText(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (children == null) return "";
  if (Array.isArray(children)) return children.map(extractText).join("");
  if (React.isValidElement(children)) {
    const el = children as React.ReactElement<{ children?: React.ReactNode }>;
    return extractText(el.props.children);
  }
  return "";
}

export { renderProviderMentionsInChildren };
