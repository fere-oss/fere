import type { QueryResult } from '../../types/electron';

interface DatabaseQueryLayoutProps {
  query: string;
  queryResult: QueryResult | null;
  executingQuery: boolean;
  onChangeQuery: (value: string) => void;
  onExecuteQuery: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  getQueryPlaceholder: () => string;
  formatCellValue: (value: unknown) => string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}

export function DatabaseQueryLayout({
  query,
  queryResult,
  executingQuery,
  onChangeQuery,
  onExecuteQuery,
  onKeyDown,
  getQueryPlaceholder,
  formatCellValue,
  textareaRef,
}: DatabaseQueryLayoutProps) {
  return (
    <div className="db-query-layout">
      <div className="db-query-editor-section">
        <div className="db-query-editor-header">
          <span className="db-query-editor-title">Query</span>
          <div className="db-query-actions">
            <span className="db-query-shortcut">
              <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</kbd>
              <kbd>Enter</kbd>
              <span>to run</span>
            </span>
            <button
              className="db-execute-btn"
              onClick={onExecuteQuery}
              disabled={executingQuery || !query.trim()}
            >
              {executingQuery ? (
                <>
                  <div className="db-loading-spinner tiny" />
                  Running...
                </>
              ) : (
                <>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5,3 19,12 5,21" />
                  </svg>
                  Run Query
                </>
              )}
            </button>
          </div>
        </div>
        <textarea
          ref={textareaRef}
          className="db-query-textarea"
          value={query}
          onChange={(e) => onChangeQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={getQueryPlaceholder()}
          spellCheck={false}
        />
      </div>

      <div className="db-query-results-section">
        <div className="db-query-results-header">
          <span className="db-query-results-title">Results</span>
          {queryResult && queryResult.rowCount !== undefined && (
            <span className="db-query-results-count">
              {queryResult.rowCount} {queryResult.rowCount === 1 ? 'row' : 'rows'} returned
            </span>
          )}
        </div>
        <div className="db-query-results-content">
          {queryResult?.error ? (
            <div className="db-query-error">
              <div className="db-query-error-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="15" y1="9" x2="9" y2="15" />
                  <line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                <span>Error</span>
              </div>
              <pre className="db-query-error-message">{queryResult.error}</pre>
            </div>
          ) : queryResult?.rows && queryResult.rows.length > 0 ? (
            <div className="db-table-scroll">
              <table className="db-data-table">
                <thead>
                  <tr>
                    <th className="db-row-num">#</th>
                    {queryResult.columns?.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {queryResult.rows.map((row, idx) => (
                    <tr key={idx}>
                      <td className="db-row-num">{idx + 1}</td>
                      {queryResult.columns?.map((col) => (
                        <td key={col} title={formatCellValue(row[col])}>
                          <span className={`db-cell-value ${row[col] === null || row[col] === undefined ? 'null' : ''}`}>
                            {formatCellValue(row[col])}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : queryResult?.output ? (
            <pre className="db-query-output">{queryResult.output}</pre>
          ) : (
            <div className="db-query-empty">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                <polyline points="16,18 22,12 16,6" />
                <polyline points="8,6 2,12 8,18" />
              </svg>
              <span>Run a query to see results</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
