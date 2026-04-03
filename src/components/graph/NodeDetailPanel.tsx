import { useCallback, useEffect } from "react";
import type { GraphNode, GraphEdge } from "../../types/electron";
import { getServiceColor, getTypeBadge } from "./constants";
import { NodeDetailContent } from "./NodeDetailContent";

interface NodeDetailPanelProps {
  node: GraphNode;
  edges: GraphEdge[];
  allNodes: GraphNode[];
  onClose: () => void;
  onTraceRequest?: (node: GraphNode) => void;
}

export function NodeDetailPanel({ node, edges, allNodes, onClose }: NodeDetailPanelProps) {
  const accentColor = getServiceColor(node.type);

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
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [onClose]);

  const handleAssessService = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("fere:investigate-node", {
        detail: {
          nodeId: node.id,
          nodeName: node.name,
          healthStatus: node.healthStatus,
          ports: (node.ports ?? []).map((port) => port.port),
          command: node.command,
        },
      }),
    );
  }, [node.command, node.healthStatus, node.id, node.name, node.ports]);

  return (
    <div className="node-detail-backdrop" onClick={handleBackdropClick} onWheel={handleWheel}>
      <div
        className="node-detail-panel"
        onMouseDown={e => e.stopPropagation()}
        onWheel={e => e.stopPropagation()}
        onMouseDownCapture={e => e.stopPropagation()}
        onWheelCapture={e => e.stopPropagation()}
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
          <button className="node-detail-close" onClick={onClose}>×</button>
        </div>
        <div className="node-detail-actions-card node-detail-actions-card-header">
          <button
            type="button"
            className="node-detail-ai-button node-detail-ai-button-wide"
            onClick={handleAssessService}
          >
            <span className="node-detail-ai-button-icon" aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="7" cy="7" r="3.75" />
                <path d="M9.75 9.75L13 13" />
                <path d="M7 5.5v3" />
                <path d="M5.5 7h3" />
              </svg>
            </span>
            Investigate
          </button>
        </div>
        <NodeDetailContent
          node={node}
          edges={edges}
          allNodes={allNodes}
          serviceExplanation={null}
          serviceExplanationError={null}
        />
      </div>
    </div>
  );
}
