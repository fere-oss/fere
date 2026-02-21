import { useState, useCallback } from 'react';
import type { GraphNode } from '../types/electron';
import { DatabasePage } from './DatabasePage';

interface SavedDatabaseConnection {
  id: string;
  uri: string;
  name: string;
  dbType: 'mongodb' | 'postgresql' | 'elasticsearch';
  createdAt: number;
}

interface DatabaseListViewProps {
  databaseNodes: GraphNode[];
  selectedNode: GraphNode | null;
  onSelectNode: (node: GraphNode | null) => void;
}

const SAVED_CONNECTIONS_KEY = 'fere.savedDatabaseConnections';

function detectDbLabelFromNode(node: GraphNode): string {
  const image = (node.containerImage || '').toLowerCase();
  const name = (node.name || '').toLowerCase();
  if (image.includes('postgres') || name.includes('postgres')) return 'PostgreSQL';
  if (image.includes('mysql') || name.includes('mysql') || image.includes('mariadb')) return 'MySQL';
  if (image.includes('mongo') || name.includes('mongo')) return 'MongoDB';
  if (image.includes('elasticsearch') || name.includes('elasticsearch') || image.includes('opensearch') || name.includes('opensearch')) return 'Elasticsearch';
  if (image.includes('redis') || name.includes('redis')) return 'Redis';
  if (image.includes('sqlite') || name.includes('sqlite')) return 'SQLite';
  return 'Database';
}

function detectUriDbType(uri: string): 'mongodb' | 'postgresql' | 'elasticsearch' | null {
  const lower = uri.trim().toLowerCase();
  if (lower.startsWith('mongodb://') || lower.startsWith('mongodb+srv://')) return 'mongodb';
  if (lower.startsWith('postgresql://') || lower.startsWith('postgres://')) return 'postgresql';
  if (lower.startsWith('http://') || lower.startsWith('https://')) return 'elasticsearch';
  return null;
}

function deriveNameFromUri(uri: string): string {
  try {
    const url = new URL(uri.trim());
    const host = url.hostname || 'unknown';
    if ((host === 'localhost' || host === '127.0.0.1') && url.port) {
      return `${host}:${url.port}`;
    }
    return host;
  } catch {
    return 'Remote Database';
  }
}

function savedConnectionToGraphNode(conn: SavedDatabaseConnection): GraphNode {
  const commandMap = { mongodb: 'remote-mongo', postgresql: 'remote-postgres', elasticsearch: 'remote-elasticsearch' };
  const imageMap = { mongodb: 'mongo:remote', postgresql: 'postgres:remote', elasticsearch: 'elasticsearch:remote' };
  return {
    id: `__saved_${conn.id}__`,
    pid: 0,
    name: conn.name,
    command: commandMap[conn.dbType] || 'remote-database',
    type: 'database',
    cpu: 0,
    memory: 0,
    user: 'remote',
    ports: [],
    healthStatus: 'green',
    lastSeen: conn.createdAt,
    isDockerContainer: false,
    containerImage: imageMap[conn.dbType] || 'database:remote',
    containerStatus: `saved-uri:${conn.uri}`,
  };
}

