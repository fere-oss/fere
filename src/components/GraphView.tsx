import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import type { GraphNode } from '../types/electron';
import type { MouseEvent as ReactMouseEvent } from 'react';
import ReactFlow, { Background, Controls, Handle, MarkerType, Position, type ReactFlowInstance } from 'reactflow';
import 'reactflow/dist/style.css';
import { SERVICE_COLORS } from './graph/constants';
import { externalApiCache, externalApiInFlight, EXTERNAL_API_CACHE_TTL_MS } from './graph/externalApis';
import { computeHierarchicalLayout } from './graph/layout';
import { groupContainersByProject, groupLayoutNodes } from './graph/grouping';
import type { GraphViewProps, LayoutNode, RenderGroup } from './graph/types';
import { ContextMenu } from './graph/ContextMenu';
import { NodeDetailPanel } from './graph/NodeDetailPanel';
import { ProjectContainer } from './graph/ContainerGroups';
import { ServiceNode } from './graph/ServiceNodes';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 180;
const NODE_GAP = 20;
const STANDALONE_NODE_GAP = 20;
const GROUP_GAP = 24;
const LAYER_GAP = 150;
const STANDALONE_GROUP_GAP = 32;
const STANDALONE_LABEL_OFFSET = 56;
const LAYER_LABEL_OFFSET = 56;
const STANDALONE_SECTION_OFFSET = 96;
const GROUP_BOX_PADDING = 14;
const GROUP_LABEL_OFFSET = 36;
const DEFAULT_LAYER_LABELS = ['Interface', 'Services', 'Processing', 'Data'];
const LABEL_WIDTH = 180;
const LABEL_HEIGHT = 28;
const MAX_GROUP_COLUMNS = 2;
const MAX_STANDALONE_COLUMNS = 2;
const MAX_SYSTEM_SERVICE_COLUMNS = 4;

function TierLabelNode({ data }: { data: { text: string } }) {
  return (
    <div className="graph-tier-label">{data.text}</div>
  );
}

function GroupLabelNode({ data }: { data: { text: string; color: string } }) {
  return (
    <div className="graph-group-label" style={{ ['--group-color' as string]: data.color }}>
      {data.text}
    </div>
  );
}

function GroupBoxNode({ data }: { data: { width: number; height: number; color: string } }) {
  return (
    <div
      className="graph-group-box"
      style={{
        width: data.width,
        height: data.height,
        ['--group-color' as string]: data.color,
      }}
    />
  );
}

function FlowServiceNode({
  data,
}: {
  data: {
    node: GraphNode;
    onNodeClick: (node: GraphNode) => void;
    onNodeContextMenu: (e: ReactMouseEvent, node: GraphNode) => void;
    animate: boolean;
    animationIndex: number;
  };
}) {
  return (
    <div
      className={`rf-node-wrapper${data.animate ? ' rf-node-animate' : ''}`}
      style={{ animationDelay: `${data.animationIndex * 40}ms` }}
    >
      <Handle type="target" position={Position.Top} className="rf-handle rf-handle-target" />
      <ServiceNode
        node={data.node}
        onClick={data.onNodeClick}
        onContextMenu={data.onNodeContextMenu}
        animationIndex={0}
      />
      <Handle type="source" position={Position.Bottom} className="rf-handle rf-handle-source" />
    </div>
  );
}

