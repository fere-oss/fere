interface DeleteTableConfirmDialogProps {
  tableName: string;
  dbType: string;
  deletingTable: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteTableConfirmDialog({
  tableName,
  dbType,
  deletingTable,
  onCancel,
  onConfirm,
}: DeleteTableConfirmDialogProps) {
  const label = dbType === 'mongodb' ? 'collection' : 'table';

  return (
    <div className="db-modal-overlay" onClick={onCancel}>
      <div className="db-delete-confirm-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="db-delete-confirm-header">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <h3>Delete {label}</h3>
        </div>
        <p className="db-delete-confirm-message">
          Are you sure you want to delete the {label} <strong>{tableName}</strong>?
          This action cannot be undone.
        </p>
        <div className="db-delete-confirm-actions">
          <button
            className="db-delete-cancel-btn"
            onClick={onCancel}
            disabled={deletingTable}
          >
            Cancel
          </button>
          <button
            className="db-delete-confirm-btn"
            onClick={onConfirm}
            disabled={deletingTable}
          >
            {deletingTable ? (
              <>
                <div className="db-loading-spinner tiny" />
                Deleting...
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                Delete {label}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
