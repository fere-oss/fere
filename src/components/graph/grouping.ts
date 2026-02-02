import type { GraphNode } from '../../types/electron';
import type { LayoutNode, RenderGroup, ContainerProject } from './types';
import { SERVICE_COLORS } from './constants';

// Container type grouping categories with display order
const CONTAINER_TYPE_ORDER: Record<string, number> = {
  frontend: 0,
  webserver: 1,
  backend: 2,
  nodejs: 3,
  python: 4,
  broker: 5,
  realtime: 6,
  worker: 7,
  cache: 8,
  database: 9,
  search: 10,
  service: 11,
};

// Group containers by their type (database, cache, backend, etc.)
const groupContainersByType = (nodes: GraphNode[]): RenderGroup[] => {
  const typeGroups = new Map<string, GraphNode[]>();

  nodes.forEach(node => {
    const type = node.type || 'service';
    if (!typeGroups.has(type)) {
      typeGroups.set(type, []);
    }
    typeGroups.get(type)!.push(node);
  });

  // Sort groups by the predefined order
  const sortedTypes = Array.from(typeGroups.keys()).sort((a, b) => {
    const orderA = CONTAINER_TYPE_ORDER[a] ?? 99;
    const orderB = CONTAINER_TYPE_ORDER[b] ?? 99;
    return orderA - orderB;
  });

  return sortedTypes.map(type => ({
    groupName: SERVICE_COLORS[type]?.label || type.charAt(0).toUpperCase() + type.slice(1),
    nodes: typeGroups.get(type)!.sort((a, b) => a.name.localeCompare(b.name)),
    isGroup: true,
    groupType: type,
  }));
};

// Extract project name from container name (Docker Compose naming: project_service_1)
const extractProjectName = (containerName: string): string => {
  const parts = containerName.split(/[-_]/);
  if (parts.length >= 2) {
    return parts[0];
  }
  return 'docker';
};

// Group all containers by type (simpler grouping - no project separation)
export const groupContainersByProject = (nodes: GraphNode[]): ContainerProject[] => {
  // Group all containers by type, return as a single "project"
  const typeGroups = groupContainersByType(nodes);

  return [{
    projectName: 'Containers',
    typeGroups,
    totalContainers: nodes.length,
  }];
};

export const groupLayoutNodes = (layoutNodes: LayoutNode[], layer: number): RenderGroup[] => {
  const layerNodes = layoutNodes
    .filter(ln => ln.layer === layer)
    .sort((a, b) => a.order - b.order);

  const groupMap = new Map<string, RenderGroup>();
  const groupOrder: string[] = [];

  layerNodes.forEach(ln => {
    const groupId = ln.groupId.toLowerCase();
    if (!groupMap.has(groupId)) {
      groupOrder.push(groupId);
      groupMap.set(groupId, {
        groupName: ln.groupId.charAt(0).toUpperCase() + ln.groupId.slice(1),
        nodes: [],
        isGroup: false,
      });
    }
    groupMap.get(groupId)!.nodes.push(ln.node);
  });

  return groupOrder.map(groupId => {
    const group = groupMap.get(groupId)!;
    if (group.nodes.length > 1) group.isGroup = true;
    return group;
  });
};
