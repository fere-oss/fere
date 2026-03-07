import type { GraphNode } from "../../types/electron";
import type { MouseEvent as ReactMouseEvent } from "react";
import type { LayoutNode, RenderGroup } from "./types";
import { groupLayoutNodes } from "./grouping";
import type { FlowServiceNodeData } from "./flowNodes";
import { supportsExternalApiScan } from "./externalApis";

// Primitive constants — all derived values below depend on these.
const TIER_LABEL_HEIGHT = 40; // layer labels (LAYER 0, LAYER 1 …) — larger
const LABEL_HEIGHT = 28; // group labels (STOREFRONT-WEB …) — smaller
const GROUP_BOX_PADDING = 16;
const LABEL_SPACING = 12; // minimum gap between layer label and group label
const INTER_LAYER_SPACING = 36; // gap between previous layer's content and next layer's label

// Vertical stacking above each layer's rowY (node top edge):
//   ┌─ Layer label ─┐   ← rowY - LAYER_LABEL_OFFSET          (height: TIER_LABEL_HEIGHT)
//        (gap)
//   ┌─ Group label ─┐   ← rowY - GROUP_BOX_PADDING - LABEL_HEIGHT - 4
//   ┌─ Group box  ──┐   ← rowY - GROUP_BOX_PADDING
//   │   Nodes …     │   ← rowY
//
// LAYER_LABEL_OFFSET is derived so the layer label bottom never overlaps the
// group label top:
//   rowY - LAYER_LABEL_OFFSET + TIER_LABEL_HEIGHT  <=  rowY - GROUP_BOX_PADDING - LABEL_HEIGHT - 4 - LABEL_SPACING
//   ⟹  LAYER_LABEL_OFFSET  >=  TIER_LABEL_HEIGHT + GROUP_BOX_PADDING + LABEL_HEIGHT + 4 + LABEL_SPACING
const LAYER_LABEL_OFFSET =
  TIER_LABEL_HEIGHT + GROUP_BOX_PADDING + LABEL_HEIGHT + 4 + LABEL_SPACING;

// LAYER_GAP must be large enough that the previous layer's group box bottom
// doesn't collide with the next layer's layer label top:
//   LAYER_GAP  >=  LAYER_LABEL_OFFSET + GROUP_BOX_PADDING + INTER_LAYER_SPACING
const LAYER_GAP = LAYER_LABEL_OFFSET + GROUP_BOX_PADDING + INTER_LAYER_SPACING;

export const FLOW_LAYOUT = {
  NODE_WIDTH: 260,
  NODE_MIN_HEIGHT: 190,
  NODE_GAP: 40,
  STANDALONE_NODE_GAP: 36,
  GROUP_GAP: 40,
  LAYER_GAP,
  STANDALONE_GROUP_GAP: 24,
  STANDALONE_LABEL_OFFSET: 64,
  CONTAINER_SECTION_OFFSET: 64,
  CONTAINER_LABEL_OFFSET: 36,
  CONTAINER_GROUP_GAP: 32,
  CONTAINER_GROUP_ROW_GAP: 36,
  CONTAINER_NODE_GAP: 20,
  CONTAINER_NODE_MIN_HEIGHT: 132,
  CONTAINER_GROUP_BOX_PADDING: 16,
  LAYER_LABEL_OFFSET,
  STANDALONE_SECTION_OFFSET: 120,
  GROUP_BOX_PADDING,
  LABEL_WIDTH: 240,
  TIER_LABEL_HEIGHT,
  LABEL_HEIGHT,
  MAX_GROUP_COLUMNS: 2,
  MAX_STANDALONE_COLUMNS: 2,
  MAX_CONTAINER_COLUMNS: 3,
  MAX_SYSTEM_SERVICE_COLUMNS: 3,
  GROUP_COLOR: "rgba(140, 150, 170, 0.35)",
} as const;

type LabelNodeData = { text: string; color?: string; offset?: boolean };
type BoxNodeData = {
  width: number;
  height: number;
  color: string;
  offset?: boolean;
};

