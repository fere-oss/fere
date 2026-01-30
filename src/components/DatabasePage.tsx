import type { GraphNode, ColumnDefinition } from '../types/electron';
import { CreateTableModal } from './CreateTableModal';
import { DatabaseHeader } from './database/DatabaseHeader';
import { DatabaseErrorState } from './database/DatabaseErrorState';
import { DatabaseDataLayout } from './database/DatabaseDataLayout';
import { DatabaseQueryLayout } from './database/DatabaseQueryLayout';
import { DeleteConfirmDialog } from './database/DeleteConfirmDialog';
import { useDatabasePage } from './database/useDatabasePage';

interface DatabasePageProps {
  node: GraphNode;
  onBack: () => void;
}

export function DatabasePage({ node, onBack }: DatabasePageProps) {
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
    textareaRef,
    setActiveTab,
    setShowCreateModal,
    setShowDeleteConfirm,
    setQuery,
    loadTableData,
    executeQuery,
    handleKeyDown,
    handleCreateTable,
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
              onSelectTable={loadTableData}
              onRefreshTable={() => selectedTable && loadTableData(selectedTable)}
              onCreateTable={() => setShowCreateModal(true)}
              onDeleteRowRequest={(rowIndex, row) => setShowDeleteConfirm({ rowIndex, row })}
              formatCellValue={formatCellValue}
            />
          ) : (
            <DatabaseQueryLayout
              query={query}
              queryResult={queryResult}
              executingQuery={executingQuery}
              onChangeQuery={setQuery}
              onExecuteQuery={executeQuery}
              onKeyDown={handleKeyDown}
              getQueryPlaceholder={getQueryPlaceholder}
              formatCellValue={formatCellValue}
              textareaRef={textareaRef}
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
