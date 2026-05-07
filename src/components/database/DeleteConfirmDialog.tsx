import type { TableDataResult } from "../../types/electron";

interface DeleteConfirmDialogProps {
  selectedTable: string | null;
  tableData: TableDataResult | null;
  deletingRow: number | null;
  rowIndex: number;
  row: Record<string, unknown>;
  onCancel: () => void;
  onConfirm: () => void;
  formatCellValue: (value: unknown) => string;
}

export function DeleteConfirmDialog({
  selectedTable,
  tableData,
  deletingRow,
  rowIndex,
  row,
  onCancel,
  onConfirm,
  formatCellValue,
}: DeleteConfirmDialogProps) {
  return (
    <div className="db-modal-overlay" onClick={onCancel}>
      <div className="db-delete-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="db-delete-confirm-header">
          <span className="db-delete-warning-icon" aria-hidden="true">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="9" />
              <line x1="12" y1="8" x2="12" y2="13" />
              <line x1="12" y1="16.5" x2="12.01" y2="16.5" />
            </svg>
          </span>
          <h3>Delete Row</h3>
        </div>
        <p className="db-delete-confirm-message">
          Are you sure you want to delete this row from <strong>{selectedTable}</strong>? This
          action cannot be undone.
        </p>
        <div className="db-delete-confirm-preview">
          {tableData &&
            tableData.columns.slice(0, 3).map((col) => (
              <div key={col} className="db-delete-preview-field">
                <span className="db-delete-preview-label">{col}:</span>
                <span className="db-delete-preview-value">{formatCellValue(row[col])}</span>
              </div>
            ))}
          {tableData && tableData.columns.length > 3 && (
            <div className="db-delete-preview-more">
              ... and {tableData.columns.length - 3} more{" "}
              {tableData.columns.length - 3 === 1 ? "column" : "columns"}
            </div>
          )}
        </div>
        <div className="db-delete-confirm-actions">
          <button
            className="db-delete-cancel-btn"
            onClick={onCancel}
            disabled={deletingRow !== null}
          >
            Cancel
          </button>
          <button
            className="db-delete-confirm-btn"
            onClick={onConfirm}
            disabled={deletingRow !== null}
          >
            {deletingRow !== null ? (
              <>
                <div className="db-loading-spinner tiny" />
                Deleting...
              </>
            ) : (
              <>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete Row
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