type FlowNode<T> = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: T;
  draggable: boolean;
  selectable: boolean;
  className?: string;
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
  animateNodeIds: Set<string>;
  onMeasure: (id: string, height: number) => void;
  isContainerView: boolean;
  debugHighlightNodeIds?: Set<string>;
};

export function buildFlowLayout({
  layoutNodes,
  sortedLayers,
  stableConnectedLayout,
  standaloneGroups,
  nodeHeights,
  onNodeClick,
  onNodeContextMenu,
  animateNodeIds,
  onMeasure,
  isContainerView,
  debugHighlightNodeIds,
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
    CONTAINER_SECTION_OFFSET,
    CONTAINER_LABEL_OFFSET,
    CONTAINER_GROUP_GAP,
    CONTAINER_GROUP_ROW_GAP,
    CONTAINER_NODE_GAP,
    CONTAINER_NODE_MIN_HEIGHT,
    CONTAINER_GROUP_BOX_PADDING,
    LAYER_LABEL_OFFSET,
    STANDALONE_SECTION_OFFSET,
    GROUP_BOX_PADDING,
    LABEL_WIDTH,
    TIER_LABEL_HEIGHT,
    LABEL_HEIGHT,
    MAX_GROUP_COLUMNS,
    MAX_STANDALONE_COLUMNS,
    MAX_CONTAINER_COLUMNS,
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
  const fallbackNodeHeight = isContainerView
    ? CONTAINER_NODE_MIN_HEIGHT
    : NODE_MIN_HEIGHT;
  const estimateNodeHeight = (node: GraphNode): number => {
    let estimated = fallbackNodeHeight;

    // Reserve space while deferred enrichments (routes/external APIs) stream in.
    if (!isContainerView && supportsExternalApiScan(node)) {
      estimated += 64;
    }
    if (!isContainerView && node.routes && node.routes.length > 0) {
      const visibleRoutes = Math.min(3, node.routes.length);
      estimated += 26 + visibleRoutes * 18 + (node.routes.length > 3 ? 16 : 0);
    }
    if (isContainerView && node.containerNetworks && node.containerNetworks.length > 0) {
      estimated += 24;
    }

    return estimated;
  };
  const resolveNodeHeight = (node: GraphNode): number => {
    const measured = nodeHeights.get(node.id);
    if (measured !== undefined) return measured;
    return estimateNodeHeight(node);
  };

  let currentY = 0;
  if (!isContainerView) {
    const layerMetas = sortedLayers.map((layer) => {
      const groups = groupLayoutNodes(stableConnectedLayout, layer);
      const groupLayouts = groups.map((group) => {
        if (!group.isGroup) {
          const firstNode = group.nodes[0];
          const measured = firstNode
            ? resolveNodeHeight(firstNode)
            : NODE_MIN_HEIGHT;
          return {
            group,
            width: NODE_WIDTH,
            height: measured,
            occupiedWidth: NODE_WIDTH,
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
          rowHeights[row] = Math.max(rowHeights[row], resolveNodeHeight(node));
        });
        const height =
          rowHeights.reduce((sum, h) => sum + h, 0) + (rowCount - 1) * NODE_GAP;
        return {
          group,
          width,
          height,
          occupiedWidth: Math.max(width + GROUP_BOX_PADDING * 2, LABEL_WIDTH),
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
      const groupWidths = meta.groupLayouts.map(
        (layout) => layout.occupiedWidth,
      );
      const totalWidth =
        groupWidths.reduce((sum, width) => sum + width, 0) +
        GROUP_GAP * Math.max(0, groupWidths.length - 1);
      let cursorX = -totalWidth / 2;
      const rowY = currentY;

      meta.groupLayouts.forEach(
        ({ group, width, height, occupiedWidth, columns, rowHeights }) => {
          const groupCenterX = cursorX + occupiedWidth / 2;
          const groupX = group.isGroup ? groupCenterX - width / 2 : cursorX;
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
                groupY - GROUP_BOX_PADDING - LABEL_HEIGHT - 4,
              ),
              data: { text: group.groupName || "Group", color: GROUP_COLOR },
              draggable: false,
              selectable: false,
              style: { width: LABEL_WIDTH, height: LABEL_HEIGHT },
            });
            minX = Math.min(minX, groupX + width / 2 - LABEL_WIDTH / 2);
            minY = Math.min(minY, groupY - GROUP_BOX_PADDING - LABEL_HEIGHT - 4);
            maxX = Math.max(maxX, groupX + width / 2 + LABEL_WIDTH / 2);
            maxY = Math.max(
              maxY,
              groupY - GROUP_BOX_PADDING - LABEL_HEIGHT - 4 + LABEL_HEIGHT,
            );
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
            const measured = resolveNodeHeight(node);
            maxY = Math.max(maxY, groupY + rowOffset + measured);
          });

          cursorX += occupiedWidth + GROUP_GAP;
        },
      );

      const labelText = `Layer ${meta.layer}`;
      labelNodes.push({
        id: `tier-label-${meta.layer}`,
        type: "tierLabel",
        position: centeredLabelPosition(0, rowY - LAYER_LABEL_OFFSET),
        data: { text: labelText },
        draggable: false,
        selectable: false,
        style: { width: LABEL_WIDTH, height: TIER_LABEL_HEIGHT },
      });
      minX = Math.min(minX, -LABEL_WIDTH / 2);
      minY = Math.min(minY, rowY - LAYER_LABEL_OFFSET);
      maxX = Math.max(maxX, LABEL_WIDTH / 2);
      maxY = Math.max(maxY, rowY - LAYER_LABEL_OFFSET + TIER_LABEL_HEIGHT);

      currentY += meta.height + LAYER_GAP;
    });
  }

  if (standaloneGroups.length > 0) {
    const rowLabelOffset = isContainerView
      ? CONTAINER_LABEL_OFFSET
      : STANDALONE_LABEL_OFFSET;
    const nodeGap = isContainerView ? CONTAINER_NODE_GAP : STANDALONE_NODE_GAP;
    const nodeMinHeight = isContainerView
      ? CONTAINER_NODE_MIN_HEIGHT
      : NODE_MIN_HEIGHT;
    const groupBoxPadding = isContainerView
      ? CONTAINER_GROUP_BOX_PADDING
      : GROUP_BOX_PADDING;
    const groupGap = isContainerView
      ? CONTAINER_GROUP_GAP
      : STANDALONE_GROUP_GAP;
    const rowGap = isContainerView
      ? CONTAINER_GROUP_ROW_GAP
      : STANDALONE_GROUP_GAP;
    const baseY =
      currentY +
      (isContainerView ? CONTAINER_SECTION_OFFSET : STANDALONE_SECTION_OFFSET);
    const meta = standaloneGroups.map((group) => {
      const desiredColumns = Math.ceil(Math.sqrt(group.nodes.length));
      const maxColumns = isContainerView
        ? MAX_CONTAINER_COLUMNS
        : group.groupType === "service"
          ? MAX_SYSTEM_SERVICE_COLUMNS
          : MAX_STANDALONE_COLUMNS;
      const columnCount = Math.min(
        Math.max(1, desiredColumns),
        Math.min(maxColumns, group.nodes.length),
      );
      const rowCount = Math.ceil(group.nodes.length / columnCount);
      const width =
        columnCount * NODE_WIDTH + (columnCount - 1) * nodeGap;
      const rowHeights = new Array(rowCount).fill(nodeMinHeight);
      group.nodes.forEach((node, index) => {
        const row = Math.floor(index / columnCount);
        const measured = resolveNodeHeight(node);
        rowHeights[row] = Math.max(rowHeights[row], measured);
      });
      const height =
        rowHeights.reduce((sum, h) => sum + h, 0) +
        (rowCount - 1) * nodeGap;
      return {
        group,
        columnCount,
        width,
        height,
        occupiedWidth: group.isGroup
          ? Math.max(width + groupBoxPadding * 2, LABEL_WIDTH)
          : width,
        rowHeights,
      };
    });

    const maxGroupsPerRow = isContainerView ? 3 : meta.length;
    let cursorY = baseY;
    let startIndex = 0;

    while (startIndex < meta.length) {
      const rowItems = meta.slice(startIndex, startIndex + maxGroupsPerRow);
      const rowWidth =
        rowItems.reduce((sum, item) => sum + item.occupiedWidth, 0) +
        groupGap * Math.max(0, rowItems.length - 1);
      const rowOffset = rowWidth / 2;
      let cursorX = 0;
      const currentStartIndex = startIndex;
      const currentCursorY = cursorY;

      rowItems.forEach((item) => {
        const groupCenterX = cursorX + item.occupiedWidth / 2;
        const groupX = item.group.isGroup
          ? groupCenterX - item.width / 2
          : cursorX;

        if (item.group.isGroup) {
          labelNodes.push({
            id: `standalone-group-label-${item.group.groupName}-${currentStartIndex}`,
            type: "groupLabel",
            position: centeredLabelPosition(
              groupX + item.width / 2,
              isContainerView
                ? currentCursorY - groupBoxPadding - LABEL_HEIGHT - 4
                : currentCursorY - rowLabelOffset,
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
            id: `standalone-group-box-${item.group.groupName}-${currentStartIndex}`,
            type: "groupBox",
            position: {
              x: groupX - groupBoxPadding,
              y: currentCursorY - groupBoxPadding,
            },
            data: {
              width: item.width + groupBoxPadding * 2,
              height: item.height + groupBoxPadding * 2,
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
            nodesInRow * NODE_WIDTH + (nodesInRow - 1) * nodeGap;
          const colOffset = (item.width - rowWidth) / 2;
          positions.set(node.id, {
            x: groupX + colOffset + col * (NODE_WIDTH + nodeGap),
            y:
              currentCursorY +
              (item.rowHeights ?? [])
                .slice(0, row)
                .reduce((sum, h) => sum + h, 0) +
              row * nodeGap,
          });
        });

        cursorX += item.occupiedWidth + groupGap;
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
        if (!label.id.includes(`-${currentStartIndex}`)) return;
        label.position = {
          x: shiftRow(label.position.x),
          y: label.position.y,
        };
      });

      boxNodes.forEach((box) => {
        if (!box.data.offset) return;
        if (!box.id.includes(`-${currentStartIndex}`)) return;
        box.position = {
          x: shiftRow(box.position.x),
          y: box.position.y,
        };
      });

      const rowHeight = Math.max(...rowItems.map((item) =>
        item.height + (item.group.isGroup ? groupBoxPadding : 0),
      ));
      cursorY += rowHeight + rowGap + rowLabelOffset;
      startIndex += maxGroupsPerRow;
    }

    if (!isContainerView) {
      const sectionLabelWidth = LABEL_WIDTH + 60;
      labelNodes.push({
        id: "standalone-label",
        type: "tierLabel",
        position: {
          x: -sectionLabelWidth / 2,
          y: baseY - STANDALONE_SECTION_OFFSET,
        },
        data: { text: "Standalone Services", offset: true },
        draggable: false,
        selectable: false,
        style: { width: sectionLabelWidth, height: TIER_LABEL_HEIGHT },
      });
    }
  }

  const nodePositions: Array<FlowNode<FlowServiceNodeData>> = layoutNodes.map(
    (node) => {
      return {
        id: node.id,
        type: "service",
        position: positions.get(node.id) || { x: 0, y: 0 },
        data: {
          node,
          onNodeClick,
          onNodeContextMenu,
          animate: animateNodeIds.has(node.id),
          animationIndex: Math.max(
            0,
            stableConnectedLayout.findIndex((ln) => ln.node.id === node.id),
          ),
          onMeasure,
          debugHighlightNodeIds,
        },
        className: undefined,
        draggable: false,
        selectable: false,
        style: { width: NODE_WIDTH },
      };
    },
  );

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
    const serviceNode = node.data.node;
    const measured = resolveNodeHeight(serviceNode);
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

  const boundsPad = 200;
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
