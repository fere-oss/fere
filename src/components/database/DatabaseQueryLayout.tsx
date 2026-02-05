import type { QueryResult } from '../../types/electron';

interface DatabaseQueryLayoutProps {
  dbType: string;
  query: string;
  queryResult: QueryResult | null;
  executingQuery: boolean;
  onChangeQuery: (value: string) => void;
  onExecuteQuery: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  getQueryPlaceholder: () => string;
  formatCellValue: (value: unknown) => string;
}

export function DatabaseQueryLayout({
  dbType,
  query,
  queryResult,
  executingQuery,
  onChangeQuery,
  onExecuteQuery,
  onKeyDown,
  getQueryPlaceholder,
  formatCellValue,
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
        <div className="db-query-editor-container">
          <pre className="db-query-highlight">
            {highlightQuery(query, dbType)}
          </pre>
          <textarea
            className="db-query-textarea"
            value={query}
            onChange={(e) => onChangeQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={getQueryPlaceholder()}
            spellCheck={false}
          />
        </div>
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
            <pre className="db-query-output">
              {highlightQueryOutput(queryResult.output)}
            </pre>
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

const SQL_KEYWORDS = new Set([
  'select', 'from', 'where', 'and', 'or', 'not', 'null', 'is', 'in', 'like',
  'insert', 'into', 'values', 'update', 'set', 'delete',
  'create', 'table', 'drop', 'alter', 'add', 'column', 'primary', 'key', 'foreign',
  'references', 'constraint', 'index', 'unique', 'default', 'check',
  'join', 'left', 'right', 'inner', 'outer', 'full', 'on',
  'group', 'by', 'order', 'having', 'limit', 'offset', 'distinct',
  'returning', 'cascade', 'if', 'exists', 'database', 'schema', 'view', 'truncate',
]);

function highlightQuery(query: string, dbType: string): React.ReactNode {
  if (!query) return null;

  const tokenRegex = /(--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w$]*\b|[()*,.;=<>!+\-\/]+|\s+|.)/g;
  const tokens = query.match(tokenRegex) || [];

  return tokens.map((token, index) => {
    if (/^\s+$/.test(token)) return token;
    if (token.startsWith('--') || token.startsWith('/*')) {
      return <span key={index} className="db-hl-comment">{token}</span>;
    }
    if ((token.startsWith("'") && token.endsWith("'")) ||
        (token.startsWith('"') && token.endsWith('"')) ||
        (token.startsWith('`') && token.endsWith('`'))) {
      return <span key={index} className="db-hl-string">{token}</span>;
    }
    if (/^\d/.test(token)) {
      return <span key={index} className="db-hl-number">{token}</span>;
    }
    if (/^[A-Za-z_]/.test(token)) {
      const isKeyword = dbType !== 'mongodb' && SQL_KEYWORDS.has(token.toLowerCase());
      return (
        <span key={index} className={isKeyword ? 'db-hl-keyword' : 'db-hl-identifier'}>
          {token}
        </span>
      );
    }
    return <span key={index} className="db-hl-operator">{token}</span>;
  });
}

function highlightQueryOutput(output: string): React.ReactNode {
  const tokenRegex = /(\(\d+\s+rows?\)|\b\d+\b|[|+]+|[-=]{2,})/g;
  const parts = output.split(tokenRegex);
  return parts.map((part, index) => {
    if (!part) return null;
    if (/^\(\d+\s+rows?\)$/.test(part)) {
      return <span key={index} className="db-out-meta">{part}</span>;
    }
    if (/^\d+$/.test(part)) {
      return <span key={index} className="db-out-number">{part}</span>;
    }
    if (/^[|+]+$/.test(part) || /^[-=]{2,}$/.test(part)) {
      return <span key={index} className="db-out-pipe">{part}</span>;
    }
    return part;
  });
}
