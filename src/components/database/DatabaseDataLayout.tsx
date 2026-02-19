import type { TableDataResult } from '../../types/electron';

interface DatabaseDataLayoutProps {
  dbType: string;
  tables: string[];
  selectedTable: string | null;
  tableData: TableDataResult | null;
  loadingTable: boolean;
  deletingRow: number | null;
  deletingTable: boolean;
  onSelectTable: (table: string) => void;
  onRefreshTable: () => void;
  onCreateTable: () => void;
  onDeleteTable: () => void;
  onDeleteRowRequest: (rowIndex: number, row: Record<string, unknown>) => void;
  formatCellValue: (value: unknown) => string;
}

export function DatabaseDataLayout({
  dbType,
  tables,
  selectedTable,
  tableData,
  loadingTable,
  deletingRow,
  deletingTable,
  onSelectTable,
  onRefreshTable,
  onCreateTable,
  onDeleteTable,
  onDeleteRowRequest,
  formatCellValue,
}: DatabaseDataLayoutProps) {
  return (
    <div className="db-data-layout">
      <aside className="db-sidebar">
        <div className="db-sidebar-header">
          <div className="db-sidebar-header-left">
            <span className="db-sidebar-title">
              {dbType === 'mongodb' ? 'Collections' : 'Tables'}
            </span>
            <span className="db-sidebar-count">{tables.length}</span>
          </div>
          <div className="db-sidebar-actions">
            <button
              className="db-create-table-btn"
              onClick={onCreateTable}
              title={`Create new ${dbType === 'mongodb' ? 'collection' : 'table'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              className="db-delete-table-btn"
              onClick={onDeleteTable}
              disabled={!selectedTable || deletingTable}
              title={`Delete selected ${dbType === 'mongodb' ? 'collection' : 'table'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </div>
        <div className="db-sidebar-list">
          {tables.length > 0 ? (
            tables.map((table) => (
              <button
                key={table}
                className={`db-table-item ${selectedTable === table ? 'active' : ''}`}
                onClick={() => onSelectTable(table)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="3" y1="9" x2="21" y2="9" />
                  <line x1="9" y1="21" x2="9" y2="9" />
                </svg>
                <span className="db-table-name">{table}</span>
              </button>
            ))
          ) : (
            <div className="db-sidebar-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M21 5c0-1.1-3.58-2-8-2s-8 .9-8 2m16 0v14c0 1.1-3.58 2-8 2s-8-.9-8-2V5m16 0c0 1.1-3.58 2-8 2s-8-.9-8-2" />
              </svg>
              <span>No {dbType === 'mongodb' ? 'collections' : 'tables'} found</span>
            </div>
          )}
        </div>
      </aside>

      <main className="db-data-main">
        {selectedTable ? (
          <div className="db-table-view">
            <div className="db-table-header">
              <div className="db-table-info">
                <span className="db-table-selected-name">{selectedTable}</span>
                {tableData && !tableData.error && (
                  <span className="db-row-count">
                    {tableData.rows.length >= 100
                      ? 'First 100 rows (limit applied)'
                      : `${tableData.rows.length} ${tableData.rows.length === 1 ? 'row' : 'rows'}`}
                  </span>
                )}
              </div>
              <button
                className="db-refresh-btn"
                onClick={onRefreshTable}
                disabled={loadingTable}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="23,4 23,10 17,10" />
                  <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                </svg>
                Refresh
              </button>
            </div>
            <div className="db-table-content">
              {loadingTable ? (
                <div className="db-table-loading">
                  <div className="db-loading-spinner small" />
                  <span>Loading data...</span>
                </div>
              ) : tableData?.error ? (
                <div className="db-table-error">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <line x1="15" y1="9" x2="9" y2="15" />
                    <line x1="9" y1="9" x2="15" y2="15" />
                  </svg>
                  <span>{tableData.error}</span>
                </div>
              ) : tableData && tableData.rows.length > 0 ? (
                <div className="db-table-scroll">
                  <table className="db-data-table">
                    <thead>
                      <tr>
                        <th className="db-row-num">#</th>
                        {tableData.columns.map((col, colIdx) => (
                          <th key={`${colIdx}-${col}`}>{col}</th>
                        ))}
                        {dbType === 'postgresql' && <th className="db-actions-col">Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {tableData.rows.map((row, idx) => (
                        <tr key={`row-${idx}-${formatCellValue(row[tableData.columns[0]])}`}>
                          <td className="db-row-num">{idx + 1}</td>
                          {tableData.columns.map((col, colIdx) => (
                            <td key={`${colIdx}-${col}`} title={formatCellValue(row[col])}>
                              <span className={`db-cell-value ${row[col] === null || row[col] === undefined ? 'null' : ''}`}>
                                {formatCellValue(row[col])}
                              </span>
                            </td>
                          ))}
                          {dbType === 'postgresql' && (
                            <td className="db-actions-col">
                              <button
                                className="db-delete-row-btn"
                                onClick={() => onDeleteRowRequest(idx, row)}
                                disabled={deletingRow === idx}
                                title="Delete row"
                              >
                                {deletingRow === idx ? (
                                  <div className="db-loading-spinner tiny" />
                                ) : (
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <polyline points="3 6 5 6 21 6" />
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                    <line x1="10" y1="11" x2="10" y2="17" />
                                    <line x1="14" y1="11" x2="14" y2="17" />
                                  </svg>
                                )}
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="db-table-empty">
                  <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                    <line x1="3" y1="9" x2="21" y2="9" />
                    <line x1="9" y1="21" x2="9" y2="9" />
                  </svg>
                  <span>No data in this {dbType === 'mongodb' ? 'collection' : 'table'}</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="db-no-selection">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="3" y1="9" x2="21" y2="9" />
              <line x1="9" y1="21" x2="9" y2="9" />
            </svg>
            <span className="db-no-selection-title">Select a {dbType === 'mongodb' ? 'collection' : 'table'}</span>
            <span className="db-no-selection-subtitle">Choose from the sidebar to view data</span>
          </div>
        )}
      </main>
    </div>
  );
}
