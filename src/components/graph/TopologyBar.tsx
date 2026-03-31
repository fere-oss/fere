import { useMemo } from 'react';
import type { GraphNode, GraphEdge } from '../../types/electron';
import { buildTopologyNarration } from './topologyNarration';

interface TopologyBarProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function TopologyBar({ nodes, edges }: TopologyBarProps) {
  const narration = useMemo(
    () => buildTopologyNarration(nodes, edges),
    [nodes, edges],
  );

  if (!narration) return null;

  return (
    <div className="topology-bar">
      {narration}
    </div>
  );
}
