import { useState, useCallback } from "react";
import { HEALTH_COLORS } from "../graph/constants";
import { ChecklistItemEditor } from "./ChecklistItemEditor";
import type {
  ChecklistItem,
  EvaluatedChecklistItem,
  OverallStatus,
} from "./types";

interface ChecklistPanelProps {
  evaluated: EvaluatedChecklistItem[];
  overallStatus: OverallStatus;
  healthyCount: number;
  totalCount: number;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onNavigate: (evaluated: EvaluatedChecklistItem) => void;
  onAddItem: (item: Omit<ChecklistItem, "id">) => void;
  onUpdateItem: (
    id: string,
    updates: Partial<Omit<ChecklistItem, "id">>,
  ) => void;
  onRemoveItem: (id: string) => void;
}

const STATUS_LABELS: Record<EvaluatedChecklistItem["status"], string> = {
  healthy: "Healthy",
  present_unhealthy: "Unhealthy",
  missing: "Missing",
};

const STATUS_COLORS: Record<EvaluatedChecklistItem["status"], string> = {
  healthy: HEALTH_COLORS.green.color,
  present_unhealthy: HEALTH_COLORS.yellow.color,
  missing: HEALTH_COLORS.red.color,
};

const STATUS_GLOWS: Record<EvaluatedChecklistItem["status"], string> = {
  healthy: HEALTH_COLORS.green.glow,
  present_unhealthy: HEALTH_COLORS.yellow.glow,
  missing: HEALTH_COLORS.red.glow,
};

export function ChecklistPanel({
  evaluated,
  overallStatus,
  healthyCount,
  totalCount,
  collapsed,
  onToggleCollapsed,
  onNavigate,
  onAddItem,
  onUpdateItem,
  onRemoveItem,
}: ChecklistPanelProps) {
  const [editingItem, setEditingItem] = useState<ChecklistItem | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleSaveNew = useCallback(
    (data: Omit<ChecklistItem, "id">) => {
      onAddItem(data);
      setIsAdding(false);
    },
    [onAddItem],
  );

  const handleSaveEdit = useCallback(
    (data: Omit<ChecklistItem, "id">) => {
      if (editingItem) {
        onUpdateItem(editingItem.id, data);
        setEditingItem(null);
      }
    },
    [editingItem, onUpdateItem],
  );

  // Empty state — no items yet
  if (totalCount === 0 && !isAdding) {
    return (
      <div className="checklist-panel">
        <div className="checklist-empty">
          <span className="checklist-empty-text">
            Define required services to track readiness
          </span>
          <button
            className="checklist-add-btn"
            onClick={() => setIsAdding(true)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M8 3V13M3 8H13" />
            </svg>
            Add Required Service
          </button>
        </div>
        {isAdding && (
          <ChecklistItemEditor
            onSave={handleSaveNew}
            onClose={() => setIsAdding(false)}
          />
        )}
      </div>
    );
  }

  const overallColor = HEALTH_COLORS[overallStatus].color;
  const overallGlow = HEALTH_COLORS[overallStatus].glow;

  return (
    <div className="checklist-panel">
      {/* Summary bar — always visible when items exist */}
      <div
        className="checklist-summary"
        onClick={onToggleCollapsed}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggleCollapsed();
        }}
      >
        <div className="checklist-summary-left">
          <span
            className="checklist-status-dot"
            style={{ backgroundColor: overallColor, boxShadow: overallGlow }}
          />
          <span className="checklist-summary-text">
            {healthyCount}/{totalCount} ready
          </span>
        </div>
        <span className="checklist-summary-label">Startup Checklist</span>
        <button
          className={`checklist-toggle-btn${collapsed ? "" : " checklist-toggle-btn-open"}`}
          tabIndex={-1}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M4 6L8 10L12 6" />
          </svg>
        </button>
      </div>

      {/* Expanded body */}
      {!collapsed && (
        <div className="checklist-body">
          {evaluated.map((ev) => (
            <div className="checklist-row" key={ev.item.id}>
              <span
                className="checklist-row-dot"
                style={{
                  backgroundColor: STATUS_COLORS[ev.status],
                  boxShadow: STATUS_GLOWS[ev.status],
                }}
              />
              <span className="checklist-row-label">{ev.item.label}</span>
              {ev.item.required && (
                <span className="checklist-row-badge">required</span>
              )}
              <span
                className="checklist-row-status"
                style={{ color: STATUS_COLORS[ev.status] }}
              >
                {STATUS_LABELS[ev.status]}
              </span>
              {ev.status !== "missing" && (
                <button
                  className="checklist-row-view"
                  onClick={() => onNavigate(ev)}
                >
                  View
                </button>
              )}
              <button
                className="checklist-row-action"
                title="Edit"
                onClick={() => setEditingItem(ev.item)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                >
                  <path d="M11.5 2.5L13.5 4.5L5 13H3V11L11.5 2.5Z" />
                </svg>
              </button>
              <button
                className="checklist-row-action"
                title="Delete"
                onClick={() => onRemoveItem(ev.item.id)}
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                >
                  <path d="M4 4L12 12M12 4L4 12" />
                </svg>
              </button>
            </div>
          ))}

          <button
            className="checklist-add-btn"
            onClick={() => setIsAdding(true)}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M8 3V13M3 8H13" />
            </svg>
            Add Service
          </button>
        </div>
      )}

      {/* Editor modals */}
      {isAdding && (
        <ChecklistItemEditor
          onSave={handleSaveNew}
          onClose={() => setIsAdding(false)}
        />
      )}
      {editingItem && (
        <ChecklistItemEditor
          item={editingItem}
          onSave={handleSaveEdit}
          onClose={() => setEditingItem(null)}
        />
      )}
    </div>
  );
}
