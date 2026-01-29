import { useState, useEffect, useCallback, useRef } from 'react';
import type { GraphNode, DatabaseTablesResult, TableDataResult, QueryResult, ColumnDefinition } from '../types/electron';
import { CreateTableModal } from './CreateTableModal';

interface DatabasePageProps {
  node: GraphNode;
  onBack: () => void;
}

export function DatabasePage({ node, onBack }: DatabasePageProps) {
  const [tables, setTables] = useState<string[]>([]);
  const [dbType, setDbType] = useState<string>('database');
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableDataResult | null>(null);
  const [query, setQuery] = useState('');
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTable, setLoadingTable] = useState(false);
  const [executingQuery, setExecutingQuery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'data' | 'query'>('data');
  const [showCreateModal, setShowCreateModal] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const containerId = node.containerId || '';
  const containerImage = node.containerImage || '';

  // Load tables on mount
  useEffect(() => {
    const loadTables = async () => {
      if (!window.electronAPI?.getDatabaseTables || !containerId || !containerImage) {
        setError('Database queries not available');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const result: DatabaseTablesResult = await window.electronAPI.getDatabaseTables(containerId, containerImage);

        if (result.error) {
          setError(result.error);
        } else {
          setTables(result.tables);
          setDbType(result.dbType || 'database');
          if (result.dbType === 'mongodb') {
            setQuery('db.getCollectionNames()');
          } else if (result.dbType === 'postgresql') {
            setQuery('SELECT * FROM ');
          } else if (result.dbType === 'mysql') {
            setQuery('SELECT * FROM ');
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load tables');
      } finally {
        setLoading(false);
      }
    };

    loadTables();
  }, [containerId, containerImage]);

  const loadTableData = useCallback(async (tableName: string) => {
    if (!window.electronAPI?.getTableData) return;

    try {
      setLoadingTable(true);
      setSelectedTable(tableName);
      setTableData(null);

      const result = await window.electronAPI.getTableData(containerId, containerImage, tableName, 100);
      setTableData(result);
    } catch (err) {
      setTableData({
        columns: [],
        rows: [],
        error: err instanceof Error ? err.message : 'Failed to load data',
      });
    } finally {
      setLoadingTable(false);
    }
  }, [containerId, containerImage]);

  const executeQuery = useCallback(async () => {
    if (!window.electronAPI?.executeDatabaseQuery || !query.trim()) return;

    try {
      setExecutingQuery(true);
      setQueryResult(null);

      const result = await window.electronAPI.executeDatabaseQuery(containerId, containerImage, query);
      setQueryResult(result);
    } catch (err) {
      setQueryResult({
        error: err instanceof Error ? err.message : 'Query execution failed',
      });
    } finally {
      setExecutingQuery(false);
    }
  }, [containerId, containerImage, query]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      executeQuery();
    }
  }, [executeQuery]);

  const refreshTables = useCallback(async () => {
    if (!window.electronAPI?.getDatabaseTables || !containerId || !containerImage) {
      return;
    }

    try {
      const result: DatabaseTablesResult = await window.electronAPI.getDatabaseTables(containerId, containerImage);
      if (!result.error) {
        setTables(result.tables);
        setDbType(result.dbType || 'database');
      }
    } catch (err) {
      console.error('Error refreshing tables:', err);
    }
  }, [containerId, containerImage]);

  const handleCreateTable = useCallback(async (tableName: string, columns: ColumnDefinition[]) => {
    if (!window.electronAPI?.createDatabaseTable) {
      console.error('electronAPI:', window.electronAPI);
      console.error('Available methods:', Object.keys(window.electronAPI || {}));
      throw new Error('Create table API not available. Please restart the Electron app.');
    }

    const result = await window.electronAPI.createDatabaseTable(containerId, containerImage, tableName, columns);

    if (result.error) {
      throw new Error(result.error);
    }

    // Refresh the tables list
    await refreshTables();
  }, [containerId, containerImage, refreshTables]);

  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getDbTypeLabel = () => {
    switch (dbType) {
      case 'postgresql': return 'PostgreSQL';
      case 'mysql': return 'MySQL';
      case 'mongodb': return 'MongoDB';
      default: return 'Database';
    }
  };

  const getQueryPlaceholder = () => {
    switch (dbType) {
      case 'postgresql':
        return `-- PostgreSQL Query Editor
-- Press Cmd/Ctrl + Enter to execute

SELECT * FROM users LIMIT 10;

-- More examples:
-- INSERT INTO users (name, email) VALUES ('John', 'john@example.com');
-- CREATE TABLE products (id SERIAL PRIMARY KEY, name VARCHAR(100));`;
      case 'mysql':
        return `-- MySQL Query Editor
-- Press Cmd/Ctrl + Enter to execute

SELECT * FROM users LIMIT 10;

-- More examples:
-- INSERT INTO users (name, email) VALUES ('John', 'john@example.com');
-- CREATE TABLE products (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100));`;
      case 'mongodb':
        return `// MongoDB Shell
// Press Cmd/Ctrl + Enter to execute

db.users.find().limit(10)

// More examples:
// db.users.insertOne({name: "John", email: "john@example.com"})
// db.createCollection("products")`;
      default:
        return 'Enter your query here...';
    }
  };

  if (loading) {
    return (
      <div className="db-page">
        <div className="db-page-loading">
          <div className="db-loading-spinner" />
          <div className="db-loading-text">
            <span className="db-loading-title">Connecting to database</span>
            <span className="db-loading-subtitle">{node.name}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="db-page">
      {/* Header */}
      <header className="db-header">
        <div className="db-header-left">
          <button className="db-back-btn" onClick={onBack}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M15 18l-6-6 6-6" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          <div className="db-header-info">
            <div className="db-header-title">
              <span className="db-name">{node.name}</span>
              <span className={`db-status db-status-${node.containerState}`}>
                {node.containerState}
              </span>
            </div>
            <span className="db-type-badge">{getDbTypeLabel()}</span>
          </div>
        </div>
        <div className="db-header-tabs">
          <button
            className={`db-header-tab ${activeTab === 'data' ? 'active' : ''}`}
            onClick={() => setActiveTab('data')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
              <line x1="3" y1="9" x2="21" y2="9"/>
              <line x1="9" y1="21" x2="9" y2="9"/>
            </svg>
            Browse Data
          </button>
          <button
            className={`db-header-tab ${activeTab === 'query' ? 'active' : ''}`}
            onClick={() => setActiveTab('query')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="16,18 22,12 16,6"/>
              <polyline points="8,6 2,12 8,18"/>
            </svg>
            Query Editor
          </button>
        </div>
      </header>

      {error ? (
        <div className="db-error-state">
          <div className="db-error-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
          </div>
          <span className="db-error-title">Connection Error</span>
          <span className="db-error-message">{error}</span>
          <button className="db-error-retry" onClick={() => window.location.reload()}>
            Try Again
          </button>
        </div>
      ) : (
        <div className="db-content">
          {activeTab === 'data' ? (
            <div className="db-data-layout">
              {/* Sidebar with tables */}
              <aside className="db-sidebar">
                <div className="db-sidebar-header">
                  <div className="db-sidebar-header-left">
                    <span className="db-sidebar-title">
                      {dbType === 'mongodb' ? 'Collections' : 'Tables'}
                    </span>
                    <span className="db-sidebar-count">{tables.length}</span>
                  </div>
                  <button
                    className="db-create-table-btn"
                    onClick={() => setShowCreateModal(true)}
                    title={`Create new ${dbType === 'mongodb' ? 'collection' : 'table'}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                  </button>
                </div>
                <div className="db-sidebar-list">
                  {tables.length > 0 ? (
                    tables.map((table) => (
                      <button
                        key={table}
                        className={`db-table-item ${selectedTable === table ? 'active' : ''}`}
                        onClick={() => loadTableData(table)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                          <line x1="3" y1="9" x2="21" y2="9"/>
                          <line x1="9" y1="21" x2="9" y2="9"/>
                        </svg>
                        <span className="db-table-name">{table}</span>
                      </button>
                    ))
                  ) : (
                    <div className="db-sidebar-empty">
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                        <path d="M21 5c0-1.1-3.58-2-8-2s-8 .9-8 2m16 0v14c0 1.1-3.58 2-8 2s-8-.9-8-2V5m16 0c0 1.1-3.58 2-8 2s-8-.9-8-2"/>
                      </svg>
                      <span>No {dbType === 'mongodb' ? 'collections' : 'tables'} found</span>
                    </div>
                  )}
                </div>
              </aside>

              {/* Main data area */}
              <main className="db-data-main">
                {selectedTable ? (
                  <div className="db-table-view">
                    <div className="db-table-header">
                      <div className="db-table-info">
                        <span className="db-table-selected-name">{selectedTable}</span>
                        {tableData && !tableData.error && (
                          <span className="db-row-count">
                            {tableData.rows.length} {tableData.rows.length === 1 ? 'row' : 'rows'}
                          </span>
                        )}
                      </div>
                      <button
                        className="db-refresh-btn"
                        onClick={() => loadTableData(selectedTable)}
                        disabled={loadingTable}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <polyline points="23,4 23,10 17,10"/>
                          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
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
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="15" y1="9" x2="9" y2="15"/>
                            <line x1="9" y1="9" x2="15" y2="15"/>
                          </svg>
                          <span>{tableData.error}</span>
                        </div>
                      ) : tableData && tableData.rows.length > 0 ? (
                        <div className="db-table-scroll">
                          <table className="db-data-table">
                            <thead>
                              <tr>
                                <th className="db-row-num">#</th>
                                {tableData.columns.map((col) => (
                                  <th key={col}>{col}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {tableData.rows.map((row, idx) => (
                                <tr key={idx}>
                                  <td className="db-row-num">{idx + 1}</td>
                                  {tableData.columns.map((col) => (
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
                      ) : (
                        <div className="db-table-empty">
                          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                            <line x1="3" y1="9" x2="21" y2="9"/>
                            <line x1="9" y1="21" x2="9" y2="9"/>
                          </svg>
                          <span>No data in this {dbType === 'mongodb' ? 'collection' : 'table'}</span>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <div className="db-no-selection">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1">
                      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
                      <line x1="3" y1="9" x2="21" y2="9"/>
                      <line x1="9" y1="21" x2="9" y2="9"/>
                    </svg>
                    <span className="db-no-selection-title">Select a {dbType === 'mongodb' ? 'collection' : 'table'}</span>
                    <span className="db-no-selection-subtitle">Choose from the sidebar to view data</span>
                  </div>
                )}
              </main>
            </div>
          ) : (
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
                      onClick={executeQuery}
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
                            <polygon points="5,3 19,12 5,21"/>
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
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={handleKeyDown}
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
                          <circle cx="12" cy="12" r="10"/>
                          <line x1="15" y1="9" x2="9" y2="15"/>
                          <line x1="9" y1="9" x2="15" y2="15"/>
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
                        <polyline points="16,18 22,12 16,6"/>
                        <polyline points="8,6 2,12 8,18"/>
                      </svg>
                      <span>Run a query to see results</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Create Table Modal */}
      {showCreateModal && (
        <CreateTableModal
          dbType={dbType as 'postgresql' | 'mysql' | 'mongodb'}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateTable}
        />
      )}
    </div>
  );
}
