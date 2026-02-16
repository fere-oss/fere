import type { GraphNode } from "../../types/electron";

export interface ChecklistItemMatch {
  type?: GraphNode["type"];
  port?: number;
  nameRegex?: string;
  containerOnly?: boolean;
}

export interface ChecklistItem {
  id: string;
  label: string;
  required: boolean;
  match: ChecklistItemMatch;
}

export type ChecklistItemStatus = "healthy" | "present_unhealthy" | "missing";

export interface EvaluatedChecklistItem {
  item: ChecklistItem;
  status: ChecklistItemStatus;
  matchedNode: GraphNode | null;
}

export type OverallStatus = "green" | "yellow" | "red";
