import { useEffect, useMemo, useRef, useState } from 'react';
import type { GraphNode } from '../types/electron';
import { CreateTableModal } from './CreateTableModal';
import { DatabaseHeader } from './database/DatabaseHeader';
import { DatabaseErrorState } from './database/DatabaseErrorState';
import { DatabaseDataLayout } from './database/DatabaseDataLayout';
import { DatabaseQueryLayout } from './database/DatabaseQueryLayout';
import { DeleteConfirmDialog } from './database/DeleteConfirmDialog';
import { DeleteTableConfirmDialog } from './database/DeleteTableConfirmDialog';
import { useDatabasePage } from './database/useDatabasePage';

interface DatabasePageProps {
  node: GraphNode;
  onBack: () => void;
}

interface UriPickerProps {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

function UriPicker({ label, value, options, onChange }: UriPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

  const selectedLabel = value || (options[0] ?? '—');

  return (
    <div className="db-uri-picker" ref={containerRef}>
      <span className="db-uri-picker-label">{label}</span>
      <button
        type="button"
        className="db-uri-picker-trigger"
        onClick={() => setOpen((prev) => !prev)}
        disabled={options.length === 0}
      >
        <span className="db-uri-picker-trigger-value">{selectedLabel}</span>
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M3.5 6l4.5 4 4.5-4" />
        </svg>
      </button>
      {open && options.length > 0 && (
        <div className="db-uri-picker-menu">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={`db-uri-picker-option ${option === value ? 'selected' : ''}`}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function DatabasePage({ node, onBack }: DatabasePageProps) {
  const [showMongoUri, setShowMongoUri] = useState(false);
  const [showUriSuggestions, setShowUriSuggestions] = useState(false);
  const uriInputRef = useRef<HTMLDivElement | null>(null);
  const {
    tables,
    dbType,
    selectedTable,
    tableData,
    query,
    queryResult,
    loading,
    loadingTable,
    executingQuery,
    error,
    activeTab,
    showCreateModal,
    deletingRow,
    showDeleteConfirm,
    deletingTable,
    showDeleteTableConfirm,
    mongoUriInput,
    remoteMongoMode,
    remoteUriDbType,
    remoteMongoConnecting,
    mongoUriStatus,
    mongoUriStatusMessage,
    recentMongoUris,
    remoteDbOptions,
    remoteCollectionOptions,
    selectedRemoteDb,
    selectedRemoteCollection,
    setActiveTab,
    setShowCreateModal,
    setShowDeleteConfirm,
    setShowDeleteTableConfirm,
    setMongoUriInput,
    setSelectedRemoteDb,
    setSelectedRemoteCollection,
    setQuery,
    testMongoUriConnection,
    connectMongoUriMode,
    disconnectMongoUriMode,
    loadTableData,
    executeQuery,
    handleKeyDown,
    handleCreateTable,
    handleDeleteTable,
    handleDeleteRow,
    formatCellValue,
    getDbTypeLabel,
    getQueryPlaceholder,
    actionError,
    clearActionError,
    refreshTables,
  } = useDatabasePage(node);

  const filteredRecentUris = useMemo(() => {
    const query = mongoUriInput.trim().toLowerCase();
    if (!query) return recentMongoUris.slice(0, 6);
    return recentMongoUris
      .filter((entry) => entry.toLowerCase().includes(query))
      .slice(0, 6);
  }, [mongoUriInput, recentMongoUris]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (!uriInputRef.current) return;
      if (!uriInputRef.current.contains(event.target as Node)) {
        setShowUriSuggestions(false);
      }
    };
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, []);

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
      <DatabaseHeader
        node={node}
        dbTypeLabel={getDbTypeLabel()}
        activeTab={activeTab}
        onBack={onBack}
        onTabChange={setActiveTab}
      />

      {(dbType === 'mongodb'
        || dbType === 'postgresql'
        || node.containerImage?.toLowerCase().includes('mongo')
        || node.containerImage?.toLowerCase().includes('postgres')) && (
        <div className="db-uri-connect-bar">
          <div className="db-uri-connect-label">
            <span>Database URI</span>
            {remoteMongoMode && (
              <span className="db-uri-connect-badge">
                {remoteUriDbType === 'postgresql' ? 'postgres connected' : 'mongo connected'}
              </span>
            )}
          </div>
          <div className="db-uri-connect-input-wrap" ref={uriInputRef}>
            <input
              className="db-uri-connect-input"
              type={showMongoUri ? 'text' : 'password'}
              placeholder="mongodb+srv://... or postgresql://..."
              value={mongoUriInput}
              onFocus={() => setShowUriSuggestions(filteredRecentUris.length > 0)}
              onChange={(e) => {
                setMongoUriInput(e.target.value);
                setShowUriSuggestions(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setShowUriSuggestions(false);
                }
              }}
            />
            {showUriSuggestions && filteredRecentUris.length > 0 && (
              <div className="db-uri-suggest-menu">
                {filteredRecentUris.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    className={`db-uri-suggest-option ${entry === mongoUriInput ? 'selected' : ''}`}
                    onClick={() => {
                      setMongoUriInput(entry);
                      setShowUriSuggestions(false);
                    }}
                  >
                    {entry}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="db-uri-visibility-btn"
            onClick={() => setShowMongoUri((prev) => !prev)}
            title={showMongoUri ? 'Hide URI' : 'Show URI'}
          >
            {showMongoUri ? 'Hide' : 'Show'}
          </button>
          <button
            className="db-uri-connect-btn secondary"
            onClick={testMongoUriConnection}
            disabled={remoteMongoConnecting || !mongoUriInput.trim()}
          >
            Test
          </button>
          {remoteMongoMode ? (
            <button className="db-uri-connect-btn secondary" onClick={disconnectMongoUriMode}>
              Disconnect
            </button>
          ) : (
            <button
              className="db-uri-connect-btn"
              onClick={connectMongoUriMode}
              disabled={remoteMongoConnecting || !mongoUriInput.trim()}
            >
              {remoteMongoConnecting ? 'Connecting...' : 'Connect URI'}
            </button>
          )}
          <span className={`db-uri-status db-uri-status-${mongoUriStatus}`}>
            {mongoUriStatusMessage || (mongoUriStatus === 'idle' ? 'Not tested' : '')}
          </span>
        </div>
      )}

      {remoteMongoMode && remoteUriDbType === 'mongodb' && remoteDbOptions.length > 0 && (
        <div className="db-uri-picker-row">
          <UriPicker
            label="Database"
            value={selectedRemoteDb}
            options={remoteDbOptions}
            onChange={setSelectedRemoteDb}
          />
          <UriPicker
            label="Collection"
            value={selectedRemoteCollection}
            options={remoteCollectionOptions}
            onChange={setSelectedRemoteCollection}
          />
        </div>
      )}

      {actionError && (
        <div className="db-action-error">
          <span>{actionError}</span>
          <button onClick={clearActionError}>&times;</button>
        </div>
      )}

      {error ? (
        <DatabaseErrorState error={error} onRetry={refreshTables} />
      ) : (
        <div className="db-content">
          {activeTab === 'data' ? (
            <DatabaseDataLayout
              dbType={dbType}
              tables={tables}
              selectedTable={selectedTable}
              tableData={tableData}
              loadingTable={loadingTable}
              deletingRow={deletingRow}
              deletingTable={deletingTable}
              onSelectTable={loadTableData}
              onRefreshTable={() => selectedTable && loadTableData(selectedTable)}
              onCreateTable={() => setShowCreateModal(true)}
              onDeleteTable={() => setShowDeleteTableConfirm(true)}
              onDeleteRowRequest={(rowIndex, row) => setShowDeleteConfirm({ rowIndex, row })}
              formatCellValue={formatCellValue}
            />
          ) : (
            <DatabaseQueryLayout
              dbType={dbType}
              query={query}
              queryResult={queryResult}
              executingQuery={executingQuery}
              onChangeQuery={setQuery}
              onExecuteQuery={executeQuery}
              onKeyDown={handleKeyDown}
              getQueryPlaceholder={getQueryPlaceholder}
              formatCellValue={formatCellValue}
            />
          )}
        </div>
      )}

      {showDeleteConfirm && (
        <DeleteConfirmDialog
          selectedTable={selectedTable}
          tableData={tableData}
          deletingRow={deletingRow}
          rowIndex={showDeleteConfirm.rowIndex}
          row={showDeleteConfirm.row}
          onCancel={() => setShowDeleteConfirm(null)}
          onConfirm={() => handleDeleteRow(showDeleteConfirm.rowIndex, showDeleteConfirm.row)}
          formatCellValue={formatCellValue}
        />
      )}

      {showDeleteTableConfirm && selectedTable && (
        <DeleteTableConfirmDialog
          tableName={selectedTable}
          dbType={dbType}
          deletingTable={deletingTable}
          onCancel={() => setShowDeleteTableConfirm(false)}
          onConfirm={handleDeleteTable}
        />
      )}

      {showCreateModal && (dbType === 'postgresql' || dbType === 'mysql' || dbType === 'mongodb') && (
        <CreateTableModal
          dbType={dbType}
          onClose={() => setShowCreateModal(false)}
          onSubmit={handleCreateTable}
        />
      )}
    </div>
  );
}
