import { useEffect, useMemo, useRef, useState } from 'react';
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
  const tabCounterRef = useRef(2);
  const [queryTabs, setQueryTabs] = useState([{ id: 'query-tab-1', title: 'Query 1', content: query }]);
  const [activeTabId, setActiveTabId] = useState('query-tab-1');

  const activeTab = useMemo(
    () => queryTabs.find((tab) => tab.id === activeTabId) ?? queryTabs[0],
    [queryTabs, activeTabId],
  );

  useEffect(() => {
    setQueryTabs((prev) =>
      prev.map((tab) => (tab.id === activeTab.id ? { ...tab, content: query } : tab)),
    );
  }, [query, activeTab.id]);

  const handleChangeQuery = (value: string) => {
    setQueryTabs((prev) =>
      prev.map((tab) => (tab.id === activeTab.id ? { ...tab, content: value } : tab)),
    );
    onChangeQuery(value);
  };

  const handleAddTab = () => {
    const nextId = `query-tab-${tabCounterRef.current++}`;
    const nextTitle = `Query ${queryTabs.length + 1}`;
    const nextTabs = [...queryTabs, { id: nextId, title: nextTitle, content: '' }];
    setQueryTabs(nextTabs);
    setActiveTabId(nextId);
    onChangeQuery('');
  };

  const handleSwitchTab = (tabId: string) => {
    const nextTab = queryTabs.find((tab) => tab.id === tabId);
    if (!nextTab) return;
    setActiveTabId(tabId);
    onChangeQuery(nextTab.content);
  };

  const handleCloseTab = (tabId: string) => {
    if (queryTabs.length === 1) return;
    const closingIdx = queryTabs.findIndex((tab) => tab.id === tabId);
    if (closingIdx === -1) return;
    const nextTabs = queryTabs.filter((tab) => tab.id !== tabId);
    setQueryTabs(nextTabs);

    if (activeTabId !== tabId) return;
    const fallbackIdx = Math.max(0, closingIdx - 1);
    const fallbackTab = nextTabs[fallbackIdx];
    if (fallbackTab) {
      setActiveTabId(fallbackTab.id);
      onChangeQuery(fallbackTab.content);
    }
  };

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
        <div className="db-query-tabs" role="tablist" aria-label="Query tabs">
          {queryTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTab.id}
              className={`db-query-tab ${tab.id === activeTab.id ? 'active' : ''}`}
              onClick={() => handleSwitchTab(tab.id)}
            >
              <span className="db-query-tab-title">{tab.title}</span>
              {queryTabs.length > 1 && (
                <span
                  className="db-query-tab-close"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
                  }}
                >
                  ×
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            className="db-query-tab-add"
            onClick={handleAddTab}
            title="New query tab"
          >
            +
          </button>
        </div>
        <div className="db-query-editor-container">
          <textarea
            className="db-query-textarea"
            value={activeTab.content}
            onChange={(e) => handleChangeQuery(e.target.value)}
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