const estimateNodeHeight = (node: GraphNode) => {
  const routes = node.routes || [];
  const externalApis = (node.projectPath && !node.isDockerContainer)
    ? (externalApiCache.get(node.projectPath)?.apis || [])
    : [];
  const hasProjectLabel = !node.isDockerContainer && Boolean(node.projectPath);
  const hasDockerImage = node.isDockerContainer && Boolean(node.containerImage);
  const hasDockerNetworks = node.isDockerContainer && Boolean(node.containerNetworks?.length);

  const baseHeight = 120;
  const optionalLineHeight = 18;
  const networksHeight = 18;
  const sectionBase = 42;
  const rowHeight = 18;
  const rowGap = 6;

  let height = baseHeight;
  if (hasProjectLabel || hasDockerImage) {
    height += optionalLineHeight;
  }
  if (hasDockerNetworks) {
    height += networksHeight;
  }

  const routeRows = Math.min(3, routes.length);
  if (routeRows > 0) {
    height += sectionBase + routeRows * rowHeight + Math.max(0, routeRows - 1) * rowGap;
  }

  const apiRows = Math.min(3, externalApis.length);
  if (apiRows > 0) {
    height += sectionBase + apiRows * rowHeight + Math.max(0, apiRows - 1) * rowGap;
  }

  return Math.max(NODE_HEIGHT, height);
};

