import type { GraphNode } from "../../types/electron";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { LayoutNode, RenderGroup } from "./types";
import { groupLayoutNodes } from "./grouping";
import type { FlowServiceNodeData } from "./flowNodes";

export const FLOW_LAYOUT = {
  NODE_WIDTH: 260,
  NODE_MIN_HEIGHT: 150,
  NODE_GAP: 16,
  STANDALONE_NODE_GAP: 16,
  GROUP_GAP: 20,
  LAYER_GAP: 140,
  STANDALONE_GROUP_GAP: 24,
  STANDALONE_LABEL_OFFSET: 48,
  LAYER_LABEL_OFFSET: 52,
  STANDALONE_SECTION_OFFSET: 84,
  GROUP_BOX_PADDING: 10,
  GROUP_LABEL_OFFSET: 28,
  LABEL_WIDTH: 180,
  LABEL_HEIGHT: 28,
  MAX_GROUP_COLUMNS: 2,
  MAX_STANDALONE_COLUMNS: 2,
  MAX_SYSTEM_SERVICE_COLUMNS: 3,
  GROUP_COLOR: "rgba(140, 150, 170, 0.35)",
} as const;

type LabelNodeData = { text: string; color?: string; offset?: boolean };
type BoxNodeData = { width: number; height: number; color: string; offset?: boolean };

type FlowNode<T> = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: T;
  draggable: boolean;
  selectable: boolean;
  style?: { width: number; height?: number };
};

export type FlowLayoutResult = {
  nodes: Array<FlowNode<LabelNodeData | BoxNodeData | FlowServiceNodeData>>;
  bounds: [[number, number], [number, number]];
};

export function buildStableConnectedLayout(
  connectedLayout: LayoutNode[],
  orderCache: Map<number, string[]>,
  groupOrderCache: Map<number, string[]>,
) {
  const byLayer = new Map<number, LayoutNode[]>();
  connectedLayout.forEach((node) => {
    if (!byLayer.has(node.layer)) byLayer.set(node.layer, []);
    byLayer.get(node.layer)!.push(node);
  });

  const stableOrders = new Map<string, number>();
  byLayer.forEach((layerNodes, layer) => {
    const groups = new Map<string, LayoutNode[]>();
    layerNodes.forEach((node) => {
      if (!groups.has(node.groupId)) groups.set(node.groupId, []);
      groups.get(node.groupId)!.push(node);
    });

    const groupIds = Array.from(groups.keys());
    const groupOrderSeed = [...groupIds].sort((a, b) => {
      const aOrder = Math.min(...groups.get(a)!.map((n) => n.order));
      const bOrder = Math.min(...groups.get(b)!.map((n) => n.order));
      return aOrder - bOrder;
    });

    const cachedGroupOrder = groupOrderCache.get(layer);
    const groupSet = new Set(groupIds);
    const sameGroupSet =
      cachedGroupOrder &&
      cachedGroupOrder.length === groupIds.length &&
      cachedGroupOrder.every((id) => groupSet.has(id));
    const finalGroupOrder = sameGroupSet ? cachedGroupOrder : groupOrderSeed;
    groupOrderCache.set(layer, finalGroupOrder);

    const cachedNodeOrder = orderCache.get(layer) || [];
    const cachedIndex = new Map(cachedNodeOrder.map((id, idx) => [id, idx]));
    const finalNodeOrder: string[] = [];

    finalGroupOrder.forEach((groupId) => {
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
      nodes.forEach((node) => finalNodeOrder.push(node.node.id));
    });

    orderCache.set(layer, finalNodeOrder);
    finalNodeOrder.forEach((id, index) => {
      stableOrders.set(id, index);
    });
  });

  return connectedLayout.map((node) => ({
    ...node,
    order: stableOrders.get(node.node.id) ?? node.order,
  }));
}

type BuildLayoutInput = {
  layoutNodes: GraphNode[];
  sortedLayers: number[];
  stableConnectedLayout: LayoutNode[];
  standaloneGroups: RenderGroup[];
  nodeHeights: Map<string, number>;
  onNodeClick: (node: GraphNode) => void;
  onNodeContextMenu: (event: ReactMouseEvent, node: GraphNode) => void;
  animateNodes: boolean;
  onMeasure: (id: string, height: number) => void;
  isContainerView: boolean;
  hoveredNodeId: string | null;
  connectedNodeIds: Set<string>;
};

