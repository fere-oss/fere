import { useState, useEffect, useCallback, useRef } from 'react';
import type { DatabaseTablesResult, TableDataResult } from '../types/electron';

interface DatabaseViewerProps {
  containerId: string;
  containerImage: string;
}

export function DatabaseViewer({ containerId, containerImage }: DatabaseViewerProps) {
  const [tables, setTables] = useState<string[]>([]);
  const [dbType, setDbType] = useState<string | null>(null);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableData, setTableData] = useState<TableDataResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingData, setLoadingData] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tableDataRequestIdRef = useRef(0);

  // Load tables on mount
  useEffect(() => {
    let cancelled = false;

    const loadTables = async () => {
      if (!window.electronAPI?.getDatabaseTables) {
        if (!cancelled) {
          setError('Database queries not available');
          setLoading(false);
        }
        return;
      }

      try {
        setLoading(true);
        setError(null);
        setSelectedTable(null);
        setTableData(null);
        const result: DatabaseTablesResult = await window.electronAPI.getDatabaseTables(containerId, containerImage);
        if (cancelled) return;

        if (result.error) {
          setError(result.error);
          setTables([]);
          setDbType(null);
        } else {
          setTables(result.tables);
          setDbType(result.dbType || null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load tables');
          setTables([]);
          setDbType(null);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    loadTables();
    return () => {
      cancelled = true;
      tableDataRequestIdRef.current += 1;
    };
  }, [containerId, containerImage]);

  // Load table data when a table is selected
  const loadTableData = useCallback(async (tableName: string) => {
    if (!window.electronAPI?.getTableData) return;
    const requestId = ++tableDataRequestIdRef.current;

    try {
      setLoadingData(true);
      setSelectedTable(tableName);
      setTableData(null);

      const result: TableDataResult = await window.electronAPI.getTableData(
        containerId,
        containerImage,
        tableName,
        100
      );
      if (requestId !== tableDataRequestIdRef.current) return;

      if (result.error) {
        setTableData({ columns: [], rows: [], error: result.error });
      } else {
        setTableData(result);
      }
    } catch (err) {
      if (requestId !== tableDataRequestIdRef.current) return;
      setTableData({
        columns: [],
        rows: [],
        error: err instanceof Error ? err.message : 'Failed to load data',
      });
    } finally {
      if (requestId === tableDataRequestIdRef.current) {
        setLoadingData(false);
      }
    }
  }, [containerId, containerImage]);

  const getDbIcon = () => {
    switch (dbType) {
      case 'postgresql':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
          </svg>
        );
      case 'mysql':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4zm0 2c3.87 0 6 1.5 6 2s-2.13 2-6 2-6-1.5-6-2 2.13-2 6-2zm6 12c0 .5-2.13 2-6 2s-6-1.5-6-2v-2.23c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V17zm0-5c0 .5-2.13 2-6 2s-6-1.5-6-2V9.77c1.61.78 3.72 1.23 6 1.23s4.39-.45 6-1.23V12z"/>
          </svg>
        );
      case 'mongodb':
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3zm-1.06 13.54L7.4 12l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41-5.64 5.66z"/>
          </svg>
        );
      default:
        return (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 3C7.58 3 4 4.79 4 7v10c0 2.21 3.58 4 8 4s8-1.79 8-4V7c0-2.21-3.58-4-8-4z"/>
          </svg>
        );
    }
  };

  const formatCellValue = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  if (loading) {
    return (
      <div className="database-viewer">
        <div className="database-viewer-loading">
          <div className="database-viewer-spinner" />
          <span>Connecting to database...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="database-viewer">
        <div className="database-viewer-error">
          <span className="database-viewer-error-icon">!</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (tables.length === 0) {
    return (
      <div className="database-viewer">
        <div className="database-viewer-empty">
          No tables found in database
        </div>
      </div>
    );
  }

  return (
    <div className="database-viewer">
      <div className="database-viewer-header">
        {getDbIcon()}
        <span className="database-viewer-title">
          {dbType === 'mongodb' ? 'Collections' : 'Tables'}
        </span>
        <span className="database-viewer-count">{tables.length}</span>
      </div>

      <div className="database-viewer-tables">
        {tables.map((table) => (
          <button
            key={table}
            className={`database-viewer-table-btn ${selectedTable === table ? 'active' : ''}`}
            onClick={() => loadTableData(table)}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="table-icon">
              <path d="M3 3h18v18H3V3zm16 4H5v2h14V7zm0 4H5v2h14v-2zm0 4H5v2h14v-2z"/>
            </svg>
            <span className="table-name">{table}</span>
          </button>
        ))}
      </div>

      {selectedTable && (
        <div className="database-viewer-data">
          <div className="database-viewer-data-header">
            <span className="data-table-name">{selectedTable}</span>
            {tableData && !tableData.error && (
              <span className="data-row-count">
                {tableData.rows.length >= 100
                  ? 'First 100 rows (limit applied)'
                  : `${tableData.rows.length} rows`}
              </span>
            )}
          </div>

          {loadingData ? (
            <div className="database-viewer-loading">
              <div className="database-viewer-spinner" />
              <span>Loading data...</span>
            </div>
          ) : tableData?.error ? (
            <div className="database-viewer-error">
              <span className="database-viewer-error-icon">!</span>
              <span>{tableData.error}</span>
            </div>
          ) : tableData && tableData.rows.length > 0 ? (
            <div className="database-viewer-table-container">
              <table className="database-viewer-table">
                <thead>
                  <tr>
                    {tableData.columns.map((col, colIdx) => (
                      <th key={`${colIdx}-${col}`}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {tableData.rows.map((row, rowIdx) => (
                    <tr key={`row-${rowIdx}-${formatCellValue(row[tableData.columns[0]])}`}>
                      {tableData.columns.map((col, colIdx) => (
                        <td key={`${colIdx}-${col}`} title={formatCellValue(row[col])}>
                          {formatCellValue(row[col])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="database-viewer-empty">
              No data in this {dbType === 'mongodb' ? 'collection' : 'table'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
