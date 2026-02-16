import type { GraphNode } from "../../types/electron";
import type {
  ChecklistItem,
  ChecklistItemMatch,
  ChecklistItemStatus,
  EvaluatedChecklistItem,
  OverallStatus,
} from "./types";

/**
 * Tests whether a single GraphNode matches all provided match criteria.
 * All provided fields must pass (AND logic).
 */
export function nodeMatchesItem(
  node: GraphNode,
  match: ChecklistItemMatch,
): boolean {
  if (match.type !== undefined && node.type !== match.type) return false;

  if (match.port !== undefined) {
    if (!node.ports.some((p) => p.port === match.port)) return false;
  }

  if (match.nameRegex !== undefined && match.nameRegex !== "") {
    try {
      const regex = new RegExp(match.nameRegex, "i");
      if (!regex.test(node.name) && !regex.test(node.command)) return false;
    } catch {
      return false;
    }
  }

  if (match.containerOnly === true && !node.isDockerContainer) return false;

  return true;
}

/**
 * Evaluates a single checklist item against all nodes.
 * Returns the status and the best-matching node (if any).
 */
export function evaluateItem(
  item: ChecklistItem,
  nodes: GraphNode[],
): EvaluatedChecklistItem {
  const matchingNodes = nodes.filter((n) => nodeMatchesItem(n, item.match));

  if (matchingNodes.length === 0) {
    return { item, status: "missing" as ChecklistItemStatus, matchedNode: null };
  }

  const healthyNode = matchingNodes.find((n) => {
    const isHealthy = n.healthStatus !== "red";
    const isRunning = !n.isDockerContainer || n.containerState === "running";
    return isHealthy && isRunning;
  });

  if (healthyNode) {
    return { item, status: "healthy" as ChecklistItemStatus, matchedNode: healthyNode };
  }

  return {
    item,
    status: "present_unhealthy" as ChecklistItemStatus,
    matchedNode: matchingNodes[0],
  };
}

/**
 * Evaluates all checklist items against the current node set.
 */
export function evaluateChecklist(
  items: ChecklistItem[],
  nodes: GraphNode[],
): EvaluatedChecklistItem[] {
  return items.map((item) => evaluateItem(item, nodes));
}

/**
 * Derives overall status badge from evaluated items.
 * - green: all required items healthy
 * - red: any required item missing
 * - yellow: required items present but unhealthy
 */
export function getOverallStatus(
  evaluated: EvaluatedChecklistItem[],
): OverallStatus {
  const required = evaluated.filter((e) => e.item.required);
  if (required.length === 0) return "green";

  if (required.some((e) => e.status === "missing")) return "red";
  if (required.some((e) => e.status === "present_unhealthy")) return "yellow";

  return "green";
}
