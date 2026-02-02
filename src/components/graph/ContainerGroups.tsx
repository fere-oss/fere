import type { GraphNode } from '../../types/electron';
import type { ContainerProject, RenderGroup } from './types';
import { getHealthInfo, getTypeBadge } from './constants';

export function ProjectContainer({
  project,
  onNodeClick,
  onContextMenu,
  animationDelay = 0,
}: {
  project: ContainerProject;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationDelay?: number;
}) {
  return (
    <div className="docker-project-view">
      {project.typeGroups.map((group, groupIdx) => (
        <ContainerGroup
          key={`${project.projectName}-${group.groupType || group.groupName}`}
          group={group}
          onNodeClick={onNodeClick}
          onContextMenu={onContextMenu}
          animationDelay={animationDelay + groupIdx * 100}
        />
      ))}
    </div>
  );
}

function ContainerGroup({
  group,
  onNodeClick,
  onContextMenu,
  animationDelay = 0,
}: {
  group: RenderGroup;
  onNodeClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationDelay?: number;
}) {
  const nodeCount = group.nodes.length;
  const columnCount = Math.max(2, Math.ceil(Math.sqrt(nodeCount)));

  // Single node - no group wrapper
  if (nodeCount === 1) {
    return (
      <ContainerCard
        node={group.nodes[0]}
        onClick={onNodeClick}
        onContextMenu={onContextMenu}
        animationIndex={0}
      />
    );
  }

  return (
    <div
      className="container-group"
      style={{
        '--group-columns': columnCount,
        animationDelay: `${animationDelay}ms`,
      } as React.CSSProperties}
    >
      <div className="container-group-label">{group.groupName.toUpperCase()}</div>
      <div className="container-group-nodes">
        {group.nodes.map((node, idx) => (
          <ContainerCard
            key={node.id}
            node={node}
            onClick={onNodeClick}
            onContextMenu={onContextMenu}
            animationIndex={idx}
          />
        ))}
      </div>
    </div>
  );
}

function ContainerCard({
  node,
  onClick,
  onContextMenu,
  animationIndex = 0,
}: {
  node: GraphNode;
  onClick: (node: GraphNode) => void;
  onContextMenu: (e: React.MouseEvent, node: GraphNode) => void;
  animationIndex?: number;
}) {
  const healthInfo = getHealthInfo(node.healthStatus);
  const mainPort = node.ports[0]?.port;

  // Parse image name and tag
  const imageParts = node.containerImage?.split('/').pop()?.split(':') || [];
  const imageName = imageParts[0] || '';
  const imageTag = imageParts[1] || 'latest';

  // Get short container ID (first 12 chars)
  const shortId = node.id?.slice(0, 12) || '';

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick(node);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, node);
  };

  return (
    <div
      data-node-id={node.id}
      className="container-card"
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      style={{
        animationDelay: `${animationIndex * 50}ms`,
      } as React.CSSProperties}
    >
      {/* Header with status and badge */}
      <div className="container-card-header">
        <div className="container-card-status">
          <svg className="container-card-docker-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M13.983 11.078h2.119a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.119a.185.185 0 00-.185.185v1.888c0 .102.083.185.185.185m-2.954-5.43h2.118a.186.186 0 00.186-.186V3.574a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.186m0 2.716h2.118a.187.187 0 00.186-.186V6.29a.186.186 0 00-.186-.185h-2.118a.185.185 0 00-.185.185v1.887c0 .102.082.185.185.186m-2.93 0h2.12a.186.186 0 00.184-.186V6.29a.185.185 0 00-.185-.185H8.1a.185.185 0 00-.185.185v1.887c0 .102.083.185.185.186m-2.964 0h2.119a.186.186 0 00.185-.186V6.29a.185.185 0 00-.185-.185H5.136a.186.186 0 00-.186.185v1.887c0 .102.084.185.186.186m5.893 2.715h2.118a.186.186 0 00.186-.185V9.006a.186.186 0 00-.186-.186h-2.118a.185.185 0 00-.185.185v1.888c0 .102.082.185.185.185m-2.93 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185m-2.964 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.119a.185.185 0 00-.186.185v1.888c0 .102.084.185.186.185m-2.92 0h2.12a.185.185 0 00.184-.185V9.006a.185.185 0 00-.184-.186h-2.12a.186.186 0 00-.186.186v1.887c0 .102.084.185.186.185m-2.929 0h2.119a.185.185 0 00.185-.185V9.006a.186.186 0 00-.185-.186h-2.12a.185.185 0 00-.184.185v1.888c0 .102.083.185.185.185M23.763 9.89c-.065-.051-.672-.51-1.954-.51-.338.001-.676.03-1.01.087-.248-1.7-1.653-2.53-1.716-2.566l-.344-.199-.226.327c-.284.438-.49.922-.612 1.43-.23.97-.09 1.882.403 2.661-.595.332-1.55.413-1.744.42H.751a.751.751 0 00-.75.748 11.376 11.376 0 00.692 4.062c.545 1.428 1.355 2.48 2.41 3.124 1.18.723 3.1 1.137 5.275 1.137.983.003 1.963-.086 2.93-.266a12.248 12.248 0 003.823-1.389c.98-.567 1.86-1.288 2.61-2.136 1.252-1.418 1.998-2.997 2.553-4.4h.221c1.372 0 2.215-.549 2.68-1.009.309-.293.55-.65.707-1.046l.098-.288Z"/>
          </svg>
          <div
            className="container-card-health-dot"
            style={{
              backgroundColor: healthInfo.color,
              boxShadow: healthInfo.glow,
            }}
          />
          <span
            className="container-card-health-label"
            style={{ color: healthInfo.color }}
          >
            {healthInfo.label}
          </span>
        </div>
        <span className="container-card-badge">
          {getTypeBadge(node.type)}
        </span>
      </div>

      {/* Name */}
      <h3 className="container-card-name">{node.name}</h3>

      {/* Image with tag */}
      {node.containerImage && (
        <div className="container-card-image">
          <span className="container-card-image-name">{imageName}</span>
          <span className="container-card-image-tag">{imageTag}</span>
        </div>
      )}

      {/* Port */}
      <div className="container-card-port">
        <span className="container-card-port-host">localhost</span>
        <span className="container-card-port-number">:{mainPort || '?'}</span>
      </div>

      {/* Container ID */}
      {shortId && (
        <div className="container-card-id" title={node.id}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M7 7h.01M7 12h.01M7 17h.01M12 7h5M12 12h5M12 17h5"/>
          </svg>
          <span>{shortId}</span>
        </div>
      )}

      {/* Networks section */}
      {node.containerNetworks && node.containerNetworks.length > 0 && (
        <div className="container-card-section">
          <div className="container-card-section-header">
            <span className="container-card-section-title">NETWORKS</span>
            <span className="container-card-section-count">{node.containerNetworks.length}</span>
          </div>
          <div className="container-card-section-content">
            {node.containerNetworks.slice(0, 2).map(n => n.name).join(', ')}
            {node.containerNetworks.length > 2 && ` +${node.containerNetworks.length - 2}`}
          </div>
        </div>
      )}
    </div>
  );
}

// Export for backwards compatibility
export { ContainerGroup as TypeGroupBox };
