import { useState, useCallback } from "react";
import { SERVICE_COLORS } from "../graph/constants";
import type { ChecklistItem, ChecklistItemMatch } from "./types";

interface ChecklistItemEditorProps {
  item?: ChecklistItem;
  onSave: (
    data: Omit<ChecklistItem, "id">,
  ) => void;
  onClose: () => void;
}

const TYPE_OPTIONS = Object.entries(SERVICE_COLORS)
  .filter(([key]) => key !== "external")
  .map(([key, val]) => ({ value: key, label: val.label }));

export function ChecklistItemEditor({
  item,
  onSave,
  onClose,
}: ChecklistItemEditorProps) {
  const [label, setLabel] = useState(item?.label ?? "");
  const [required, setRequired] = useState(item?.required ?? true);
  const [matchType, setMatchType] = useState<string>(item?.match.type ?? "");
  const [port, setPort] = useState(item?.match.port?.toString() ?? "");
  const [nameRegex, setNameRegex] = useState(item?.match.nameRegex ?? "");
  const [containerOnly, setContainerOnly] = useState(
    item?.match.containerOnly ?? false,
  );
  const [regexError, setRegexError] = useState<string | null>(null);

  const handleRegexChange = useCallback((value: string) => {
    setNameRegex(value);
    if (value === "") {
      setRegexError(null);
      return;
    }
    try {
      new RegExp(value, "i");
      setRegexError(null);
    } catch (e) {
      setRegexError("Invalid regex");
    }
  }, []);

  const handleSubmit = useCallback(() => {
    if (!label.trim()) return;
    if (regexError) return;

    const match: ChecklistItemMatch = {};
    if (matchType) match.type = matchType as ChecklistItemMatch["type"];
    if (port) {
      const p = parseInt(port, 10);
      if (!isNaN(p) && p > 0) match.port = p;
    }
    if (nameRegex) match.nameRegex = nameRegex;
    if (containerOnly) match.containerOnly = true;

    onSave({ label: label.trim(), required, match });
  }, [label, required, matchType, port, nameRegex, containerOnly, regexError, onSave]);

  const canSave = label.trim().length > 0 && !regexError;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-content"
        style={{ maxWidth: 480 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>{item ? "Edit Service" : "Add Required Service"}</h2>
          <button className="modal-close-btn" onClick={onClose}>
            <svg
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path d="M4 4L12 12M12 4L4 12" />
            </svg>
          </button>
        </div>

        <div className="modal-body">
          <div className="checklist-editor-field">
            <label className="checklist-editor-label">Label</label>
            <input
              className="checklist-editor-input"
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Postgres"
              autoFocus
            />
          </div>

          <div className="checklist-editor-field">
            <label className="checklist-editor-label">Service Type</label>
            <select
              className="checklist-editor-select"
              value={matchType}
              onChange={(e) => setMatchType(e.target.value)}
            >
              <option value="">Any</option>
              {TYPE_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="checklist-editor-field">
            <label className="checklist-editor-label">Port</label>
            <input
              className="checklist-editor-input"
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="e.g. 5432"
              min={1}
              max={65535}
            />
          </div>

          <div className="checklist-editor-field">
            <label className="checklist-editor-label">Name Pattern (regex)</label>
            <input
              className={`checklist-editor-input${regexError ? " checklist-editor-input-error" : ""}`}
              type="text"
              value={nameRegex}
              onChange={(e) => handleRegexChange(e.target.value)}
              placeholder="e.g. postgres|pg"
            />
            {regexError && (
              <span className="checklist-editor-error">{regexError}</span>
            )}
          </div>

          <div className="checklist-editor-row">
            <label className="checklist-editor-checkbox">
              <input
                type="checkbox"
                checked={required}
                onChange={(e) => setRequired(e.target.checked)}
              />
              Required
            </label>
            <label className="checklist-editor-checkbox">
              <input
                type="checkbox"
                checked={containerOnly}
                onChange={(e) => setContainerOnly(e.target.checked)}
              />
              Container only
            </label>
          </div>
        </div>

        <div className="modal-actions">
          <button className="modal-btn modal-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleSubmit}
            disabled={!canSave}
          >
            {item ? "Save" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
