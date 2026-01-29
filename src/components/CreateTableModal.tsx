import { useState, useCallback } from 'react';
import type { ColumnDefinition } from '../types/electron';

interface CreateTableModalProps {
  dbType: 'postgresql' | 'mysql' | 'mongodb';
  onClose: () => void;
  onSubmit: (tableName: string, columns: ColumnDefinition[]) => Promise<void>;
}

const COLUMN_TYPES = {
  postgresql: [
    'SERIAL',
    'INTEGER',
    'BIGINT',
    'SMALLINT',
    'DECIMAL',
    'NUMERIC',
    'REAL',
    'DOUBLE PRECISION',
    'VARCHAR(255)',
    'TEXT',
    'CHAR(10)',
    'BOOLEAN',
    'DATE',
    'TIMESTAMP',
    'TIME',
    'JSON',
    'JSONB',
    'UUID',
  ],
  mysql: [
    'INT AUTO_INCREMENT',
    'INT',
    'BIGINT',
    'SMALLINT',
    'TINYINT',
    'DECIMAL(10,2)',
    'FLOAT',
    'DOUBLE',
    'VARCHAR(255)',
    'TEXT',
    'CHAR(10)',
    'BOOLEAN',
    'DATE',
    'DATETIME',
    'TIMESTAMP',
    'TIME',
    'JSON',
    'ENUM',
  ],
  mongodb: [
    'String',
    'Number',
    'Boolean',
    'Date',
    'ObjectId',
    'Array',
    'Object',
    'Mixed',
  ],
};

export function CreateTableModal({ dbType, onClose, onSubmit }: CreateTableModalProps) {
  const [tableName, setTableName] = useState('');
  const [columns, setColumns] = useState<ColumnDefinition[]>([
    { name: 'id', type: dbType === 'postgresql' ? 'SERIAL' : 'INT AUTO_INCREMENT', primaryKey: true, notNull: true },
  ]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addColumn = useCallback(() => {
    setColumns([...columns, { name: '', type: COLUMN_TYPES[dbType][0], notNull: false }]);
  }, [columns, dbType]);

  const removeColumn = useCallback((index: number) => {
    setColumns(columns.filter((_, i) => i !== index));
  }, [columns]);

  const updateColumn = useCallback((index: number, field: keyof ColumnDefinition, value: any) => {
    const updated = [...columns];
    updated[index] = { ...updated[index], [field]: value };
    setColumns(updated);
  }, [columns]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validation
    if (!tableName.trim()) {
      setError('Table name is required');
      return;
    }

    if (columns.length === 0) {
      setError('At least one column is required');
      return;
    }

    if (columns.some(col => !col.name.trim())) {
      setError('All columns must have a name');
      return;
    }

    // Check for duplicate column names
    const columnNames = columns.map(col => col.name.toLowerCase().trim());
    if (new Set(columnNames).size !== columnNames.length) {
      setError('Column names must be unique');
      return;
    }

    try {
      setCreating(true);
      await onSubmit(tableName.trim(), columns);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create table');
    } finally {
      setCreating(false);
    }
  };

  const getTypeLabel = () => {
    switch (dbType) {
      case 'mongodb': return 'Collection';
      default: return 'Table';
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content create-table-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Create New {getTypeLabel()}</h2>
          <button className="modal-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/>
              <line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="modal-body">
          {error && (
            <div className="modal-error">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <span>{error}</span>
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="tableName">
              {getTypeLabel()} Name
            </label>
            <input
              id="tableName"
              type="text"
              className="form-input"
              value={tableName}
              onChange={(e) => setTableName(e.target.value)}
              placeholder={`Enter ${getTypeLabel().toLowerCase()} name`}
              autoFocus
              disabled={creating}
            />
          </div>

          {dbType !== 'mongodb' && (
            <>
              <div className="form-group">
                <div className="columns-header">
                  <label className="form-label">Columns</label>
                  <button
                    type="button"
                    className="add-column-btn"
                    onClick={addColumn}
                    disabled={creating}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/>
                      <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Add Column
                  </button>
                </div>
              </div>

              <div className="columns-list">
                {columns.map((column, index) => (
                  <div key={index} className="column-item">
                    <div className="column-item-header">
                      <span className="column-number">{index + 1}</span>
                      {columns.length > 1 && (
                        <button
                          type="button"
                          className="remove-column-btn"
                          onClick={() => removeColumn(index)}
                          disabled={creating}
                          title="Remove column"
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                        </button>
                      )}
                    </div>

                    <div className="column-fields">
                      <div className="column-field">
                        <label className="field-label">Name</label>
                        <input
                          type="text"
                          className="field-input"
                          value={column.name}
                          onChange={(e) => updateColumn(index, 'name', e.target.value)}
                          placeholder="column_name"
                          disabled={creating}
                        />
                      </div>

                      <div className="column-field">
                        <label className="field-label">Type</label>
                        <select
                          className="field-select"
                          value={column.type}
                          onChange={(e) => updateColumn(index, 'type', e.target.value)}
                          disabled={creating}
                        >
                          {COLUMN_TYPES[dbType].map(type => (
                            <option key={type} value={type}>{type}</option>
                          ))}
                        </select>
                      </div>

                      <div className="column-field">
                        <label className="field-label">Default</label>
                        <input
                          type="text"
                          className="field-input"
                          value={column.defaultValue || ''}
                          onChange={(e) => updateColumn(index, 'defaultValue', e.target.value)}
                          placeholder="(optional)"
                          disabled={creating}
                        />
                      </div>
                    </div>

                    <div className="column-constraints">
                      <label className="constraint-checkbox">
                        <input
                          type="checkbox"
                          checked={column.primaryKey || false}
                          onChange={(e) => updateColumn(index, 'primaryKey', e.target.checked)}
                          disabled={creating}
                        />
                        <span>Primary Key</span>
                      </label>

                      <label className="constraint-checkbox">
                        <input
                          type="checkbox"
                          checked={column.notNull || false}
                          onChange={(e) => updateColumn(index, 'notNull', e.target.checked)}
                          disabled={creating || column.primaryKey}
                        />
                        <span>NOT NULL</span>
                      </label>

                      <label className="constraint-checkbox">
                        <input
                          type="checkbox"
                          checked={column.unique || false}
                          onChange={(e) => updateColumn(index, 'unique', e.target.checked)}
                          disabled={creating || column.primaryKey}
                        />
                        <span>UNIQUE</span>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {dbType === 'mongodb' && (
            <div className="mongodb-note">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
              </svg>
              <span>MongoDB collections are schemaless. Documents can have any structure.</span>
            </div>
          )}

          <div className="modal-actions">
            <button
              type="button"
              className="modal-btn modal-btn-secondary"
              onClick={onClose}
              disabled={creating}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="modal-btn modal-btn-primary"
              disabled={creating || !tableName.trim()}
            >
              {creating ? (
                <>
                  <div className="btn-spinner" />
                  Creating...
                </>
              ) : (
                `Create ${getTypeLabel()}`
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
