import { useEffect } from "react";
import type { GraphNode, GraphEdge } from "../../types/electron";
import { getServiceColor, getTypeBadge } from "./constants";
import { NodeDetailContent } from "./NodeDetailContent";
import { NodeClickHint, hasSeenNodeClickHint } from "../OnboardingHints";

interface NodeDetailPanelProps {
  node: GraphNode;
  edges: GraphEdge[];
  allNodes: GraphNode[];
  onClose: () => void;
  onTraceRequest?: (node: GraphNode) => void;
}

export function NodeDetailPanel({
  node,
  edges,
  allNodes,
  onClose,
  onTraceRequest,
}: NodeDetailPanelProps) {
  const accentColor = getServiceColor(node.type);
  const showHint = !hasSeenNodeClickHint();

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleWheel = (e: React.WheelEvent) => {
    e.stopPropagation();
  };

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [onClose]);

  return (
    <div
      className="node-detail-backdrop"
      onClick={handleBackdropClick}
      onWheel={handleWheel}
    >
      {showHint && <NodeClickHint />}
      <div
        className="node-detail-panel"
        onMouseDown={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
        onMouseDownCapture={(e) => e.stopPropagation()}
        onWheelCapture={(e) => e.stopPropagation()}
      >
        <div className="node-detail-header">
          <div className="node-detail-header-main">
            <div className="node-detail-title-row">
              <div
                className="node-detail-dot"
                style={{
                  backgroundColor: accentColor,
                  boxShadow: `0 0 12px ${accentColor}50`,
                }}
              />
              <div className="node-detail-title-info">
                <h2 className="node-detail-name">{node.name}</h2>
                <span
                  className="node-detail-badge"
                  style={{
                    backgroundColor: `${accentColor}15`,
                    color: accentColor,
                  }}
                >
                  {getTypeBadge(node.type)}
                </span>
              </div>
            </div>
          </div>
          <div className="node-detail-header-actions">
            <button
              className="node-detail-investigate-btn"
              title="Investigate with Sentinel"
              onClick={() => {
                onClose();
                window.dispatchEvent(
                  new CustomEvent("fere:investigate-node", {
                    detail: {
                      nodeId: node.id,
                      nodeName: node.name,
                      healthStatus: node.healthStatus,
                      ports: (node.ports ?? []).map(p => p.port),
                      command: node.command,
                    },
                  }),
                );
              }}
            >
              Investigate
            </button>
            <button className="node-detail-close" onClick={onClose}>
              ×
            </button>
          </div>
        </div>
        <NodeDetailContent
          node={node}
          edges={edges}
          allNodes={allNodes}
          onTraceRequest={onTraceRequest}
        />
      </div>
    </div>
  );
}
