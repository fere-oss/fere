import type { GraphNode } from '../types/electron';
import { DatabasePage } from './DatabasePage';

interface DatabaseListViewProps {
  databaseNodes: GraphNode[];
  selectedNode: GraphNode | null;
  onSelectNode: (node: GraphNode | null) => void;
  remoteMongoLauncherNode: GraphNode;
}

function detectDbLabelFromNode(node: GraphNode): string {
  const image = (node.containerImage || '').toLowerCase();
  const name = (node.name || '').toLowerCase();
  if (image.includes('postgres') || name.includes('postgres')) return 'PostgreSQL';
  if (image.includes('mysql') || name.includes('mysql') || image.includes('mariadb')) return 'MySQL';
  if (image.includes('mongo') || name.includes('mongo')) return 'MongoDB';
  if (image.includes('redis') || name.includes('redis')) return 'Redis';
  if (image.includes('sqlite') || name.includes('sqlite')) return 'SQLite';
  if (node.id === '__remote_mongo_launcher__') return 'Remote URI';
  return 'Database';
}

export function DatabaseListView({
  databaseNodes,
  selectedNode,
  onSelectNode,
  remoteMongoLauncherNode,
}: DatabaseListViewProps) {
  const allNodes = [...databaseNodes, remoteMongoLauncherNode];

  const handleDatabasePageBack = () => {
    onSelectNode(null);
  };

  return (
    <div className="db-list-view">
      <aside className="db-list-sidebar">
        <div className="db-list-sidebar-header">
          <span className="db-sidebar-title">Databases</span>
          <span className="db-sidebar-count">{databaseNodes.length}</span>
        </div>
        <div className="db-list-sidebar-items">
          {allNodes.map((node) => (
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
          {databaseNodes.length === 0 && (
            <div className="db-list-empty">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3">
                <ellipse cx="12" cy="5" rx="7" ry="3" />
                <path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
                <path d="M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7" />
              </svg>
              <span>No database containers running</span>
            </div>
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