export function GraphView({
  nodes,
  edges,
  isContainerView = false,
  onDatabaseClick,
  dataStatus,
}: GraphViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [reactFlowInstance, setReactFlowInstance] = useState<ReactFlowInstance | null>(null);
  const [animateNodes, setAnimateNodes] = useState(true);
  const [contextMenu, setContextMenu] = useState<{
    node: GraphNode;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const orderCacheRef = useRef<Map<number, string[]>>(new Map());
  const groupOrderCacheRef = useRef<Map<number, string[]>>(new Map());
  const [externalApiVersion, setExternalApiVersion] = useState(0);
  const didFitViewRef = useRef(false);
  const didInitialAnimationRef = useRef(false);

  useEffect(() => {
    if (didInitialAnimationRef.current) return;
    didInitialAnimationRef.current = true;
    const timer = setTimeout(() => setAnimateNodes(false), 1200);
    return () => clearTimeout(timer);
  }, []);

  const handleNodeClick = useCallback((node: GraphNode) => {
    if (isContainerView && node.isDockerContainer && node.type === 'database' && onDatabaseClick) {
      onDatabaseClick(node);
    } else {
      setSelectedNode(node);
    }
  }, [isContainerView, onDatabaseClick]);

  const handleContextMenu = useCallback((e: ReactMouseEvent, node: GraphNode) => {
    e.preventDefault();
    e.stopPropagation();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setContextMenu({
      node,
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      width: rect.width,
      height: rect.height,
    });
  }, []);

  const stableNodes = useMemo(() => {
    return [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  }, [nodes]);

  const stableEdges = useMemo(() => {
    return [...edges].sort((a, b) => a.id.localeCompare(b.id));
  }, [edges]);

  const localNodes = useMemo(() => stableNodes.filter(n => n.type !== 'external'), [stableNodes]);
  const localEdges = useMemo(() => {
    const localNodeIds = new Set(localNodes.map(n => n.id));
    return stableEdges.filter(e => localNodeIds.has(e.source) && localNodeIds.has(e.target));
  }, [localNodes, stableEdges]);

  const projectPathsKey = useMemo(() => {
    return Array.from(
      new Set(localNodes.map(node => node.projectPath).filter(Boolean))
    ).sort().join(',');
  }, [localNodes]);

  useEffect(() => {
    if (!window.electronAPI?.getExternalApis) return;
    if (!projectPathsKey) return;

    const projectPaths = projectPathsKey.split(',').filter(Boolean);
    if (projectPaths.length === 0) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      (async () => {
        for (const projectPath of projectPaths) {
          if (cancelled) return;
          const cached = externalApiCache.get(projectPath);
          if (cached && Date.now() - cached.timestamp < EXTERNAL_API_CACHE_TTL_MS) continue;
          if (externalApiInFlight.has(projectPath)) continue;
          externalApiInFlight.add(projectPath);
          try {
            const apis = await window.electronAPI.getExternalApis(projectPath);
            if (cancelled) return;
            externalApiCache.set(projectPath, { timestamp: Date.now(), apis });
            setExternalApiVersion(version => version + 1);
          } catch (error) {
            if (cancelled) return;
          } finally {
            externalApiInFlight.delete(projectPath);
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      })();
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [projectPathsKey]);

  const { connected: connectedLayout, standalone: standaloneLayout } = useMemo(() =>
    computeHierarchicalLayout(localNodes, localEdges),
    [localNodes, localEdges]
  );

  const stableConnectedLayout = useMemo(() => {
    const byLayer = new Map<number, LayoutNode[]>();
    connectedLayout.forEach(node => {
      if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
      byLayer.get(node.layer)!.push(node);
    });

    const stableOrders = new Map<string, number>();
    byLayer.forEach((layerNodes, layer) => {
      const groups = new Map<string, LayoutNode[]>();
      layerNodes.forEach(node => {
        if (!groups.has(node.groupId)) groups.set(node.groupId, []);
        groups.get(node.groupId)!.push(node);
      });

      const groupIds = Array.from(groups.keys());
      const groupOrderSeed = [...groupIds].sort((a, b) => {
        const aOrder = Math.min(...groups.get(a)!.map(n => n.order));
        const bOrder = Math.min(...groups.get(b)!.map(n => n.order));
        return aOrder - bOrder;
      });

      const cachedGroupOrder = groupOrderCacheRef.current.get(layer);
      const groupSet = new Set(groupIds);
      const sameGroupSet =
        cachedGroupOrder &&
        cachedGroupOrder.length === groupIds.length &&
        cachedGroupOrder.every(id => groupSet.has(id));
      const finalGroupOrder = sameGroupSet ? cachedGroupOrder : groupOrderSeed;
      groupOrderCacheRef.current.set(layer, finalGroupOrder);

      const cachedNodeOrder = orderCacheRef.current.get(layer) || [];
      const cachedIndex = new Map(cachedNodeOrder.map((id, idx) => [id, idx]));
      const finalNodeOrder: string[] = [];

      finalGroupOrder.forEach(groupId => {
        const nodes = groups.get(groupId) || [];
        nodes.sort((a, b) => {
          const aIdx = cachedIndex.get(a.node.id);
          const bIdx = cachedIndex.get(b.node.id);
          if (aIdx !== undefined && bIdx !== undefined) return aIdx - bIdx;
          if (aIdx !== undefined) return -1;
          if (bIdx !== undefined) return 1;
          if (a.order !== b.order) return a.order - b.order;
          return a.node.id.localeCompare(b.node.id);
        });
        nodes.forEach(node => finalNodeOrder.push(node.node.id));
      });

      orderCacheRef.current.set(layer, finalNodeOrder);
      finalNodeOrder.forEach((id, index) => {
        stableOrders.set(id, index);
      });
    });

    return connectedLayout.map(node => ({
      ...node,
      order: stableOrders.get(node.node.id) ?? node.order,
    }));
  }, [connectedLayout]);

  const sortedLayers = useMemo(() => {
    const layers = new Set(stableConnectedLayout.map(ln => ln.layer));
    return Array.from(layers).sort((a, b) => a - b);
  }, [stableConnectedLayout]);

  const standaloneGroups = useMemo(() => {
    if (standaloneLayout.length === 0) return [];

    const systemNodes: GraphNode[] = [];
    const singles: RenderGroup[] = [];

    standaloneLayout.forEach(ln => {
      if (ln.node.type === 'service') {
        systemNodes.push(ln.node);
      } else {
        singles.push({
          groupName: ln.node.name,
          nodes: [ln.node],
          isGroup: false,
          groupType: ln.node.type,
        });
      }
    });

    const result: RenderGroup[] = [];
    if (systemNodes.length > 0) {
      result.push({
        groupName: 'System Services',
        nodes: systemNodes.sort((a, b) => a.name.localeCompare(b.name)),
        isGroup: systemNodes.length > 1,
        groupType: 'service',
      });
    }

    return [...result, ...singles].sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [standaloneLayout]);

  const containerProjects = useMemo(() => {
    if (!isContainerView) return [];
    return groupContainersByProject(localNodes);
  }, [isContainerView, localNodes]);

  const flowLayout = useMemo(() => {
    const positions = new Map<string, { x: number; y: number }>();
    const nodeHeights = new Map<string, number>();
    const labelNodes: Array<{
      id: string;
      type: string;
      position: { x: number; y: number };
      data: { text: string; color?: string; offset?: boolean };
      draggable: boolean;
      selectable: boolean;
      style?: { width: number; height: number };
    }> = [];
    const boxNodes: Array<{
      id: string;
      type: string;
      position: { x: number; y: number };
      data: { width: number; height: number; color: string; offset?: boolean };
      draggable: boolean;
      selectable: boolean;
    }> = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    localNodes.forEach(node => {
      nodeHeights.set(node.id, estimateNodeHeight(node));
    });

    const centeredLabelPosition = (centerX: number, topY: number) => ({
      x: centerX - LABEL_WIDTH / 2,
      y: topY,
    });

    const layerMetas = sortedLayers.map((layer) => {
      const groups = groupLayoutNodes(stableConnectedLayout, layer);
      const groupLayouts = groups.map((group) => {
        if (!group.isGroup) {
          const height = nodeHeights.get(group.nodes[0]?.id) ?? NODE_HEIGHT;
          return { group, width: NODE_WIDTH, height, columns: 1, rowHeights: [height] };
        }
        const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
        const columnCount = Math.min(
          Math.max(1, desiredColumns),
          Math.min(MAX_GROUP_COLUMNS, group.nodes.length)
        );
        const rowCount = Math.ceil(group.nodes.length / columnCount);
        const width = columnCount * NODE_WIDTH + (columnCount - 1) * NODE_GAP;
        const rowHeights = new Array(rowCount).fill(0);
        group.nodes.forEach((node, index) => {
          const row = Math.floor(index / columnCount);
          const nodeHeight = nodeHeights.get(node.id) ?? NODE_HEIGHT;
          rowHeights[row] = Math.max(rowHeights[row], nodeHeight);
        });
        const height = rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0)
          + (rowCount - 1) * NODE_GAP;
        return { group, width, height, columns: columnCount, rowHeights };
      });
      const maxHeight = Math.max(NODE_HEIGHT, ...groupLayouts.map(g => g.height));
      return { layer, groups, groupLayouts, height: maxHeight };
    });

    let currentY = 0;
    layerMetas.forEach((meta) => {
      if (meta.groups.length === 0) return;
      const groupWidths = meta.groupLayouts.map(layout => layout.width);
      const totalWidth = groupWidths.reduce((sum, width) => sum + width, 0)
        + GROUP_GAP * Math.max(0, groupWidths.length - 1);
      let cursorX = -totalWidth / 2;
      const rowY = currentY;

      meta.groupLayouts.forEach(({ group, width, height, columns, rowHeights }) => {
        const groupX = cursorX;
        const groupY = rowY;
        const groupType = group.groupType || group.nodes[0]?.type || 'service';
        const groupColor = SERVICE_COLORS[groupType]?.color || 'rgba(110, 120, 150, 0.4)';

        boxNodes.push({
          id: `layer-${meta.layer}-group-box-${group.groupName}`,
          type: 'groupBox',
          position: {
            x: groupX - GROUP_BOX_PADDING,
            y: groupY - GROUP_BOX_PADDING,
          },
          data: {
            width: width + GROUP_BOX_PADDING * 2,
            height: height + GROUP_BOX_PADDING * 2,
            color: groupColor,
          },
          draggable: false,
          selectable: false,
        });
        minX = Math.min(minX, groupX - GROUP_BOX_PADDING);
        minY = Math.min(minY, groupY - GROUP_BOX_PADDING);
        maxX = Math.max(maxX, groupX - GROUP_BOX_PADDING + width + GROUP_BOX_PADDING * 2);
        maxY = Math.max(maxY, groupY - GROUP_BOX_PADDING + height + GROUP_BOX_PADDING * 2);

        labelNodes.push({
          id: `layer-${meta.layer}-group-label-${group.groupName}`,
          type: 'groupLabel',
          position: centeredLabelPosition(groupX + width / 2, groupY - GROUP_LABEL_OFFSET),
          data: { text: group.groupName || 'Group', color: groupColor },
          draggable: false,
          selectable: false,
          style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
        });
        minX = Math.min(minX, groupX + width / 2 - LABEL_WIDTH / 2);
        minY = Math.min(minY, groupY - GROUP_LABEL_OFFSET);
        maxX = Math.max(maxX, groupX + width / 2 + LABEL_WIDTH / 2);
        maxY = Math.max(maxY, groupY - GROUP_LABEL_OFFSET + LABEL_HEIGHT);

        group.nodes.forEach((node, index) => {
          const row = Math.floor(index / columns);
          const col = index % columns;
          const nodesInRow = Math.min(columns, group.nodes.length - row * columns);
          const rowWidth = nodesInRow * NODE_WIDTH + (nodesInRow - 1) * NODE_GAP;
          const colOffset = (width - rowWidth) / 2;
          const rowOffset = rowHeights
            ? rowHeights.slice(0, row).reduce((sum, rowHeight) => sum + rowHeight, 0)
              + row * NODE_GAP
            : row * (NODE_HEIGHT + NODE_GAP);
          const nodeHeight = nodeHeights.get(node.id) ?? NODE_HEIGHT;
          positions.set(node.id, {
            x: groupX + colOffset + col * (NODE_WIDTH + NODE_GAP),
            y: groupY + rowOffset,
          });
          minX = Math.min(minX, groupX + colOffset + col * (NODE_WIDTH + NODE_GAP));
          minY = Math.min(minY, groupY + rowOffset);
          maxX = Math.max(maxX, groupX + colOffset + col * (NODE_WIDTH + NODE_GAP) + NODE_WIDTH);
          maxY = Math.max(maxY, groupY + rowOffset + nodeHeight);
        });

        cursorX += width + GROUP_GAP;
      });

      const labelText = DEFAULT_LAYER_LABELS[meta.layer] || `Tier ${meta.layer + 1}`;
      labelNodes.push({
        id: `tier-label-${meta.layer}`,
        type: 'tierLabel',
        position: centeredLabelPosition(0, rowY - LAYER_LABEL_OFFSET),
        data: { text: labelText },
        draggable: false,
        selectable: false,
        style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
      });
      minX = Math.min(minX, -LABEL_WIDTH / 2);
      minY = Math.min(minY, rowY - LAYER_LABEL_OFFSET);
      maxX = Math.max(maxX, LABEL_WIDTH / 2);
      maxY = Math.max(maxY, rowY - LAYER_LABEL_OFFSET + LABEL_HEIGHT);

      currentY += meta.height + LAYER_GAP;
    });

    if (standaloneGroups.length > 0) {
      const baseY = currentY + STANDALONE_SECTION_OFFSET;
      let cursorX = 0;
      const groupWidths: number[] = [];
      const standaloneNodeIds = new Set<string>();

      standaloneGroups.forEach((group) => {
        const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
        const maxColumns = group.groupType === 'service'
          ? MAX_SYSTEM_SERVICE_COLUMNS
          : MAX_STANDALONE_COLUMNS;
        const columnCount = Math.min(
          Math.max(1, desiredColumns),
          Math.min(maxColumns, group.nodes.length)
        );
        const rowCount = Math.ceil(group.nodes.length / columnCount);
        const width = columnCount * NODE_WIDTH + (columnCount - 1) * STANDALONE_NODE_GAP;
        const rowHeights = new Array(rowCount).fill(0);
        group.nodes.forEach((node, index) => {
          const row = Math.floor(index / columnCount);
          const nodeHeight = nodeHeights.get(node.id) ?? NODE_HEIGHT;
          rowHeights[row] = Math.max(rowHeights[row], nodeHeight);
        });
        const height = rowHeights.reduce((sum, rowHeight) => sum + rowHeight, 0)
          + (rowCount - 1) * STANDALONE_NODE_GAP;
        groupWidths.push(width);
        const groupType = group.groupType || group.nodes[0]?.type || 'service';
        const groupColor = SERVICE_COLORS[groupType]?.color || 'rgba(110, 120, 150, 0.4)';

        labelNodes.push({
          id: `standalone-group-label-${group.groupName}`,
          type: 'groupLabel',
          position: centeredLabelPosition(cursorX + width / 2, baseY - STANDALONE_LABEL_OFFSET),
          data: { text: group.groupName || 'Standalone', color: groupColor, offset: true },
          draggable: false,
          selectable: false,
          style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
        });

        boxNodes.push({
          id: `standalone-group-box-${group.groupName}`,
          type: 'groupBox',
          position: {
            x: cursorX - GROUP_BOX_PADDING,
            y: baseY - GROUP_BOX_PADDING,
          },
          data: {
            width: width + GROUP_BOX_PADDING * 2,
            height: height + GROUP_BOX_PADDING * 2,
            color: groupColor,
            offset: true,
          },
          draggable: false,
          selectable: false,
        });
        minX = Math.min(minX, cursorX - GROUP_BOX_PADDING);
        minY = Math.min(minY, baseY - GROUP_BOX_PADDING);
        maxX = Math.max(maxX, cursorX - GROUP_BOX_PADDING + width + GROUP_BOX_PADDING * 2);
        maxY = Math.max(maxY, baseY - GROUP_BOX_PADDING + height + GROUP_BOX_PADDING * 2);

        minX = Math.min(minX, cursorX + width / 2 - LABEL_WIDTH / 2);
        minY = Math.min(minY, baseY - STANDALONE_LABEL_OFFSET);
        maxX = Math.max(maxX, cursorX + width / 2 + LABEL_WIDTH / 2);
        maxY = Math.max(maxY, baseY - STANDALONE_LABEL_OFFSET + LABEL_HEIGHT);

        group.nodes.forEach((node, index) => {
          const row = Math.floor(index / columnCount);
          const col = index % columnCount;
          const nodesInRow = Math.min(columnCount, group.nodes.length - row * columnCount);
          const rowWidth = nodesInRow * NODE_WIDTH + (nodesInRow - 1) * STANDALONE_NODE_GAP;
          const colOffset = (width - rowWidth) / 2;
          const rowOffset = rowHeights.slice(0, row).reduce((sum, rowHeight) => sum + rowHeight, 0)
            + row * STANDALONE_NODE_GAP;
          const nodeHeight = nodeHeights.get(node.id) ?? NODE_HEIGHT;
          positions.set(node.id, {
            x: cursorX + colOffset + col * (NODE_WIDTH + STANDALONE_NODE_GAP),
            y: baseY + rowOffset,
          });
          standaloneNodeIds.add(node.id);
          minX = Math.min(minX, cursorX + colOffset + col * (NODE_WIDTH + STANDALONE_NODE_GAP));
          minY = Math.min(minY, baseY + rowOffset);
          maxX = Math.max(maxX, cursorX + colOffset + col * (NODE_WIDTH + STANDALONE_NODE_GAP) + NODE_WIDTH);
          maxY = Math.max(maxY, baseY + rowOffset + nodeHeight);
        });

        cursorX += width + STANDALONE_GROUP_GAP;
      });

      const totalWidth = groupWidths.reduce((sum, width) => sum + width, 0)
        + STANDALONE_GROUP_GAP * Math.max(0, groupWidths.length - 1);
      const offset = totalWidth / 2;

      labelNodes.push({
        id: 'standalone-label',
        type: 'tierLabel',
        position: centeredLabelPosition(totalWidth / 2, baseY - STANDALONE_SECTION_OFFSET),
        data: { text: 'Standalone Services', offset: true },
        draggable: false,
        selectable: false,
        style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
      });
      minX = Math.min(minX, totalWidth / 2 - LABEL_WIDTH / 2);
      minY = Math.min(minY, baseY - STANDALONE_SECTION_OFFSET);
      maxX = Math.max(maxX, totalWidth / 2 + LABEL_WIDTH / 2);
      maxY = Math.max(maxY, baseY - STANDALONE_SECTION_OFFSET + LABEL_HEIGHT);

      positions.forEach((value, key) => {
        if (!standaloneNodeIds.has(key)) return;
        positions.set(key, { x: value.x - offset, y: value.y });
      });

      labelNodes.forEach((label) => {
        if (!label.data.offset) return;
        label.position = { x: label.position.x - offset, y: label.position.y };
      });

      boxNodes.forEach((box) => {
        if (!box.data.offset) return;
        box.position = { x: box.position.x - offset, y: box.position.y };
      });

    }

    const nodePositions = localNodes.map((node) => ({
      id: node.id,
      type: 'service',
      position: positions.get(node.id) || { x: 0, y: 0 },
      data: {
        node,
        onNodeClick: handleNodeClick,
        onNodeContextMenu: handleContextMenu,
        animate: animateNodes,
        animationIndex: stableConnectedLayout.findIndex(ln => ln.node.id === node.id),
      },
      draggable: false,
      selectable: false,
      style: { width: NODE_WIDTH },
    }));

    minX = Infinity;
    minY = Infinity;
    maxX = -Infinity;
    maxY = -Infinity;

    const updateBounds = (x: number, y: number, width: number, height: number) => {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + width);
      maxY = Math.max(maxY, y + height);
    };

    nodePositions.forEach((node) => {
      const nodeHeight = nodeHeights.get(node.id) ?? NODE_HEIGHT;
      updateBounds(node.position.x, node.position.y, NODE_WIDTH, nodeHeight);
    });

    labelNodes.forEach((label) => {
      updateBounds(label.position.x - LABEL_WIDTH / 2, label.position.y, LABEL_WIDTH, LABEL_HEIGHT);
    });

    boxNodes.forEach((box) => {
      updateBounds(box.position.x, box.position.y, box.data.width, box.data.height);
    });

    const boundsPad = 120;
    const bounds: [[number, number], [number, number]] = [
      [Number.isFinite(minX) ? minX - boundsPad : -800, Number.isFinite(minY) ? minY - boundsPad : -600],
      [Number.isFinite(maxX) ? maxX + boundsPad : 800, Number.isFinite(maxY) ? maxY + boundsPad : 600],
    ];

    return {
      nodes: [...boxNodes, ...nodePositions, ...labelNodes],
      bounds,
    };
  }, [localNodes, sortedLayers, stableConnectedLayout, standaloneGroups, handleNodeClick, handleContextMenu, animateNodes, externalApiVersion]);

  const flowEdges = useMemo(() => {
    return localEdges.map((edge) => {
      const confidence = edge.confidence ?? 0.6;
      const opacity = Math.max(0.25, Math.min(1, 0.35 + confidence * 0.65));
      return {
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep' as const,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 18,
          height: 18,
          color: 'var(--graph-edge)',
        },
        className: 'graph-edge',
        style: {
          opacity,
          stroke: 'var(--graph-edge)',
          strokeWidth: 1.6,
          strokeLinecap: 'round' as const,
          strokeLinejoin: 'round' as const,
        },
      };
    });
  }, [localEdges]);

  const nodeTypes = useMemo(() => ({
    service: FlowServiceNode,
    tierLabel: TierLabelNode,
    groupLabel: GroupLabelNode,
    groupBox: GroupBoxNode,
  }), []);
  const defaultEdgeOptions = useMemo(() => ({
    type: 'smoothstep' as const,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 18,
      height: 18,
      color: 'var(--graph-edge)',
    },
    style: {
      stroke: 'var(--graph-edge)',
      strokeWidth: 1.7,
      strokeLinecap: 'round' as const,
      strokeLinejoin: 'round' as const,
    },
  }), []);

  useEffect(() => {
    if (!reactFlowInstance || didFitViewRef.current) return;
    if (localNodes.length === 0) return;
    reactFlowInstance.fitView({ padding: 0.24, duration: 0 });
    didFitViewRef.current = true;
  }, [reactFlowInstance, localNodes.length]);

  const formatAge = useCallback((ageMs?: number | null) => {
    if (ageMs === null || ageMs === undefined) return '—';
    if (ageMs < 1000) return `${Math.max(0, Math.round(ageMs))}ms`;
    if (ageMs < 60000) return `${(ageMs / 1000).toFixed(1)}s`;
    return `${Math.round(ageMs / 60000)}m`;
  }, []);

  const lastUpdated = dataStatus?.collectedAt
    ? formatAge(Date.now() - dataStatus.collectedAt)
    : '—';

  if (localNodes.length === 0) {
    return (
      <div className="graph-view" ref={containerRef}>
        <div className="graph-empty">
          <p>No services running</p>
          <span>Start a dev server to see the connection graph</span>
        </div>
      </div>
    );
  }

  return (
    <div className="graph-view" ref={containerRef}>
      <div className="graph-legend">
        <div className="graph-legend-title">Service Types</div>
        {Array.from(new Set(localNodes.map(n => n.type)))
          .filter(type => SERVICE_COLORS[type])
          .map(type => (
            <div key={type} className="graph-legend-item">
              <div
                className="graph-legend-dot"
                style={{ backgroundColor: SERVICE_COLORS[type].color }}
              />
              <span>{SERVICE_COLORS[type].label}</span>
            </div>
          ))}
      </div>

      {dataStatus && (
        <div className="graph-freshness">
          <span className="graph-freshness-title">Last updated</span>
          <span className="graph-freshness-value">{lastUpdated} ago</span>
          <span className="graph-freshness-meta">
            ps {formatAge(dataStatus.processesAgeMs)} · lsof {formatAge(dataStatus.portsAgeMs)} · tcp {formatAge(dataStatus.connectionsAgeMs)}
          </span>
        </div>
      )}

      {isContainerView ? (
        <div className="container-projects-view">
          {containerProjects.map((project, projectIdx) => (
            <ProjectContainer
              key={`project-${project.projectName}`}
              project={project}
              onNodeClick={handleNodeClick}
              onContextMenu={handleContextMenu}
              animationDelay={projectIdx * 150}
            />
          ))}
        </div>
      ) : (
        <div className="graph-flow">
          <ReactFlow
            nodes={flowLayout.nodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={defaultEdgeOptions}
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable={false}
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            panOnScroll
            minZoom={0.25}
            maxZoom={1.8}
            translateExtent={flowLayout.bounds}
            onInit={setReactFlowInstance}
            onPaneClick={() => {
              setSelectedNode(null);
              setContextMenu(null);
            }}
            onPaneContextMenu={(event) => {
              event.preventDefault();
              setContextMenu(null);
            }}
          >
            <Background color="rgba(0,0,0,0.04)" gap={24} />
            <Controls position="top-right" />
          </ReactFlow>
        </div>
      )}

      {contextMenu && (
        <ContextMenu
          node={contextMenu.node}
          x={contextMenu.x}
          y={contextMenu.y}
          width={contextMenu.width}
          height={contextMenu.height}
          onClose={() => setContextMenu(null)}
        />
      )}

      {selectedNode && (
        <NodeDetailPanel
          node={selectedNode}
          edges={localEdges}
          allNodes={localNodes}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