export function buildFlowLayout({
  layoutNodes,
  sortedLayers,
  stableConnectedLayout,
  standaloneGroups,
  nodeHeights,
  onNodeClick,
  onNodeContextMenu,
  animateNodes,
  onMeasure,
  isContainerView,
  hoveredNodeId,
  connectedNodeIds,
}: BuildLayoutInput): FlowLayoutResult {
  const {
    NODE_WIDTH,
    NODE_MIN_HEIGHT,
    NODE_GAP,
    STANDALONE_NODE_GAP,
    GROUP_GAP,
    LAYER_GAP,
    STANDALONE_GROUP_GAP,
    STANDALONE_LABEL_OFFSET,
    LAYER_LABEL_OFFSET,
    STANDALONE_SECTION_OFFSET,
    GROUP_BOX_PADDING,
    GROUP_LABEL_OFFSET,
    LABEL_WIDTH,
    LABEL_HEIGHT,
    MAX_GROUP_COLUMNS,
    MAX_STANDALONE_COLUMNS,
    MAX_SYSTEM_SERVICE_COLUMNS,
    GROUP_COLOR,
  } = FLOW_LAYOUT;

  const positions = new Map<string, { x: number; y: number }>();
  const labelNodes: Array<FlowNode<LabelNodeData>> = [];
  const boxNodes: Array<FlowNode<BoxNodeData>> = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const centeredLabelPosition = (centerX: number, topY: number) => ({
    x: centerX - LABEL_WIDTH / 2,
    y: topY,
  });

  let currentY = 0;
  if (!isContainerView) {
    const layerMetas = sortedLayers.map((layer) => {
      const groups = groupLayoutNodes(stableConnectedLayout, layer);
      const groupLayouts = groups.map((group) => {
        if (!group.isGroup) {
          const measured =
            nodeHeights.get(group.nodes[0]?.id ?? "") ?? NODE_MIN_HEIGHT;
          return {
            group,
            width: NODE_WIDTH,
            height: measured,
            columns: 1,
            rowCount: 1,
            rowHeights: [measured],
          };
        }
        const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
        const columnCount = Math.min(
          Math.max(1, desiredColumns),
          Math.min(MAX_GROUP_COLUMNS, group.nodes.length),
        );
        const rowCount = Math.ceil(group.nodes.length / columnCount);
        const width = columnCount * NODE_WIDTH + (columnCount - 1) * NODE_GAP;
        const rowHeights = new Array(rowCount).fill(NODE_MIN_HEIGHT);
        group.nodes.forEach((node, index) => {
          const row = Math.floor(index / columnCount);
          const measured = nodeHeights.get(node.id) ?? NODE_MIN_HEIGHT;
          rowHeights[row] = Math.max(rowHeights[row], measured);
        });
        const height =
          rowHeights.reduce((sum, h) => sum + h, 0) +
          (rowCount - 1) * NODE_GAP;
        return {
          group,
          width,
          height,
          columns: columnCount,
          rowCount,
          rowHeights,
        };
      });
      const maxHeight = Math.max(
        NODE_MIN_HEIGHT,
        ...groupLayouts.map((g) => g.height),
      );
      return { layer, groups, groupLayouts, height: maxHeight };
    });

    layerMetas.forEach((meta) => {
      if (meta.groups.length === 0) return;
      const groupWidths = meta.groupLayouts.map((layout) => layout.width);
      const totalWidth =
        groupWidths.reduce((sum, width) => sum + width, 0) +
        GROUP_GAP * Math.max(0, groupWidths.length - 1);
      let cursorX = -totalWidth / 2;
      const rowY = currentY;

      meta.groupLayouts.forEach(({ group, width, height, columns, rowHeights }) => {
        const groupX = cursorX;
        const groupY = rowY;

        if (group.isGroup) {
          boxNodes.push({
            id: `layer-${meta.layer}-group-box-${group.groupName}`,
            type: "groupBox",
            position: {
              x: groupX - GROUP_BOX_PADDING,
              y: groupY - GROUP_BOX_PADDING,
            },
            data: {
              width: width + GROUP_BOX_PADDING * 2,
              height: height + GROUP_BOX_PADDING * 2,
              color: GROUP_COLOR,
            },
            draggable: false,
            selectable: false,
          });
          minX = Math.min(minX, groupX - GROUP_BOX_PADDING);
          minY = Math.min(minY, groupY - GROUP_BOX_PADDING);
          maxX = Math.max(
            maxX,
            groupX - GROUP_BOX_PADDING + width + GROUP_BOX_PADDING * 2,
          );
          maxY = Math.max(
            maxY,
            groupY - GROUP_BOX_PADDING + height + GROUP_BOX_PADDING * 2,
          );

          labelNodes.push({
            id: `layer-${meta.layer}-group-label-${group.groupName}`,
            type: "groupLabel",
            position: centeredLabelPosition(
              groupX + width / 2,
              groupY - GROUP_LABEL_OFFSET,
            ),
            data: { text: group.groupName || "Group", color: GROUP_COLOR },
            draggable: false,
            selectable: false,
            style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
          });
          minX = Math.min(minX, groupX + width / 2 - LABEL_WIDTH / 2);
          minY = Math.min(minY, groupY - GROUP_LABEL_OFFSET);
          maxX = Math.max(maxX, groupX + width / 2 + LABEL_WIDTH / 2);
          maxY = Math.max(maxY, groupY - GROUP_LABEL_OFFSET + LABEL_HEIGHT);
        }

        group.nodes.forEach((node, index) => {
          const row = Math.floor(index / columns);
          const col = index % columns;
          const nodesInRow = Math.min(
            columns,
            group.nodes.length - row * columns,
          );
          const rowWidth =
            nodesInRow * NODE_WIDTH + (nodesInRow - 1) * NODE_GAP;
          const colOffset = (width - rowWidth) / 2;
          const rowOffset =
            (rowHeights ?? []).slice(0, row).reduce((sum, h) => sum + h, 0) +
            row * NODE_GAP;
          positions.set(node.id, {
            x: groupX + colOffset + col * (NODE_WIDTH + NODE_GAP),
            y: groupY + rowOffset,
          });
          minX = Math.min(
            minX,
            groupX + colOffset + col * (NODE_WIDTH + NODE_GAP),
          );
          minY = Math.min(minY, groupY + rowOffset);
          maxX = Math.max(
            maxX,
            groupX + colOffset + col * (NODE_WIDTH + NODE_GAP) + NODE_WIDTH,
          );
          const measured = nodeHeights.get(node.id) ?? NODE_MIN_HEIGHT;
          maxY = Math.max(maxY, groupY + rowOffset + measured);
        });

        cursorX += width + GROUP_GAP;
      });

      const labelText = `Layer ${meta.layer}`;
      labelNodes.push({
        id: `tier-label-${meta.layer}`,
        type: "tierLabel",
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
  }

  if (standaloneGroups.length > 0) {
    const baseY = currentY + STANDALONE_SECTION_OFFSET;
    const meta = standaloneGroups.map((group) => {
      const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
      const maxColumns =
        group.groupType === "service"
          ? MAX_SYSTEM_SERVICE_COLUMNS
          : MAX_STANDALONE_COLUMNS;
      const columnCount = Math.min(
        Math.max(1, desiredColumns),
        Math.min(maxColumns, group.nodes.length),
      );
      const rowCount = Math.ceil(group.nodes.length / columnCount);
      const width =
        columnCount * NODE_WIDTH + (columnCount - 1) * STANDALONE_NODE_GAP;
      const rowHeights = new Array(rowCount).fill(NODE_MIN_HEIGHT);
      group.nodes.forEach((node, index) => {
        const row = Math.floor(index / columnCount);
        const measured = nodeHeights.get(node.id) ?? NODE_MIN_HEIGHT;
        rowHeights[row] = Math.max(rowHeights[row], measured);
      });
      const height =
        rowHeights.reduce((sum, h) => sum + h, 0) +
        (rowCount - 1) * STANDALONE_NODE_GAP;
      return { group, columnCount, width, height, rowHeights };
    });

    const maxGroupsPerRow = isContainerView ? 2 : meta.length;
    let cursorY = baseY;
    let startIndex = 0;

    while (startIndex < meta.length) {
      const rowItems = meta.slice(startIndex, startIndex + maxGroupsPerRow);
      const rowWidth =
        rowItems.reduce((sum, item) => sum + item.width, 0) +
        STANDALONE_GROUP_GAP * Math.max(0, rowItems.length - 1);
      const rowOffset = rowWidth / 2;
      let cursorX = 0;

      rowItems.forEach((item) => {
        const groupX = cursorX;

        if (item.group.isGroup) {
          labelNodes.push({
            id: `standalone-group-label-${item.group.groupName}-${startIndex}`,
            type: "groupLabel",
            position: centeredLabelPosition(
              groupX + item.width / 2,
              cursorY - STANDALONE_LABEL_OFFSET,
            ),
            data: {
              text: item.group.groupName || "Standalone",
              color: GROUP_COLOR,
              offset: true,
            },
            draggable: false,
            selectable: false,
            style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
          });

          boxNodes.push({
            id: `standalone-group-box-${item.group.groupName}-${startIndex}`,
            type: "groupBox",
            position: {
              x: groupX - GROUP_BOX_PADDING,
              y: cursorY - GROUP_BOX_PADDING,
            },
            data: {
              width: item.width + GROUP_BOX_PADDING * 2,
              height: item.height + GROUP_BOX_PADDING * 2,
              color: GROUP_COLOR,
              offset: true,
            },
            draggable: false,
            selectable: false,
          });
        }

        item.group.nodes.forEach((node, nodeIndex) => {
          const row = Math.floor(nodeIndex / item.columnCount);
          const col = nodeIndex % item.columnCount;
          const nodesInRow = Math.min(
            item.columnCount,
            item.group.nodes.length - row * item.columnCount,
          );
          const rowWidth =
            nodesInRow * NODE_WIDTH +
            (nodesInRow - 1) * STANDALONE_NODE_GAP;
          const colOffset = (item.width - rowWidth) / 2;
          positions.set(node.id, {
            x: groupX + colOffset + col * (NODE_WIDTH + STANDALONE_NODE_GAP),
            y:
              cursorY +
              (item.rowHeights ?? [])
                .slice(0, row)
                .reduce((sum, h) => sum + h, 0) +
              row * STANDALONE_NODE_GAP,
          });
        });

        cursorX += item.width + STANDALONE_GROUP_GAP;
      });

      const shiftRow = (x: number) => x - rowOffset;
      rowItems.forEach((item) => {
        item.group.nodes.forEach((node) => {
          const pos = positions.get(node.id);
          if (!pos) return;
          positions.set(node.id, { x: shiftRow(pos.x), y: pos.y });
        });
      });

      labelNodes.forEach((label) => {
        if (!label.data.offset) return;
        if (!label.id.includes(`-${startIndex}`)) return;
        label.position = {
          x: shiftRow(label.position.x),
          y: label.position.y,
        };
      });

      boxNodes.forEach((box) => {
        if (!box.data.offset) return;
        if (!box.id.includes(`-${startIndex}`)) return;
        box.position = {
          x: shiftRow(box.position.x),
          y: box.position.y,
        };
      });

      const rowHeight = Math.max(...rowItems.map((item) => item.height));
      cursorY += rowHeight + STANDALONE_GROUP_GAP + STANDALONE_LABEL_OFFSET;
      startIndex += maxGroupsPerRow;
    }

    if (!isContainerView) {
      labelNodes.push({
        id: "standalone-label",
        type: "tierLabel",
        position: centeredLabelPosition(0, baseY - STANDALONE_SECTION_OFFSET),
        data: { text: "Standalone Services", offset: true },
        draggable: false,
        selectable: false,
        style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
      });
    }
  }

  const nodePositions: Array<FlowNode<FlowServiceNodeData>> = layoutNodes.map((node) => ({
    id: node.id,
    type: "service",
    position: positions.get(node.id) || { x: 0, y: 0 },
    data: {
      node,
      onNodeClick,
      onNodeContextMenu,
      animate: animateNodes,
      animationIndex: Math.max(
        0,
        stableConnectedLayout.findIndex((ln) => ln.node.id === node.id),
      ),
      onMeasure,
      dimmed: hoveredNodeId !== null && !connectedNodeIds.has(node.id),
    },
    draggable: false,
    selectable: false,
    style: { width: NODE_WIDTH },
  }));

  minX = Infinity;
  minY = Infinity;
  maxX = -Infinity;
  maxY = -Infinity;

  const updateBounds = (
    x: number,
    y: number,
    width: number,
    height: number,
  ) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  };

  nodePositions.forEach((node) => {
    const measured = nodeHeights.get(node.id) ?? NODE_MIN_HEIGHT;
    updateBounds(node.position.x, node.position.y, NODE_WIDTH, measured);
  });

  labelNodes.forEach((label) => {
    updateBounds(
      label.position.x - LABEL_WIDTH / 2,
      label.position.y,
      LABEL_WIDTH,
      LABEL_HEIGHT,
    );
  });

  boxNodes.forEach((box) => {
    updateBounds(
      box.position.x,
      box.position.y,
      box.data.width,
      box.data.height,
    );
  });

  const boundsPad = 120;
  const bounds: [[number, number], [number, number]] = [
    [
      Number.isFinite(minX) ? minX - boundsPad : -800,
      Number.isFinite(minY) ? minY - boundsPad : -600,
    ],
    [
      Number.isFinite(maxX) ? maxX + boundsPad : 800,
      Number.isFinite(maxY) ? maxY + boundsPad : 600,
    ],
  ];

  return {
    nodes: [...boxNodes, ...nodePositions, ...labelNodes],
    bounds,
  };
}
