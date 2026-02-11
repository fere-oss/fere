import { useState } from 'react';
import type { GraphNode, ColumnDefinition } from '../types/electron';
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

export function DatabasePage({ node, onBack }: DatabasePageProps) {
  const [showMongoUri, setShowMongoUri] = useState(false);
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
    remoteMongoConnecting,
    setActiveTab,
    setShowCreateModal,
    setShowDeleteConfirm,
    setShowDeleteTableConfirm,
    setMongoUriInput,
    setQuery,
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
  } = useDatabasePage(node);

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

      {(dbType === 'mongodb' || node.containerImage?.toLowerCase().includes('mongo')) && (
        <div className="db-uri-connect-bar">
          <div className="db-uri-connect-label">
            <span>Mongo URI</span>
            {remoteMongoMode && <span className="db-uri-connect-badge">connected</span>}
          </div>
          <input
            className="db-uri-connect-input"
            type={showMongoUri ? 'text' : 'password'}
            placeholder="mongodb+srv://user:password@cluster.mongodb.net/dbname"
            value={mongoUriInput}
            onChange={(e) => setMongoUriInput(e.target.value)}
          />
          <button
            type="button"
            className="db-uri-visibility-btn"
            onClick={() => setShowMongoUri((prev) => !prev)}
            title={showMongoUri ? 'Hide URI' : 'Show URI'}
          >
            {showMongoUri ? 'Hide' : 'Show'}
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
        </div>
      )}

      {error ? (
        <DatabaseErrorState error={error} onRetry={() => window.location.reload()} />
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
