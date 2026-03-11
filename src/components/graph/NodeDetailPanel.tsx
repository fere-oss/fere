import { useCallback, useEffect, useState } from 'react';
import type { GraphNode, GraphEdge } from '../../types/electron';
import { getServiceColor, getTypeBadge } from './constants';
import { NodeDetailContent } from './NodeDetailContent';

interface NodeDetailPanelProps {
  node: GraphNode;
  edges: GraphEdge[];
  allNodes: GraphNode[];
  onClose: () => void;
}

export function NodeDetailPanel({ node, edges, allNodes, onClose }: NodeDetailPanelProps) {
  const accentColor = getServiceColor(node.type);
  const [serviceExplanation, setServiceExplanation] = useState<string | null>(null);
  const [serviceExplanationLoading, setServiceExplanationLoading] = useState(false);
  const [serviceExplanationError, setServiceExplanationError] = useState<string | null>(null);

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

  useEffect(() => {
    setServiceExplanation(null);
    setServiceExplanationLoading(false);
    setServiceExplanationError(null);
  }, [node.id]);

  const handleExplainService = useCallback(async () => {
    setServiceExplanationLoading(true);
    setServiceExplanationError(null);
    const result = await window.electronAPI.explainService({
      serviceId: node.id,
      serviceName: node.name,
    });
    if (!result.success) {
      setServiceExplanationError(result.error || 'Failed to explain service');
      setServiceExplanationLoading(false);
      return;
    }
    setServiceExplanation(result.explanation || '');
    setServiceExplanationLoading(false);
  }, [node.id, node.name]);

  const handleDiagnoseService = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent('fere:debug-diagnose-service', {
        detail: {
          nodeId: node.id,
          serviceName: node.name,
        },
      }),
    );
  }, [node.id, node.name]);

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
            <div className="node-detail-actions-card node-detail-actions-card-header">
              <button
                type="button"
                className={`node-detail-ai-button${serviceExplanation || serviceExplanationLoading ? ' node-detail-ai-button-active' : ''}`}
                onClick={handleExplainService}
                disabled={serviceExplanationLoading}
              >
                <span className="node-detail-ai-button-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="2.75" width="10" height="10.5" rx="2.2" />
                    <path d="M6 6.25h4" />
                    <path d="M6 8.25h4" />
                    <path d="M6 10.25h2.5" />
                  </svg>
                </span>
                {serviceExplanationLoading
                  ? 'Explaining...'
                  : serviceExplanation
                    ? 'Refresh Explain'
                    : 'Explain Service'}
              </button>
              <button
                type="button"
                className="node-detail-ai-button node-detail-ai-button-secondary"
                onClick={handleDiagnoseService}
              >
                <span className="node-detail-ai-button-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="7" cy="7" r="3.75" />
                    <path d="M9.75 9.75L13 13" />
                    <path d="M7 5.5v3" />
                    <path d="M5.5 7h3" />
                  </svg>
                </span>
                Diagnose Service
              </button>
            </div>
          </div>
          <button className="node-detail-close" onClick={onClose}>×</button>
        </div>
        <NodeDetailContent
          node={node}
          edges={edges}
          allNodes={allNodes}
          serviceExplanation={serviceExplanation}
          serviceExplanationError={serviceExplanationError}
        />
      </div>
    </div>
  );
}