function loadSavedConnections(): SavedDatabaseConnection[] {
  try {
    const raw = window.localStorage.getItem(SAVED_CONNECTIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function DatabaseListView({
  databaseNodes,
  selectedNode,
  onSelectNode,
}: DatabaseListViewProps) {
  const [savedConnections, setSavedConnections] = useState<SavedDatabaseConnection[]>(loadSavedConnections);
  const [showAddForm, setShowAddForm] = useState(false);
  const [addUri, setAddUri] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [addConnecting, setAddConnecting] = useState(false);

  const persistConnections = useCallback((connections: SavedDatabaseConnection[]) => {
    setSavedConnections(connections);
    try {
      window.localStorage.setItem(SAVED_CONNECTIONS_KEY, JSON.stringify(connections));
    } catch { /* ignore */ }
  }, []);

  const handleAddConnection = useCallback(async () => {
    const trimmedUri = addUri.trim();
    if (!trimmedUri) {
      setAddError('Enter a database URI');
      return;
    }

    const dbType = detectUriDbType(trimmedUri);
    if (!dbType) {
      setAddError('URI must start with mongodb://, postgresql://, or http://');
      return;
    }

    if (savedConnections.some((c) => c.uri === trimmedUri)) {
      setAddError('This connection already exists');
      return;
    }

    setAddConnecting(true);
    setAddError(null);

    try {
      const result = dbType === 'mongodb'
        ? await window.electronAPI.connectMongoUri(trimmedUri)
        : dbType === 'elasticsearch'
          ? await window.electronAPI.connectElasticsearchUri(trimmedUri)
          : await window.electronAPI.connectPostgresUri(trimmedUri);

      if (result.error) {
        setAddError(result.error);
        return;
      }

      const newConnection: SavedDatabaseConnection = {
        id: crypto.randomUUID(),
        uri: trimmedUri,
        name: deriveNameFromUri(trimmedUri),
        dbType,
        createdAt: Date.now(),
      };

      const updated = [...savedConnections, newConnection];
      persistConnections(updated);

      setAddUri('');
      setShowAddForm(false);
      setAddError(null);

      onSelectNode(savedConnectionToGraphNode(newConnection));
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setAddConnecting(false);
    }
  }, [addUri, savedConnections, persistConnections, onSelectNode]);

  const handleDeleteConnection = useCallback((connectionId: string, event: React.MouseEvent) => {
    event.stopPropagation();
    const updated = savedConnections.filter((c) => c.id !== connectionId);
    persistConnections(updated);

    if (selectedNode?.id === `__saved_${connectionId}__`) {
      onSelectNode(null);
    }
  }, [savedConnections, persistConnections, selectedNode, onSelectNode]);

  const handleDatabasePageBack = () => {
    onSelectNode(null);
  };

  const totalCount = databaseNodes.length + savedConnections.length;

  return (
    <div className="db-list-view">
      <aside className="db-list-sidebar">
        <div className="db-list-sidebar-header">
          <span className="db-sidebar-title">Databases</span>
          <span className="db-sidebar-count">{totalCount}</span>
        </div>
        <div className="db-list-sidebar-items">
          {/* Docker containers */}
          {databaseNodes.map((node) => (
            <button
              key={node.id}
              className={`db-list-item ${selectedNode?.id === node.id ? 'active' : ''}`}
              onClick={() => onSelectNode(node)}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <ellipse cx="12" cy="5" rx="7" ry="3" />
                <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
              </svg>
              <div className="db-list-item-info">
                <span className="db-list-item-name">{node.name}</span>
                <span className="db-list-item-type">{detectDbLabelFromNode(node)}</span>
              </div>
              {node.containerState === 'running' && (
                <span className="db-list-item-status" />
              )}
            </button>
          ))}

          {/* Saved connections */}
          {savedConnections.map((conn) => {
            const syntheticId = `__saved_${conn.id}__`;
            return (
              <button
                key={syntheticId}
                className={`db-list-item ${selectedNode?.id === syntheticId ? 'active' : ''}`}
                onClick={() => onSelectNode(savedConnectionToGraphNode(conn))}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <ellipse cx="12" cy="5" rx="7" ry="3" />
                  <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                  <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
                </svg>
                <div className="db-list-item-info">
                  <span className="db-list-item-name">{conn.name}</span>
                  <span className="db-list-item-type">
                    {conn.dbType === 'mongodb' ? 'MongoDB' : conn.dbType === 'elasticsearch' ? 'Elasticsearch' : 'PostgreSQL'}
                  </span>
                </div>
                <button
                  className="db-list-item-delete"
                  onClick={(e) => handleDeleteConnection(conn.id, e)}
                  title="Remove connection"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </button>
            );
          })}

          {/* Empty state */}
          {databaseNodes.length === 0 && savedConnections.length === 0 && (
            <div className="db-list-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <ellipse cx="12" cy="5" rx="7" ry="3" />
                <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
              </svg>
              <span>No databases yet</span>
            </div>
          )}
        </div>

        {/* Add Connection footer */}
        <div className="db-list-sidebar-footer">
          {showAddForm ? (
            <div className="db-add-form">
              <input
                className="db-add-form-input"
                type="text"
                placeholder="mongodb://, postgresql://, or http://"
                value={addUri}
                onChange={(e) => { setAddUri(e.target.value); setAddError(null); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddConnection();
                  if (e.key === 'Escape') { setShowAddForm(false); setAddUri(''); setAddError(null); }
                }}
                autoFocus
              />
              {addError && <span className="db-add-form-error">{addError}</span>}
              <div className="db-add-form-actions">
                <button
                  className="db-add-form-cancel"
                  onClick={() => { setShowAddForm(false); setAddUri(''); setAddError(null); }}
                >
                  Cancel
                </button>
                <button
                  className="db-add-form-connect"
                  onClick={handleAddConnection}
                  disabled={addConnecting || !addUri.trim()}
                >
                  {addConnecting ? 'Connecting...' : 'Connect'}
                </button>
              </div>
            </div>
          ) : (
            <button
              className="db-add-connection-btn"
              onClick={() => setShowAddForm(true)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              Add Connection
            </button>
          )}
        </div>
      </aside>

      <div className="db-list-main">
        {selectedNode ? (
          <DatabasePage node={selectedNode} onBack={handleDatabasePageBack} />
        ) : (
          <div className="db-list-no-selection">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" opacity="0.2">
              <ellipse cx="12" cy="5" rx="7" ry="3" />
              <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
              <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
            </svg>
            <span className="db-no-selection-title">Select a database</span>
            <span className="db-no-selection-subtitle">Choose from the sidebar to browse data</span>
          </div>
        )}
      </div>
    </div>
  );
}
