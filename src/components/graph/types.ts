import type { GraphNode, GraphEdge } from '../../types/electron';

export interface GraphViewProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  isContainerView?: boolean;
  onDatabaseClick?: (node: GraphNode) => void;
  debugHighlightNodeIds?: Set<string>;
  labelsVisible?: boolean;
}

export interface NodePosition {
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  indexInLayer: number;
}

export interface LayoutNode {
  node: GraphNode;
  layer: number;
  order: number;
  groupId: string;
}

export interface RenderGroup {
  groupName: string;
  nodes: GraphNode[];
  isGroup: boolean;
  groupType?: string;
}

export interface ContainerProject {
  projectName: string;
  typeGroups: RenderGroup[];
  totalContainers: number;
}
