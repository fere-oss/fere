import { useState, useEffect, useCallback, useRef } from 'react';
import type { GraphNode, DatabaseTablesResult, TableDataResult, QueryResult } from '../types/electron';

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
  const [activeTab, setActiveTab] = useState<'tables' | 'query'>('tables');
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
          // Set default query based on database type
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

  // Load table data
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

  // Execute query
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

  // Handle keyboard shortcut for query execution
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      executeQuery();
    }
  }, [executeQuery]);

  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const getDbIcon = () => {
    switch (dbType) {
      case 'postgresql':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.128 0a10.134 10.134 0 0 0-2.755.403l-.063.02a10.922 10.922 0 0 0-1.612.539l-.122.052a10.26 10.26 0 0 0-1.308.653l-.182.11a9.88 9.88 0 0 0-1.17.863l-.232.197a10.001 10.001 0 0 0-.95.98l-.261.304a10.3 10.3 0 0 0-.763 1.063l-.285.454a10.678 10.678 0 0 0-.615 1.196l-.31.713c-.178.47-.33.952-.454 1.442l-.192.799c-.108.477-.188.962-.242 1.45l-.065.67c-.03.336-.045.675-.045 1.013 0 .34.015.678.045 1.014l.065.67c.054.488.134.973.242 1.45l.192.799c.124.49.276.972.454 1.442l.31.713c.166.408.371.808.615 1.196l.285.454c.228.369.481.723.763 1.063l.261.304c.296.346.615.672.95.98l.232.197c.372.31.762.6 1.17.863l.182.11c.42.252.855.472 1.308.653l.122.052c.527.2 1.065.368 1.612.539l.063.02a10.134 10.134 0 0 0 5.51 0l.063-.02a10.922 10.922 0 0 0 1.612-.539l.122-.052c.453-.181.888-.401 1.308-.653l.182-.11c.408-.263.798-.553 1.17-.863l.232-.197c.335-.308.654-.634.95-.98l.261-.304c.282-.34.535-.694.763-1.063l.285-.454c.244-.388.449-.788.615-1.196l.31-.713c.178-.47.33-.952.454-1.442l.192-.799c.108-.477.188-.962.242-1.45l.065-.67c.03-.336.045-.674.045-1.014 0-.338-.015-.677-.045-1.013l-.065-.67a10.676 10.676 0 0 0-.242-1.45l-.192-.799a10.678 10.678 0 0 0-.454-1.442l-.31-.713a10.3 10.3 0 0 0-.615-1.196l-.285-.454a10.26 10.26 0 0 0-.763-1.063l-.261-.304a10.001 10.001 0 0 0-.95-.98l-.232-.197a9.88 9.88 0 0 0-1.17-.863l-.182-.11a10.26 10.26 0 0 0-1.308-.653l-.122-.052a10.922 10.922 0 0 0-1.612-.539l-.063-.02A10.134 10.134 0 0 0 17.128 0zm-.002 1.708a8.418 8.418 0 0 1 2.289.334l.052.017c.45.142.887.316 1.339.447l.101.043c.377.151.738.33 1.086.543l.151.091c.347.217.67.46.983.717l.193.163c.278.256.54.528.788.814l.217.253c.234.282.444.6.633.882l.237.377c.202.34.373.672.51.993l.258.592c.148.39.274.79.377 1.197l.16.664c.09.396.156.8.201 1.205l.054.556c.025.28.037.56.037.842 0 .282-.012.563-.037.842l-.054.556a8.873 8.873 0 0 1-.201 1.205l-.16.664a8.873 8.873 0 0 1-.377 1.197l-.258.592c-.137.32-.308.653-.51.993l-.237.377a8.56 8.56 0 0 1-.633.882l-.217.253c-.248.286-.51.558-.788.814l-.193.163a8.317 8.317 0 0 1-.983.717l-.151.091c-.348.213-.709.392-1.086.543l-.101.043c-.452.131-.889.305-1.339.447l-.052.017a8.418 8.418 0 0 1-4.576 0l-.052-.017a9.07 9.07 0 0 1-1.339-.447l-.101-.043a8.56 8.56 0 0 1-1.086-.543l-.151-.091a8.317 8.317 0 0 1-.983-.717l-.193-.163a8.317 8.317 0 0 1-.788-.814l-.217-.253a8.56 8.56 0 0 1-.633-.882l-.237-.377a8.56 8.56 0 0 1-.51-.993l-.258-.592a8.873 8.873 0 0 1-.377-1.197l-.16-.664a8.873 8.873 0 0 1-.201-1.205l-.054-.556a8.588 8.588 0 0 1-.037-.842c0-.282.012-.562.037-.842l.054-.556c.045-.405.111-.809.201-1.205l.16-.664c.103-.407.229-.807.377-1.197l.258-.592c.137-.321.308-.654.51-.993l.237-.377c.189-.282.399-.6.633-.882l.217-.253c.248-.286.51-.558.788-.814l.193-.163c.313-.258.636-.5.983-.717l.151-.091c.348-.213.709-.392 1.086-.543l.101-.043c.452-.131.889-.305 1.339-.447l.052-.017a8.418 8.418 0 0 1 2.287-.334z"/>
          </svg>
        );
      case 'mysql':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zm6 12c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V12z"/>
          </svg>
        );
      case 'mongodb':
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93V14H9v-2h2V9.5C11 7.57 12.57 6 14.5 6H16v2h-1.5c-.83 0-1.5.67-1.5 1.5V12h3v2h-3v5.93c-3.95-.49-7-3.85-7-7.93s3.05-7.44 7-7.93V4.93C7.06 5.56 4 9.41 4 12c0 3.31 2.69 6 6 6v-.07z"/>
          </svg>
        );
      default:
        return (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4z"/>
          </svg>
        );
    }
  };

  const getQueryPlaceholder = () => {
    switch (dbType) {
      case 'postgresql':
        return 'Enter SQL query... (Ctrl/Cmd + Enter to execute)\n\nExamples:\nSELECT * FROM users LIMIT 10;\nINSERT INTO users (name, email) VALUES (\'John\', \'john@example.com\');\nCREATE TABLE products (id SERIAL PRIMARY KEY, name VARCHAR(100));';
      case 'mysql':
        return 'Enter SQL query... (Ctrl/Cmd + Enter to execute)\n\nExamples:\nSELECT * FROM users LIMIT 10;\nINSERT INTO users (name, email) VALUES (\'John\', \'john@example.com\');\nCREATE TABLE products (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100));';
      case 'mongodb':
        return 'Enter MongoDB command... (Ctrl/Cmd + Enter to execute)\n\nExamples:\ndb.users.find().limit(10)\ndb.users.insertOne({name: "John", email: "john@example.com"})\ndb.createCollection("products")';
      default:
        return 'Enter query...';
    }
  };

  if (loading) {
    return (
      <div className="database-page">
        <div className="database-page-loading">
          <div className="database-page-spinner" />
          <span>Connecting to {node.name}...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="database-page">
      {/* Header */}
      <div className="database-page-header">
        <button className="database-page-back" onClick={onBack}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          Back
        </button>
        <div className="database-page-title">
          {getDbIcon()}
          <div className="database-page-title-text">
            <span className="database-page-name">{node.name}</span>
            <span className="database-page-type">{dbType.toUpperCase()}</span>
          </div>
        </div>
        <div className="database-page-status">
          <span className={`status-dot status-${node.containerState}`} />
          <span>{node.containerState}</span>
        </div>
      </div>

      {error ? (
        <div className="database-page-error">
          <span className="error-icon">!</span>
          <span>{error}</span>
        </div>
      ) : (
        <div className="database-page-content">
          {/* Sidebar */}
          <div className="database-page-sidebar">
            <div className="sidebar-section">
              <div className="sidebar-section-header">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 3h18v18H3V3zm16 4H5v2h14V7zm0 4H5v2h14v-2zm0 4H5v2h14v-2z"/>
                </svg>
                <span>{dbType === 'mongodb' ? 'Collections' : 'Tables'}</span>
                <span className="sidebar-count">{tables.length}</span>
              </div>
              <div className="sidebar-list">
                {tables.map((table) => (
                  <button
                    key={table}
                    className={`sidebar-item ${selectedTable === table ? 'active' : ''}`}
                    onClick={() => {
                      loadTableData(table);
                      setActiveTab('tables');
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M3 3h18v18H3V3zm16 4H5v2h14V7zm0 4H5v2h14v-2zm0 4H5v2h14v-2z"/>
                    </svg>
                    <span>{table}</span>
                  </button>
                ))}
                {tables.length === 0 && (
                  <div className="sidebar-empty">No {dbType === 'mongodb' ? 'collections' : 'tables'} found</div>
                )}
              </div>
            </div>
          </div>

          {/* Main Content */}
          <div className="database-page-main">
            {/* Tabs */}
            <div className="database-page-tabs">
              <button
                className={`database-tab ${activeTab === 'tables' ? 'active' : ''}`}
                onClick={() => setActiveTab('tables')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M3 3h18v18H3V3zm16 4H5v2h14V7zm0 4H5v2h14v-2zm0 4H5v2h14v-2z"/>
                </svg>
                Data View
              </button>
              <button
                className={`database-tab ${activeTab === 'query' ? 'active' : ''}`}
                onClick={() => setActiveTab('query')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/>
                </svg>
                Query Editor
              </button>
            </div>

            {/* Tab Content */}
            {activeTab === 'tables' ? (
              <div className="database-table-view">
                {selectedTable ? (
                  <>
                    <div className="table-view-header">
                      <span className="table-view-name">{selectedTable}</span>
                      {tableData && !tableData.error && (
                        <span className="table-view-count">{tableData.rows.length} rows</span>
                      )}
                    </div>
                    {loadingTable ? (
                      <div className="table-view-loading">
                        <div className="database-page-spinner" />
                        <span>Loading data...</span>
                      </div>
                    ) : tableData?.error ? (
                      <div className="table-view-error">{tableData.error}</div>
                    ) : tableData && tableData.rows.length > 0 ? (
                      <div className="table-view-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              {tableData.columns.map((col) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {tableData.rows.map((row, idx) => (
                              <tr key={idx}>
                                {tableData.columns.map((col) => (
                                  <td key={col} title={formatCellValue(row[col])}>
                                    {formatCellValue(row[col])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="table-view-empty">No data in this {dbType === 'mongodb' ? 'collection' : 'table'}</div>
                    )}
                  </>
                ) : (
                  <div className="table-view-placeholder">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
                      <path d="M3 3h18v18H3V3zm16 4H5v2h14V7zm0 4H5v2h14v-2zm0 4H5v2h14v-2z"/>
                    </svg>
                    <span>Select a {dbType === 'mongodb' ? 'collection' : 'table'} to view data</span>
                  </div>
                )}
              </div>
            ) : (
              <div className="database-query-view">
                <div className="query-editor-container">
                  <textarea
                    ref={textareaRef}
                    className="query-editor"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder={getQueryPlaceholder()}
                    spellCheck={false}
                  />
                  <div className="query-editor-actions">
                    <span className="query-hint">Ctrl/Cmd + Enter to execute</span>
                    <button
                      className="query-execute-btn"
                      onClick={executeQuery}
                      disabled={executingQuery || !query.trim()}
                    >
                      {executingQuery ? (
                        <>
                          <div className="btn-spinner" />
                          Executing...
                        </>
                      ) : (
                        <>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z"/>
                          </svg>
                          Execute
                        </>
                      )}
                    </button>
                  </div>
                </div>

                <div className="query-result-container">
                  <div className="query-result-header">
                    <span>Results</span>
                    {queryResult && queryResult.rowCount !== undefined && (
                      <span className="query-result-count">{queryResult.rowCount} rows</span>
                    )}
                  </div>
                  <div className="query-result-content">
                    {queryResult?.error ? (
                      <div className="query-result-error">{queryResult.error}</div>
                    ) : queryResult?.rows && queryResult.rows.length > 0 ? (
                      <div className="query-result-table-container">
                        <table className="data-table">
                          <thead>
                            <tr>
                              {queryResult.columns?.map((col) => (
                                <th key={col}>{col}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {queryResult.rows.map((row, idx) => (
                              <tr key={idx}>
                                {queryResult.columns?.map((col) => (
                                  <td key={col} title={formatCellValue(row[col])}>
                                    {formatCellValue(row[col])}
                                  </td>
                                ))}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : queryResult?.output ? (
                      <pre className="query-result-output">{queryResult.output}</pre>
                    ) : (
                      <div className="query-result-empty">Execute a query to see results</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
